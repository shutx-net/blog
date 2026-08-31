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
    // **設定は変えていないが、理由は TS 7 で変わった。この 1 行は今や空振りである。**
    // 3 ワークスペースで同じ話なので、実測の全文はここにだけ書く（api / admin は要約）。
    //
    // # 5.9.3 のとき何をしていたか — 「他所の @types を入れない柵」
    //
    // types を省略すると tsc がルートの node_modules/@types を **暗黙に全部** type
    // library として読んだ。実測（5.9.3・types 省略）で @types 13 パッケージ / 139 ファイルが
    // プログラムに入る: aws-lambda, chai, debug, deep-eql, estree, estree-jsx, hast,
    // mdast, ms, nlcst, node, sax, unist。site 由来の壊れた @types が混ざると infra が
    // 「error TS2688: Cannot find type definition file for 'sax'」で落ちた。
    // （**@types/sax が空だった問題は上流で解消済み。** 現在 1.2.7 の index.d.ts は 3921 バイト。
    //   歴史的な経緯としてだけ残す）
    //
    // # TS 7 で何が変わったか — **types の既定が [] になった**
    //
    // 暗黙の全部読み込みが無くなった。**柵として守る対象がもう存在しない。**
    // 7.0.2 での実測:
    //
    //   - types を消しても api / infra / admin ともエラー 0 件・rc=0
    //   - `tsc --listFiles` の出力が types の有無で **完全に一致する**
    //   - `process` / `Buffer` を裸で書いても types 無しで通る。@types/node は
    //     `node:*` の import 経由で既にプログラムへ入っており、その global 宣言が
    //     そのまま見えるため。**types フィールドは関与していない**
    //
    // 最小再現では今も効く: `node:*` を 1 つも import しないプロジェクトで
    // `process.version` を書くと、types 省略の 7.0.2 は
    // `error TS2591: Cannot find name 'process'` になり、types:["node"] を足すと通る
    // （5.9.3 は types 省略でも通る）。**このリポジトリはその条件に当たらない。**
    //
    // # それでも消さない理由
    //
    // 1. **5.x へ戻す道を塞がないため。** 移行が問題を起こしたときの後退先は 6.0.3 か
    //    5.9.3 で、そこでは柵として本当に効く。今消すと、戻した日に @types/sax 系の
    //    事故が黙って復活する
    // 2. node を対象にしているという明示的な宣言としては正しく、コストが無い
    //
    // # このアサーションが実際に守っているもの（正直に書く）
    //
    // **型検査はもうこの値を見ていない。** 変異で確認済み: types を ["node","chai"] に
    // 広げても `tsc --noEmit` は rc=0 のままで、赤くなったのは api / infra / admin の
    // **このテスト 3 本だけ**だった。つまり現在この行のドリフトを検出できるのは
    // テストだけである。**「緑だから守られている」ではなく「テストだけが見ている」と読むこと。**
    expect(readJson<TsConfig>('../tsconfig.json').compilerOptions?.['types']).toEqual(['node']);
  });
});

describe('infra/tsconfig.json の erasableSyntaxOnly', () => {
  it('compilerOptions.erasableSyntaxOnly が true', () => {
    // **infra だけは、破れたときに型エラーではなく実行時に壊れる。**
    // cdk.json の app が `node bin/blog.ts` で、node 24 のフラグ無し型ストリップに
    // 依存している。enum / namespace / パラメータプロパティ / decorators を書くと
    // 「剥がすだけでは動かない」構文になり、**`cdk synth` だけが実行時に落ちる。**
    // 理由の全文は README.md の「### ツールチェーン」にある。
    //
    // **api と admin には前から同じアサーションがあり、infra にだけ無かった。**
    // 3 つのうち事故が一番静かに起きるのが infra なので、その非対称を埋める。
    //
    // ## 空振りでないことの根拠（TS 7.0.2 で変異を目視した）
    //
    // `lib/__probe-erasable.ts` に次を置くと、3 種類とも
    // `error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`
    // が出て rc=1 になり、消すと rc=0 に戻る（実測）。
    //
    //   export enum ProbeErasable { A }
    //   export class P { constructor(private readonly x: number) {} }
    //   export namespace N { export const a = 1; }
    //
    // 同じ enum のファイルを `node lib/__probe-erasable.ts` で直接実行すると node が
    // 起動時に落ちる。**これが cdk synth で起きる事故そのもの**である。
    // フラグ自体も TS 7 で生きている（`tsc --help` の抜粋 27 個には出ないが
    // `--help --all` には含まれ、CLI フラグとしても受理される。実測 rc=0）。
    expect(readJson<TsConfig>('../tsconfig.json').compilerOptions?.['erasableSyntaxOnly']).toBe(
      true,
    );
  });

  it('**cdk.json の app が node で .ts を直接実行する形のままである**', () => {
    // 上の制約が要る**理由そのもの**。ここが tsx や ts-node に変われば
    // erasableSyntaxOnly の意味も変わるので、2 つを同じ場所で見張る。
    expect(readJson<CdkJson>('../cdk.json').app).toBe('node bin/blog.ts');
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

  it('構成表が Phase 4 のリソースを網羅している', () => {
    const text = readme();
    for (const needle of [
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolDomain',
      'AWS::Cognito::UserPoolClient',
      'AdminAuthUserPoolBFAE8287',
      'AdminAuthUserPoolAdminClient7A4B432D',
      'AdminAuthUserPoolLoginDomain53790831',
      'CorsConfiguration',
    ]) {
      expect(text, `README に ${needle} の記述が無い`).toContain(needle);
    }
  });

  it('**Phase 4 で増えた CfnOutput 4 本が README に載っている**', () => {
    const text = readme();
    for (const output of [
      'AdminUserPoolId',
      'AdminUserPoolClientId',
      'AdminLoginDomain',
      'AdminUserPoolIssuerUrl',
    ]) {
      expect(text, `README に Output 名 ${output} の記載が必要`).toContain(output);
    }
  });

  it('**デプロイ手順に cdk diff・受け入れ確認・切り戻しが揃っている**', () => {
    const text = readme();
    // AGENTS.md の規約: infra を変えたら先に差分を見る。
    expect(text).toContain('cdk diff');
    // **ユーザ作成が CDK ではなく CLI であること**（public リポジトリに個人情報を書かない）。
    expect(text).toContain('aws cognito-idp admin-create-user');
    expect(text).toContain('admin-set-user-password');
    // 受け入れ確認のコマンドがそのまま貼れる形であること。
    expect(text).toContain('/api/health');
    expect(text).toContain('x-blog-authorization: Bearer');
    expect(text).toContain('response_type=code');
    // トークン無しの書き込みが 401 であること、404 HTML なら設計違反であること。
    expect(text).toMatch(/401[^\n]*unauthenticated|unauthenticated[^\n]*401/);
    // SITE_ORIGIN のドリフト確認。
    expect(text).toContain("OutputKey=='DistributionDomainName'");
    // 切り戻し。
    expect(text).toContain("{ mode: 'deny-all' }");
    expect(text).toContain('deletionProtection');
  });

  it('**デプロイ手順が「1 回の cdk deploy で完結する」と書いてある**', () => {
    // AUTH_MODE=cognito の Lambda はユーザプールへの Ref を持つので、
    // CloudFormation は Cognito を先に作る。2 段階に割る必要は無い。
    expect(readme()).toMatch(/1 回[^\n]*deploy|deploy[^\n]*1 回/);
  });

  it('検証結果に W3005 と cfn-guard の記述があり、Phase 3 の件数が明記されている', () => {
    const text = readme();
    expect(text).toContain('W3005');
    expect(text).toContain('cfn-guard');
    // 「6 件のまま」「新規 0 件」が読み取れること。次に誰かが同じ検証をしたとき、
    // 6 件が「ツールが動いていない」ではなく「本当に増えていない」と分かるように。
    expect(text).toMatch(/Phase 3[^\n]*0 件|0 件[^\n]*Phase 3/);
  });

  it('**cfn-guard の節に Phase 4 の行が追記されている**', () => {
    const text = readme();
    expect(text).toMatch(/Phase 4[^\n]*0 件|0 件[^\n]*Phase 4/);
    // Cognito の 3 リソースが 1 件も指摘を生まなかったことが列挙されていること。
    for (const needle of [
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolDomain',
    ]) {
      expect(text, `cfn-guard の節に ${needle} の記述が無い`).toContain(needle);
    }
  });

  it('**cfn-guard の節に Phase 5 の行が追記されている**', () => {
    const text = readme();
    expect(text).toMatch(/Phase 5[^\n]*0 件|0 件[^\n]*Phase 5/);
    // Phase 5 で追加したリソース種別が列挙されていること。
    // 「6 件のまま＝ツールが動いていない」と誤解されないための既存の規律。
    expect(text).toContain('AWS::CloudFront::ResponseHeadersPolicy');
  });

  it('**CSP の記述があり、script-src に unsafe-inline を入れない理由が書かれている**', () => {
    const text = readme();
    expect(text).toContain('Content-Security-Policy');
    expect(text).toContain("script-src");
    expect(text).toContain("'unsafe-inline'");
  });

  it("**'wasm-unsafe-eval' が必要な理由（shiki の wasm）が書かれている**", () => {
    // これが無いと、次に CSP を締めようとした人が「不要な緩和」だと思って消し、
    // **プレビューのハイライトだけが静かに壊れる。**
    const text = readme();
    expect(text).toContain("'wasm-unsafe-eval'");
    expect(text).toContain('shiki');
    expect(text).toContain('WebAssembly');
  });

  it('**meta では frame-ancestors が無視されることが書かれている**', () => {
    // 配り方をヘッダにした根拠。次の人が meta に移そうとしたときの歯止め。
    const text = readme();
    expect(text).toContain('frame-ancestors');
    expect(text).toMatch(/meta[^\n]*無視|無視[^\n]*meta/);
  });

  it('**HSTS に includeSubDomains と preload を付けない理由が書かれている**', () => {
    const text = readme();
    expect(text).toContain('includeSubDomains');
    expect(text).toContain('preload');
    expect(text).toContain('cloudfront.net');
  });

  it('**cfn-lint の E3004（循環参照）についての記述がある**', () => {
    // メディアバケットの CORS で最も踏みやすい罠。cdk synth は素通しするので、
    // 「cfn-lint を回す理由」が README に書かれていないと次の人が省略する。
    expect(readme()).toContain('E3004');
  });

  it('**AUTH_MODE の記述があり、cognito と deny-all の両方が書かれている**', () => {
    // deny-all は切り戻し先として残っているので、両方が書かれている必要がある。
    const text = readme();
    expect(text).toContain('AUTH_MODE');
    expect(text).toContain('deny-all');
    expect(text).toContain('cognito');
  });

  it('x-amz-content-sha256 の記述がある（POST の必須ヘッダという運用上の落とし穴）', () => {
    expect(readme()).toContain('x-amz-content-sha256');
  });

  it('Authorization ヘッダが上書きされる制約の記述がある', () => {
    // OAC の SigningBehavior が always なので、Cognito のトークンを
    // Authorization: Bearer で送る一般的な設計がそのままでは使えない。
    expect(readme()).toContain('Authorization');
  });

  it('**トークン輸送の契約 x-blog-authorization が README に実在する**', () => {
    // admin を作る側がこの 1 行に対して実装する。ドキュメントの腐敗を機械的に防ぐ。
    expect(readme()).toContain('x-blog-authorization');
  });

  it('**403 と 404 を認証に使わない理由が書かれている**', () => {
    // 書かないと次の人が「認可失敗は 403 が素直だ」と直してしまう。
    const text = readme();
    expect(text).toContain('CustomErrorResponses');
    expect(text).toMatch(/403 と 404 を使わない|403 と 404 は/);
    for (const code of ['auth_not_configured', 'unauthenticated', 'invalid_token', 'not_authorized', 'auth_unavailable']) {
      expect(text, `README に error コード ${code} の記載が無い`).toContain(code);
    }
  });

  it('**Cognito の feature plan に Essentials を選んだ理由が書かれている**', () => {
    const text = readme();
    expect(text).toContain('ESSENTIALS');
    expect(text).toContain('Managed Login');
  });

  it('**SITE_ORIGIN 定数の節がある**（循環参照と差し替え手順）', () => {
    const text = readme();
    expect(text).toContain('SITE_ORIGIN');
    expect(text).toContain('DistributionDomainName');
  });

  it('**TODO から「Cognito が入っていない」と「CORS は admin フェーズで」が消えている**', () => {
    // **反転済み。** Phase 3 までは「意図的に開けたまま残した穴」だったが、
    // Phase 4 が両方とも閉じた。宿題として残し続けると次に読む人が
    // 「まだ入っていない」と誤解する。
    const todo = todoSection();
    expect(todo.length).toBeGreaterThan(0);
    expect(todo).not.toContain('エンドユーザ認証（Cognito）が入っていない');
    expect(todo).not.toContain('メディアバケットの CORS は admin フェーズで');
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
    // **`includes('`api/`')` だけで探してはいけない。** ツールチェーン表の
    // 「`api/` のデプロイ先が Lambda の nodejs24.x」という行が先に一致してしまい、
    // ワークスペース表を 1 行も見ないまま緑になる（実測）。行頭で名指しする。
    const rows = developers()
      .split('\n')
      .filter((line) => line.trimStart().startsWith('| `api/` |'));
    expect(rows, 'ワークスペース表に api/ の行がちょうど 1 本必要').toHaveLength(1);
    expect(rows[0]).not.toContain('未着手');
  });
});

describe('DEVELOPERS.md が Phase 4 に追いついている', () => {
  const developers = (): string =>
    readFileSync(fileURLToPath(new URL('../../DEVELOPERS.md', import.meta.url)), 'utf8');

  it('**Cognito ユーザを帯域外で作る手順がある**（CDK には書かない）', () => {
    const text = developers();
    expect(text).toContain('aws cognito-idp admin-create-user');
    expect(text).toContain('admin-set-user-password');
    // 物理値ではなく CfnOutput から拾う形になっていること。
    expect(text).toContain('AdminUserPoolId');
    expect(text).toContain('describe-stacks');
  });

  it('**鍵ローテーションの手順が Cognito のトークンを付ける形になっている**', () => {
    // Phase 3 の注記は「AUTH_MODE が deny-all の間は 503 が返るのでコンソールから」だった。
    // Cognito が入った以上、実行可能な手順に置き換わっていなければならない。
    const text = developers();
    expect(text).toContain('x-blog-authorization: Bearer');
    expect(text).toContain('versionStage=AWSPENDING');
  });

  it('**AUTH_MODE の運用手順（切り戻し）がある**', () => {
    const text = developers();
    expect(text).toContain('AUTH_MODE');
    expect(text).toContain("{ mode: 'deny-all' }");
    // 「いま何で動いているか」を無認証で確認できることが書かれていること。
    expect(text).toContain('"authMode"');
  });

  it('ワークスペース表の api/ が deny-all のままになっていない', () => {
    const rows = developers()
      .split('\n')
      .filter((line) => line.trimStart().startsWith('| `api/` |'));
    expect(rows, 'ワークスペース表に api/ の行がちょうど 1 本必要').toHaveLength(1);
    expect(rows[0]).toContain('cognito');
    expect(rows[0]).not.toContain('deny-all');
  });

  it('**ID トークンであって access トークンではないことが書かれている**', () => {
    expect(developers()).toContain('ID トークン');
  });
});
