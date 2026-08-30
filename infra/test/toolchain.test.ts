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

  it("workspaces が ['site','infra','api'] を含む", () => {
    // **`admin` を含まない、というアサーションは削除した。**
    // あれは「次フェーズでやる」という予定をテストに書いたものだった。存在理由が
    // 消されることにしか無く、admin を足す最初のコミットが別ワークスペースを
    // 赤くする（そして admin の担当者は infra を触るなと言われている）。
    // 予定は README に書く。テストに書くと、進捗そのものが失敗として現れる。
    const workspaces = rootPkg().workspaces ?? [];
    expect(workspaces).toEqual(expect.arrayContaining(['site', 'infra', 'api']));
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

  it('**api のバンドルを先にビルドする**', () => {
    // Code.fromAsset が api/dist を読むので、synth の前に api のバンドルが要る。
    // ビルドせずに synth すると **テンプレートは通るのに中身が古い**。
    expect(infraPkg().scripts?.pretest).toContain('npm run build -w ../api');
  });

  it("**'-w api' という（infra からは解決できない）形になっていない**", () => {
    // 実測: infra を cwd にした `npm run -w api build` も
    // `npm --prefix .. run -w api build` も 'No workspaces found: --workspace=api' で失敗する。
    // **パス形式（-w ../api）だけが通る。**
    const pretest = infraPkg().scripts?.pretest ?? '';
    expect(pretest).not.toMatch(/-w\s+api(\s|$)/);
    expect(pretest).not.toContain('--prefix ..');
  });

  it('api のビルドが cdk synth **より前** に来る', () => {
    const pretest = infraPkg().scripts?.pretest ?? '';
    const buildAt = pretest.indexOf('npm run build -w ../api');
    const synthAt = pretest.indexOf('cdk synth');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(synthAt).toBeGreaterThanOrEqual(0);
    expect(buildAt, 'api のビルドが synth より後ろにある').toBeLessThan(synthAt);
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

  it('構成表が Phase 3 のリソースを網羅している', () => {
    const text = readme();
    for (const needle of [
      'PostingApi',
      'AWS::Lambda::Url',
      'AWS::SecretsManager::Secret',
      'AWS::Lambda::Permission',
      'SiteDistributionOrigin3FunctionUrlOriginAccessControl1ACDDE31',
    ]) {
      expect(text, `README に ${needle} の記述が無い`).toContain(needle);
    }
  });

  it('検証結果に W3005 と cfn-guard の記述があり、Phase 3 の件数が明記されている', () => {
    const text = readme();
    expect(text).toContain('W3005');
    expect(text).toContain('cfn-guard');
    // 「6 件のまま」「新規 0 件」が読み取れること。次に誰かが同じ検証をしたとき、
    // 6 件が「ツールが動いていない」ではなく「本当に増えていない」と分かるように。
    expect(text).toMatch(/Phase 3[^\n]*0 件|0 件[^\n]*Phase 3/);
  });

  it('**AUTH_MODE と deny-all の記述がある**（デプロイ前に fail-closed 状態を知れる）', () => {
    const text = readme();
    expect(text).toContain('AUTH_MODE');
    expect(text).toContain('deny-all');
  });

  it('x-amz-content-sha256 の記述がある（POST の必須ヘッダという運用上の落とし穴）', () => {
    expect(readme()).toContain('x-amz-content-sha256');
  });

  it('Authorization ヘッダが上書きされる制約の記述がある', () => {
    // OAC の SigningBehavior が always なので、Cognito のトークンを
    // Authorization: Bearer で送る一般的な設計がそのままでは使えない。
    expect(readme()).toContain('Authorization');
  });

  it('TODO セクションに Cognito が含まれる（意図的に開けたまま残した穴）', () => {
    expect(todoSection()).toContain('Cognito');
  });
  it('実デプロイで解決した宿題が TODO に残っていない', () => {
    // **反転済み。** 2026-08-30 の deploy ワークフロー実走で
    // 「6 アクションで足りるか」と「lambda:InvokeFunction が要るか」が確定した。
    // 前者は足り、後者は要った。宿題として残し続けると、次に読む人が
    // 「まだ分かっていない」と誤解する。
    expect(todoSection()).not.toContain('実デプロイ未検証');
    expect(todoSection()).not.toContain('lambda:InvokeFunction` が要るか');
  });

  it('解決した宿題は結果と確かめ方つきで記録されている', () => {
    // 結論だけ書いて消すと、次に同じ疑問を持った人が同じ調査をやり直す。
    // **ローカルでは原理的に確かめられなかった項目なので、確かめ方こそが価値である。**
    const text = readme();
    expect(text).toContain('実デプロイで解決した宿題');
    expect(text).toContain('Assuming role with OIDC');
    for (const needle of ['s3:GetObject', 'lambda:InvokeFunction', 'workflow_dispatch']) {
      expect(text, `解決記録に ${needle} が無い`).toContain(needle);
    }
  });

  it('GitHub Actions の変数 3 つと、その値の取得元が書かれている', () => {
    // ワークフローは vars.* を読むだけで、未設定でも空文字に展開される。
    // 「どこから値を持ってくるか」が README に無いと、preflight ガードが
    // 落ちたときに次の一手が分からない。
    const text = readme();
    for (const name of ['AWS_DEPLOY_ROLE_ARN', 'SITE_BUCKET', 'CLOUDFRONT_DISTRIBUTION_ID']) {
      expect(text, `README に ${name} の記載が必要`).toContain(name);
    }
    // 値は CloudFormation の Output からしか取れない（デプロイロールには
    // cloudformation:DescribeStacks が無いので、実行時に読むことはできない）。
    expect(text).toContain('describe-stacks');
    for (const output of ['DeployRoleArn', 'SiteBucketName', 'DistributionId']) {
      expect(text, `README に Output 名 ${output} の記載が必要`).toContain(output);
    }
  });
});

describe('DEVELOPERS.md が実装に追いついている', () => {
  const developers = (): string =>
    readFileSync(fileURLToPath(new URL('../../DEVELOPERS.md', import.meta.url)), 'utf8');

  it('**シークレットの物理名がハードコードされていない**', () => {
    // CDK は物理名を付けない方針なので、手順書に blog/github-app-private-key と
    // 書いてあっても **その名前のシークレットは存在しない**（手順が実行不能だった）。
    // CfnOutput GitHubAppSecretName から取る形に置き換わっていること。
    expect(developers()).not.toContain('blog/github-app-private-key');
  });

  it('CfnOutput の GitHubAppSecretName を参照している', () => {
    expect(developers()).toContain('GitHubAppSecretName');
  });

  it('鍵ローテーションの検証手順が実行可能な形になっている', () => {
    // 「AWSPENDING で投入し、動作を確認」の **確認手段** が存在すること。
    const text = developers();
    expect(text).toContain('AWSPENDING');
    expect(text).toContain('versionStage=AWSPENDING');
    expect(text).toContain('/api/health/github-app');
  });

  it('ワークスペース表で api/ が「未着手」でない', () => {
    const text = developers();
    const row = text.split('\n').find((line) => line.includes('`api/`') && line.includes('|'));
    expect(row, 'ワークスペース表に api/ の行が必要').toBeDefined();
    expect(row).not.toContain('未着手');
  });
});
