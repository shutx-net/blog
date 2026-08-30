import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface CdkJson {
  app?: string;
  context?: Record<string, unknown>;
}

interface TsConfig {
  compilerOptions?: Record<string, unknown>;
}

/** 完全固定バージョン。^ ~ >= x * のいずれも許さない。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** クロススタック参照の強さ。既定任せにせず cdk.json に明示させる。 */
const CROSS_STACK_REFERENCES = '@aws-cdk/core:defaultCrossStackReferences';

const readJson = <T>(relative: string): T => {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

const infraPkg = (): PackageJson => readJson<PackageJson>('../package.json');
const rootPkg = (): PackageJson => readJson<PackageJson>('../../package.json');

describe('infra ワークスペースの CDK バージョン固定', () => {
  it('devDependencies.aws-cdk-lib が完全固定の "2.267.0" である', () => {
    const pkg = infraPkg();
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies?.['aws-cdk-lib']).toBe('2.267.0');
    expect(pkg.devDependencies?.['aws-cdk-lib']).toMatch(EXACT_VERSION);
  });

  it('devDependencies.aws-cdk が完全固定の "2.1139.0" で、dependencies 側には存在しない', () => {
    const pkg = infraPkg();
    expect(pkg.devDependencies?.['aws-cdk']).toBe('2.1139.0');
    expect(pkg.devDependencies?.['aws-cdk']).toMatch(EXACT_VERSION);
    expect(pkg.dependencies?.['aws-cdk']).toBeUndefined();
    expect(pkg.dependencies?.['aws-cdk-lib']).toBeUndefined();
  });

  it('aws-cdk-lib と aws-cdk が両方 devDependencies にあり、片方だけずらせない', () => {
    const pkg = infraPkg();
    const dev = pkg.devDependencies ?? {};
    expect(Object.keys(dev)).toEqual(expect.arrayContaining(['aws-cdk-lib', 'aws-cdk']));
    for (const name of ['aws-cdk-lib', 'aws-cdk']) {
      expect(dev[name], `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(EXACT_VERSION);
    }
  });

  it('infra/package.json の "type" が "module" である', () => {
    expect(infraPkg().type).toBe('module');
  });
});

describe('npm workspaces のルート', () => {
  it('workspaces 配列に "infra" が含まれる', () => {
    const root = rootPkg();
    expect(Array.isArray(root.workspaces)).toBe(true);
    expect(root.workspaces).toContain('infra');
  });

  it('workspaces 配列に "api" が含まれる', () => {
    // infra の synth は api/dist のバンドルをアセットとして読む。api がワークスペースで
    // なくなると pretest の `npm run build -w ../api` が 'No workspaces found' で落ちる。
    // api 側（api/test/unit/toolchain.test.ts）からも同じことを主張している。**両方から
    // 見るのは意図的**で、片方だけだと片方を消したときに気づけない。
    const root = rootPkg();
    expect(Array.isArray(root.workspaces)).toBe(true);
    expect(root.workspaces).toContain('api');
  });

  it('private: true である（誤って publish しないため）', () => {
    expect(rootPkg().private).toBe(true);
  });
});

describe('cdk.json の context', () => {
  it(`${CROSS_STACK_REFERENCES} が明示されている`, () => {
    // 未設定だと CDK が「No cross-stack-reference strength configured, defaulting to
    // "strong"」と警告する。strong は Fn::ImportValue で producer を固定するため、
    // 既定任せにせず明示的な判断としてテンプレートに残す。
    const context = readJson<CdkJson>('../cdk.json').context ?? {};
    expect(Object.keys(context)).toContain(CROSS_STACK_REFERENCES);
    expect(['strong', 'weak', 'both']).toContain(context[CROSS_STACK_REFERENCES]);
  });
});

describe('infra/package.json の pretest', () => {
  it('cdk synth を走らせる（synth 済みテンプレートを読むテストの前提）', () => {
    expect(infraPkg().scripts?.pretest).toContain('cdk synth');
  });

  it('スタックを名指ししていない（名指しすると他スタックの synth 崩れを見逃す）', () => {
    expect(infraPkg().scripts?.pretest).not.toContain('BlogSiteStack');
  });
});

describe('infra/tsconfig.json の型ライブラリ', () => {
  it('compilerOptions.types が ["node"] に限定されている', () => {
    // 限定しないと tsc がルート node_modules/@types を暗黙に全部 type library として
    // 拾う。site ワークスペース由来の壊れた @types が混ざると infra の型検査が
    // 「error TS2688: Cannot find type definition file for 'sax'」で落ちる。
    expect(readJson<TsConfig>('../tsconfig.json').compilerOptions?.['types']).toEqual(['node']);
  });
});

describe('infra/README.md が実装に追いついている', () => {
  const readme = (): string =>
    readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

  /** '## TODO' 見出しから次の '## ' 見出しまでを切り出す。 */
  const todoSection = (): string => {
    const text = readme();
    const start = text.indexOf('\n## TODO');
    expect(start, 'README に TODO セクションが必要').toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.indexOf('\n## ', 1);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('TODO セクションが残っているが、そこに 403 の宿題は無い（step 2.2 で閉じた）', () => {
    const todo = todoSection();
    expect(todo.length).toBeGreaterThan(0);
    expect(todo).not.toContain('403');
  });

  it('構成表が Phase 2 のリソースを網羅している', () => {
    const text = readme();
    expect(text).toContain('MediaBucketE52FC6E4');
    expect(text).toContain('GitHubActionsDeployRole');
  });
});
