import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **ビルド成果物そのものを検査する。**
 *
 * infra は lambda.Code.fromAsset('api/dist') でここを読むので、
 * ソースが正しくてもバンドルが壊れていれば本番だけが壊れる。
 * api/package.json の pretest が build を走らせるので、このテストは常に最新を見る。
 */
const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
const bundlePath = `${distDir}index.mjs`;

/** 実測のベースラインは 617,185 バイト。3 MB は「node_modules を丸ごと巻き込んだ」ときだけ鳴る。 */
const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;

/** バンドルを import するために最低限必要な環境変数。 */
const ENV: Record<string, string> = {
  AUTH_MODE: 'deny-all',
  GITHUB_APP_CLIENT_ID: 'Iv23liTEST',
  GITHUB_OWNER: 'shutx-net',
  GITHUB_REPO: 'blog',
  GITHUB_APP_SECRET_ID: 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:x-AbCdEf',
  MEDIA_BUCKET: 'blogsitestack-mediabucket-example',
  AWS_REGION: 'ap-northeast-1',
};

/**
 * 素の node でバンドルを import し、結果を 1 行にまとめて stdout に出す。
 *
 * **子プロセス側で例外を捕まえて短く出すのが要点。** そのまま投げさせると node が
 * 未整形の（minify 済みで数十万文字の）ソース行を stderr に吐き、spawnSync の
 * 既定 maxBuffer 1MB を超えて **肝心のエラーメッセージが切り落とされる**（実測）。
 */
const runBundle = (env: Record<string, string>) => {
  const script = `
    try {
      const m = await import(${JSON.stringify(bundlePath)});
      console.log('OK:' + typeof m.handler);
    } catch (error) {
      console.log('ERR:' + error.message);
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

describe('esbuild のバンドル', () => {
  it('dist/index.mjs が存在する', () => {
    expect(existsSync(bundlePath), `${bundlePath} が無い。npm run -w api build を先に走らせる`).toBe(
      true,
    );
  });

  it('**拡張子が .mjs である**（.js だと Lambda が CommonJS として読む）', () => {
    // node は .js を既定で CommonJS として扱う。--format=esm の出力を .js に置くと
    // Lambda が起動時に SyntaxError で落ちる。
    expect(bundlePath.endsWith('.mjs')).toBe(true);
    expect(existsSync(`${distDir}index.js`), 'dist/index.js があってはいけない').toBe(false);
  });

  it('単一ファイルである（dist に他の .js/.mjs が無い）', () => {
    // 外部ファイルが要るバンドルは Code.fromAsset のディレクトリ指定と食い違いを起こしうる。
    const scripts = readdirSync(distDir).filter((name) => /\.(js|mjs|cjs)$/.test(name));
    expect(scripts).toEqual(['index.mjs']);
  });

  it(`サイズが ${MAX_BUNDLE_BYTES} バイト以内である`, () => {
    const size = statSync(bundlePath).size;
    expect(size).toBeGreaterThan(100_000); // AWS SDK が入っていれば必ずこれを超える
    expect(size).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  it('ESM として出力されている（CommonJS の痕跡が無い）', () => {
    const source = readFileSync(bundlePath, 'utf8');
    expect(source).toContain('export');
    expect(source).not.toMatch(/^\s*module\.exports\s*=/m);
  });

  it('**秘密らしき文字列が 1 つも無い**', () => {
    const source = readFileSync(bundlePath, 'utf8');
    expect(source).not.toContain('-----BEGIN');
    expect(source).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    expect(source).not.toMatch(/\bghp_[A-Za-z0-9]{36}\b/);
    expect(source).not.toMatch(/\bghs_[A-Za-z0-9]{36}\b/);
  });

  it('テスト専用の依存を巻き込んでいない', () => {
    const source = readFileSync(bundlePath, 'utf8');
    // 契約テストが site のスキーマを、presign のテストが infra の定数を import して
    // いるが、それは **テストだけ**。src から参照していたらここに現れる。
    //
    // 素の 'vitest' で検査してはいけない: AWS SDK は User-Agent のために自分の
    // package.json をバンドルに取り込んでおり、その scripts に 'vitest' の 3 文字が
    // 含まれる（実測で偽陽性になった）。パッケージ固有の識別子で見る。
    expect(source).not.toContain('astro/content/config');
    expect(source).not.toContain('aws-cdk-lib');
    expect(source).not.toContain('YAMLException'); // js-yaml
    expect(source).not.toContain('@vitest/expect');
  });

  it('**createRequire の banner が付いている**（ESM 出力で CJS 依存を動かすため）', () => {
    // 実測: banner が無いと、実 node での import が
    // 'Error: Dynamic require of "node:https" is not supported' で落ちる。
    // AWS SDK の依存のどれかが実行時に require() を呼ぶため、esbuild の ESM 出力では
    // 例外を投げるスタブに置き換わる。**Lambda はコールドスタートで必ず落ちる。**
    const head = readFileSync(bundlePath, 'utf8').slice(0, 200);
    expect(head).toContain('createRequire');
    expect(head).toContain('import.meta.url');
  });

  it('**素の node 24 で import でき、handler が function として取れる**', () => {
    // **必ず子プロセスの素の node で確認する。** vitest のモジュールランナーは
    // require の相互運用を用意してくれるので、同一プロセスで `await import()` すると
    // 上の banner が無くても通ってしまう（実測で偽陽性を出した）。
    // Lambda が実行するのは素の node なので、テストもそれに合わせる。
    const result = runBundle(ENV);
    expect(result.status, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('OK:function');
  });

  it('**環境変数が無ければ import 自体が失敗する**（コールドスタートで落ちる）', () => {
    // fail-closed の最終確認。バンドルされた成果物でも AUTH_MODE が無ければ起動しない。
    // Lambda はコールドスタートで落ち、CloudFront には 502 が返る。
    const result = runBundle({});
    expect(result.status, 'AUTH_MODE が無いのに import が通ってしまった').not.toBe(0);
    expect(result.stdout).toContain('AUTH_MODE');
  });

  it('環境変数が 1 つでも欠けると起動しない', () => {
    for (const missing of Object.keys(ENV)) {
      const env = { ...ENV };
      delete env[missing];
      const result = runBundle(env);
      expect(result.status, `${missing} が無いのに起動した`).not.toBe(0);
      expect(result.stdout).toContain(missing);
    }
  });
});
