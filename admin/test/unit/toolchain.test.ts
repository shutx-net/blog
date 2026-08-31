import { existsSync, readFileSync } from 'node:fs';
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

interface TsConfig {
  compilerOptions?: Record<string, unknown>;
}

/**
 * 完全固定バージョン。^ ~ >= x * のいずれも許さない。
 * infra/test/toolchain.test.ts・api/test/unit/toolchain.test.ts と同じ正規表現を使う
 * （規律をワークスペース間でずらさない）。
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * 入れないと決めたパッケージ。理由は計画の toolchain.rationale にある（すべて実測値つき）。
 *
 * - react / react-dom / preact / svelte / solid-js
 *     : 保守面では合格するものもあるが、この UI が必要としているものが何も無い
 *       （ルーティング無し・一覧無し・フィールド 7 個）。ブラウザ無しで component を
 *       検証するには @testing-library/* が要り、そこで新規パッケージが 32 -> 52 個になる。
 * - astro : admin 側に持ち込む理由が無い（1 ページで SSG の利得が無い）。
 * - codemirror / @codemirror/*
 *     : gh api 実測で 7 リポジトリすべてが archived=true（AGENTS.md の不採用条件）。
 *       正本が個人のセルフホスト git に移動しており、npm maintainers は各 1 人。
 * - easymde : リリース間隔 29 ヶ月 / 14 ヶ月、依存に marked（2 本目の Markdown パーサ）。
 * - marked / markdown-it / remark
 *     : **2 本目の Markdown パーサを持ち込まない。** プレビュー一致の要件が
 *       site と同じ @astrojs/markdown-remark 以外の答えを許さない。
 * - happy-dom : jsdom より軽いが npm maintainers が 1 人。AGENTS.md は保守を
 *       推移依存の少なさより上位に置いている。
 * - @testing-library/* : UI フレームワークを入れないので不要。
 *
 * 後から「便利だから」で入らないよう、判断を機械的に固定する。
 */
const FORBIDDEN_PACKAGES = [
  'react',
  'react-dom',
  'preact',
  'svelte',
  'solid-js',
  'astro',
  'codemirror',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/lang-markdown',
  'easymde',
  'marked',
  'markdown-it',
  'remark',
  'happy-dom',
  '@testing-library/react',
  '@testing-library/dom',
];

const readJson = <T>(relative: string): T => {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  expect(existsSync(path), `${relative} が存在すること`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

const adminPkg = (): PackageJson => readJson<PackageJson>('../../package.json');
const rootPkg = (): PackageJson => readJson<PackageJson>('../../../package.json');
const sitePkg = (): PackageJson => readJson<PackageJson>('../../../site/package.json');
const apiPkg = (): PackageJson => readJson<PackageJson>('../../../api/package.json');
const adminTsConfig = (): TsConfig => readJson<TsConfig>('../../tsconfig.json');

describe('admin/package.json のかたち', () => {
  it('name が "@blog/admin" である', () => {
    expect(adminPkg().name).toBe('@blog/admin');
  });

  it('"type" が "module" である', () => {
    expect(adminPkg().type).toBe('module');
  });

  it('private: true である（誤って publish しないため）', () => {
    expect(adminPkg().private).toBe(true);
  });

  it('scripts に build / test / test:unit / typecheck / smoke がある', () => {
    const scripts = adminPkg().scripts ?? {};
    for (const name of ['build', 'test', 'test:unit', 'typecheck', 'smoke']) {
      expect(scripts[name], `scripts.${name} が必要`).toBeDefined();
    }
    expect(scripts['typecheck']).toBe('tsc --noEmit');
  });
});

describe('npm workspaces のルート', () => {
  it("workspaces が ['site','infra','api','admin'] を過不足なく含む", () => {
    const root = rootPkg();
    expect(Array.isArray(root.workspaces)).toBe(true);
    expect([...(root.workspaces ?? [])].sort()).toEqual(['admin', 'api', 'infra', 'site']);
  });

  it('workspaces 配列に "admin" が含まれる', () => {
    // これが無いと npm run -w admin ... がどれも解決しない。
    expect(rootPkg().workspaces).toContain('admin');
  });
});

describe('プレビュー一致の前提になるバージョン固定', () => {
  it('**@astrojs/markdown-remark が site の値と文字列として完全一致する**', () => {
    // ずれると npm が 2 本入れ、admin のプレビューと本番のレンダリングが
    // **テストは緑のまま**静かに乖離する。文字列比較にしているのは
    // semver 的に等価な別表記（"7.2.4" と "=7.2.4"）も許さないため。
    const admin = adminPkg().dependencies?.['@astrojs/markdown-remark'];
    const site = sitePkg().dependencies?.['@astrojs/markdown-remark'];
    expect(site, 'site 側が @astrojs/markdown-remark を宣言していること').toBeDefined();
    expect(admin, 'admin 側が @astrojs/markdown-remark を宣言していること').toBeDefined();
    expect(admin).toBe(site);
    expect(admin).toMatch(EXACT_VERSION);
  });

  it('vitest が api の値と完全一致する', () => {
    const admin = adminPkg().devDependencies?.['vitest'];
    expect(admin).toBe(apiPkg().devDependencies?.['vitest']);
    expect(admin).toMatch(EXACT_VERSION);
  });

  it('typescript が api の値と完全一致する（ワークスペース間でコンパイラをずらさない）', () => {
    const admin = adminPkg().devDependencies?.['typescript'];
    expect(admin).toBe(apiPkg().devDependencies?.['typescript']);
    expect(admin).toMatch(EXACT_VERSION);
  });

  it('vite と jsdom が devDependencies にあり、完全固定である', () => {
    const dev = adminPkg().devDependencies ?? {};
    for (const name of ['vite', 'jsdom']) {
      expect(dev[name], `${name} が devDependencies に必要`).toBeDefined();
      expect(dev[name], `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(
        EXACT_VERSION,
      );
    }
  });
});

describe('admin の依存はすべて完全固定', () => {
  it('dependencies / devDependencies の全バージョンが ^ ~ >= x * を含まない', () => {
    const pkg = adminPkg();
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // 依存が 1 つも無ければ for が 0 周で緑になる。先に非空を主張する。
    expect(Object.keys(all).length, 'admin に依存が 1 つも宣言されていない').toBeGreaterThan(0);
    for (const [name, version] of Object.entries(all)) {
      expect(version, `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(
        EXACT_VERSION,
      );
    }
  });

  it('ブラウザに配る dependencies が @astrojs/markdown-remark ちょうど 1 本である', () => {
    // dependencies に入ったものはバンドルされてブラウザに届く。admin は投稿の
    // 全権限を持つので、ここが増えることは供給網が本番の書き込み経路に
    // 直結して増えることを意味する。
    expect(Object.keys(adminPkg().dependencies ?? {})).toEqual(['@astrojs/markdown-remark']);
  });
});

describe('入れないと決めたパッケージ', () => {
  it('禁止パッケージ表が空でない', () => {
    // it.each は空配列でも緑になる。表が空になった事故を先に落とす。
    expect(FORBIDDEN_PACKAGES.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_PACKAGES)('%s が dependencies にも devDependencies にも無い', (name) => {
    const pkg = adminPkg();
    expect(pkg.dependencies?.[name], `${name} を dependencies に入れない`).toBeUndefined();
    expect(pkg.devDependencies?.[name], `${name} を devDependencies に入れない`).toBeUndefined();
  });
});

describe('admin/tsconfig.json', () => {
  it('strict 系のフラグがすべて true である', () => {
    const options = adminTsConfig().compilerOptions ?? {};
    for (const flag of [
      'strict',
      'noEmit',
      'verbatimModuleSyntax',
      'erasableSyntaxOnly',
      'allowImportingTsExtensions',
      'forceConsistentCasingInFileNames',
    ]) {
      expect(options[flag], `compilerOptions.${flag} が true であること`).toBe(true);
    }
  });

  it('compilerOptions.types が ["node"] に限定されている', () => {
    // 限定しないと tsc がルート node_modules/@types を暗黙に全部拾う。
    // api / infra と同じ形。**@types/node を admin では宣言しない**のも同じ理由で、
    // 2 本入ると types:["node"] が重複定義で落ちる。
    expect(adminTsConfig().compilerOptions?.['types']).toEqual(['node']);
  });

  it('**moduleResolution が "bundler" である**（api / infra の nodenext と意図的に違う）', () => {
    // admin を解決するのは Node ではなく Vite。nodenext にすると
    // package.json の exports の browser 条件などを Node の規則で誤判定する。
    expect(adminTsConfig().compilerOptions?.['moduleResolution']).toBe('bundler');
  });

  it('skipLibCheck が true（astro の .d.ts を admin の型検査に持ち込まないため）', () => {
    // api/tsconfig.json と同じ理由。contract テストが site の postSchema を
    // 実物で import する結果、astro / shiki / unstorage の .d.ts が引きずり込まれる。
    expect(adminTsConfig().compilerOptions?.['skipLibCheck']).toBe(true);
  });
});
