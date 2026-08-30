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
 * infra/test/toolchain.test.ts と同じ正規表現を使う（規律をワークスペース間でずらさない）。
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * **ロックステップで揃えるべき依存。** @aws-sdk/* は同日リリースなのでバージョンを
 * 一致させる。aws-jwt-verify はこの検査に含めない（別系統・別リリース周期）。
 */
const AWS_SDK_DEPENDENCIES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/client-secrets-manager',
  '@aws-sdk/s3-request-presigner',
];

/**
 * Lambda バンドルに入る依存の **全集合**。これ以外を dependencies に置かない。
 *
 * **AWS_SDK_DEPENDENCIES と分けてあるのは意図的である。** Phase 3 まではこの 2 つが
 * 同じ集合だったので 1 つの定数が「実行時依存の全集合」と「バージョンをロックステップ
 * させる集合」の 2 つの意味を兼ねていた。aws-jwt-verify を足すと両者が分岐する。
 * ここで割らずにバージョン検査のほうを緩めると、**AWS SDK 間のバージョンずれを
 * 検出する能力を失う**（Phase 3 が意図的に入れた検査なので殺してはいけない）。
 */
const RUNTIME_DEPENDENCIES = [...AWS_SDK_DEPENDENCIES, 'aws-jwt-verify'].sort();

/**
 * 入れないと決めたパッケージ。理由は計画の toolchain.rationale にある。
 *
 * **署名と検証で判断が分かれる。**
 *
 * - **署名（GitHub App の JWT）は node:crypto で書く。** createSign('RSA-SHA256') は
 *   GitHub が配る PKCS#1 PEM をそのまま受け取れる（3.3 で実証）。署名には敵対的入力が
 *   無いので、自前で持つコストが低い。
 * - **検証（Cognito の ID トークン）は aws-jwt-verify に任せる。** 危険なのは
 *   createVerify の 1 行ではなく、その周りの alg 許可リスト / kid の選択 / JWKS の取得と
 *   キャッシュと鍵ローテーション / iss・aud・token_use・exp の検証であり、JWT の CVE は
 *   歴史的にほぼ全部この層で生まれている。依存 0・推移依存 0 で、この層を
 *   「トークンを発行している当の AWS が保守しているもの」に置き換えられる。
 *
 * - jose      : 汎用 JOSE ツールキットで、token_use / cognito:username / aud と client_id の
 *               使い分けを知らない。**依存を足したうえで危険な半分を自分で書く**ことになり、
 *               両方の欠点だけが残る。npm メンテナも 1 名で bus factor が悪い。
 * - @octokit  : 6 エンドポイントのために推移的依存を 32 個増やすうえ、
 *               「どのリクエストが飛んだか」のアサーションが Octokit の内部実装に依存する。
 * - jsonwebtoken : 検証は aws-jwt-verify、署名は node:crypto で足りる。
 *
 * 後から「便利だから」で入らないよう、判断を機械的に固定する。
 */
const FORBIDDEN_PACKAGES = ['jose', '@octokit/rest', '@octokit/auth-app', 'jsonwebtoken'];

const readJson = <T>(relative: string): T => {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  expect(existsSync(path), `${relative} が存在すること`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

const apiPkg = (): PackageJson => readJson<PackageJson>('../../package.json');
const rootPkg = (): PackageJson => readJson<PackageJson>('../../../package.json');
const infraPkg = (): PackageJson => readJson<PackageJson>('../../../infra/package.json');
const apiTsConfig = (): TsConfig => readJson<TsConfig>('../../tsconfig.json');

describe('npm workspaces のルート', () => {
  it('workspaces 配列に "api" が含まれる', () => {
    const root = rootPkg();
    expect(Array.isArray(root.workspaces)).toBe(true);
    expect(root.workspaces).toContain('api');
  });
});

describe('api の実行時依存', () => {
  it('dependencies が @aws-sdk 3 つ + aws-jwt-verify のちょうど 4 つである', () => {
    // ここに増えたものはすべて Lambda のバンドルに入る。**集合等価で書く**（部分集合に
    // しない）ので、5 つめが増えた瞬間に赤くなる。GitHub クライアントも JWT の署名も
    // node 組み込み（fetch / node:crypto）で書くので、これ以上は増えない。
    const deps = apiPkg().dependencies ?? {};
    expect(Object.keys(deps).sort()).toEqual(RUNTIME_DEPENDENCIES);
    expect(RUNTIME_DEPENDENCIES).toHaveLength(4);
  });

  it('実行時依存 4 つがすべて完全固定バージョンである', () => {
    const deps = apiPkg().dependencies ?? {};
    for (const name of RUNTIME_DEPENDENCIES) {
      expect(deps[name], `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(
        EXACT_VERSION,
      );
    }
  });

  it('aws-jwt-verify が完全固定の 5.2.1 である（^ も ~ も付けない）', () => {
    // AGENTS.md「バージョンは完全固定」。^5.2.1 は「次に誰かが npm install した日に
    // 別のコードが入る」という意味で、署名検証という信頼の根っこには置けない。
    const version = apiPkg().dependencies?.['aws-jwt-verify'];
    expect(version).toBe('5.2.1');
    expect(version).toMatch(EXACT_VERSION);
  });

  it('aws-jwt-verify が devDependencies **ではなく** dependencies にある', () => {
    // Lambda のバンドルに入る必要がある。devDependencies に置くと esbuild は
    // バンドルできるがワークスペースの意味が食い違い、依存の棚卸しから漏れる。
    expect(apiPkg().dependencies?.['aws-jwt-verify']).toBeDefined();
    expect(apiPkg().devDependencies?.['aws-jwt-verify']).toBeUndefined();
  });

  it('3 つの AWS SDK のバージョンが互いに一致する', () => {
    // @aws-sdk/* は同日リリースのロックステップ。ずらすと共有される @smithy 層で
    // 不整合が起きうる（2 バージョンの @smithy がバンドルに同居する）。
    // **aws-jwt-verify はこのループに入れない** — 別系統なので必ず不一致になり、
    // 素朴に足すと検査そのものを緩めるしかなくなる。
    const deps = apiPkg().dependencies ?? {};
    expect(AWS_SDK_DEPENDENCIES).toHaveLength(3);
    const versions = new Set(AWS_SDK_DEPENDENCIES.map((name) => deps[name]));
    expect(versions.size, `AWS SDK のバージョンが揃っていない: ${[...versions].join(' / ')}`).toBe(
      1,
    );
    // 3 つとも未定義でも Set のサイズは 1 になる。実在する 1 つの値であることを
    // 別に主張しないと、依存がまるごと無いときに素通りする。
    const [only] = [...versions];
    expect(only, 'AWS SDK が 1 つも宣言されていない').toMatch(EXACT_VERSION);
  });
});

describe('api の開発依存', () => {
  it('esbuild / typescript / vitest / @types/aws-lambda があり、すべて完全固定である', () => {
    const dev = apiPkg().devDependencies ?? {};
    for (const name of ['esbuild', 'typescript', 'vitest', '@types/aws-lambda']) {
      expect(dev[name], `${name} が devDependencies に必要`).toBeDefined();
      expect(dev[name], `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(
        EXACT_VERSION,
      );
    }
  });

  it('typescript が "5.9.3" で、infra の typescript と一致する', () => {
    // ワークスペース間でコンパイラをずらさない。7.x は type:module 化と
    // ネイティブバイナリを伴う別物で、infra が 5.9.3 に固定されている以上ずらす理由がない。
    const apiTs = apiPkg().devDependencies?.['typescript'];
    expect(apiTs).toBe('5.9.3');
    expect(apiTs).toBe(infraPkg().devDependencies?.['typescript']);
  });

  it('vitest が infra / site と同じ 4.1.11 に固定されている', () => {
    expect(apiPkg().devDependencies?.['vitest']).toBe('4.1.11');
    expect(apiPkg().devDependencies?.['vitest']).toBe(infraPkg().devDependencies?.['vitest']);
  });
});

describe('入れないと決めたパッケージ', () => {
  it.each(FORBIDDEN_PACKAGES)('%s が dependencies にも devDependencies にも無い', (name) => {
    const pkg = apiPkg();
    expect(pkg.dependencies?.[name], `${name} を dependencies に入れない`).toBeUndefined();
    expect(pkg.devDependencies?.[name], `${name} を devDependencies に入れない`).toBeUndefined();
  });
});

describe('api/package.json のかたち', () => {
  it('"type" が "module" である', () => {
    expect(apiPkg().type).toBe('module');
  });

  it('private: true である（誤って publish しないため）', () => {
    expect(apiPkg().private).toBe(true);
  });

  it('scripts.build が esbuild を ESM / node24 / dist/index.mjs で呼ぶ', () => {
    // **出力は .mjs であって .js ではない。** node は .js を既定で CommonJS として
    // 読むので、--format=esm の出力を .js に置くと Lambda が起動時に SyntaxError で落ちる。
    const build = apiPkg().scripts?.['build'];
    expect(build, 'scripts.build が必要（AGENTS.md の `npm run -w api build`）').toBeDefined();
    expect(build).toContain('esbuild');
    expect(build).toContain('--format=esm');
    expect(build).toContain('--target=node24');
    expect(build).toContain('--outfile=dist/index.mjs');
    expect(build, '--outfile=dist/index.js は Lambda が CommonJS として読む').not.toContain(
      '--outfile=dist/index.js ',
    );
  });

  it('scripts に test と typecheck がある', () => {
    const scripts = apiPkg().scripts ?? {};
    expect(scripts['test']).toBe('vitest run');
    expect(scripts['typecheck']).toBe('tsc --noEmit');
  });
});

describe('api/tsconfig.json', () => {
  it('compilerOptions.types が ["node"] に限定されている', () => {
    // 限定しないと tsc がルート node_modules/@types を暗黙に全部 type library として
    // 拾い、他ワークスペース由来の壊れた @types で型検査が落ちる（infra と同じ理由）。
    // **@types/aws-lambda はこの設定の影響を受けない** — types が制御するのは
    // 「グローバルとして自動で読み込む @types」だけで、明示的な
    // `import type { ... } from 'aws-lambda'` は通常のモジュール解決で解決される。
    expect(apiTsConfig().compilerOptions?.['types']).toEqual(['node']);
  });

  it('compilerOptions.erasableSyntaxOnly が true', () => {
    // node 24 はフラグ無しで TS の型を剥がすが、enum など「剥がすだけでは動かない」
    // 構文がある。静的に禁止して、バンドル前後で意味が変わらないことを保証する。
    expect(apiTsConfig().compilerOptions?.['erasableSyntaxOnly']).toBe(true);
  });

  it('skipLibCheck が true（astro の .d.ts を api の型検査に持ち込まないため）', () => {
    // **infra には無い設定なので、理由をここに残す。**
    // test/contract/frontmatter-schema.test.ts が site の postSchema を実物で import
    // する結果、astro / shiki / unstorage の .d.ts が api の tsc に引きずり込まれる。
    // それらは DOM lib と省略可能な peer 依存を前提に書かれており、api の
    // lib:["ES2023"] / types:["node"] では 130 件超のエラーになる（実測）。
    //
    // **lib に "DOM" を足して解決してはいけない。** api は Lambda のコードで、
    // window や HTMLElement が型として見えてよい理由が無い。skipLibCheck が
    // 飛ばすのは .d.ts 自身の検査だけで、api 自身のコードの検査は一切緩まない。
    expect(apiTsConfig().compilerOptions?.['skipLibCheck']).toBe(true);
    expect(apiTsConfig().compilerOptions?.['lib'], 'DOM を足さない').toEqual(['ES2023']);
  });

  it('infra と同じ厳しさ（strict / verbatimModuleSyntax / nodenext）である', () => {
    const options = apiTsConfig().compilerOptions ?? {};
    expect(options['strict']).toBe(true);
    expect(options['verbatimModuleSyntax']).toBe(true);
    expect(options['module']).toBe('nodenext');
    expect(options['moduleResolution']).toBe('nodenext');
  });
});
