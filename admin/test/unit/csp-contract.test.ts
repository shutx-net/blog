import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_CONTENT_TYPES } from '@blog/api/src/media/limits.ts';
import { describe, expect, it } from 'vitest';

import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { buildCsp } from '../../../infra/lib/response-headers.ts';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * **「CSP を入れたせいで壊れた」を出荷前に捕まえる。**
 *
 * CSP の効果はブラウザでしか観測できない（実測で **jsdom は CSP を一切強制しない** —
 * `script-src-attr 'none'` を与えた場合と与えない場合で `<div onclick>` の発火が
 * どちらも 1 回で同一だった。`<img onerror>` がどちらも 0 回なのは **jsdom が画像を
 * 取りに行かないだけ**で CSP のおかげではない）。
 * **したがって「CSP が onerror を止めた」という緑のテストは原理的に書けず、
 * 書けば嘘になる。**
 *
 * 書けるのは 2 つだけで、ここは後者を担当する。
 *
 *   (1) ポリシー文字列が正しいこと          -> infra/test/distribution-response-headers.test.ts
 *   (2) **アプリが必要とするものを許可し漏れていないこと** -> このファイル
 *   (3) 実配信にヘッダが届いていること       -> admin/scripts/auth-smoke.ts
 *
 * # infra の純粋関数を直接 import している
 *
 * `infra/lib/response-headers.ts` は**依存ゼロ**（import 文が 1 つも無いことを
 * infra 側のテストが固定している）なので、CDK を引き込まずに読める。
 * **同じ関数が infra の実物と、このテストの期待値の両方を作る**ので、
 * ディレクティブの取りこぼしが片側だけ起きることがない。
 * **admin の実行時コードは CSP を一切知らない**（走査規則を汚さない）。テストだけが読む。
 */

/** 実配信で解決される値を入れて組み立てる。 */
const CSP = buildCsp({
  cognitoOrigin: AUTH_CONFIG.loginDomain,
  mediaOrigin: 'https://blogsitestack-mediabucket-example.s3.ap-northeast-1.amazonaws.com',
});

/** ディレクティブ名で厳密に引く（`script-src` を探して `script-src-attr` を拾わない）。 */
const directive = (name: string): string[] => {
  const found = CSP.split(';')
    .map((part) => part.trim().split(/\s+/).filter((token) => token.length > 0))
    .find((tokens) => tokens[0] === name);
  expect(found, `${name} が CSP に無い`).toBeDefined();
  return (found as string[]).slice(1);
};

const sourceFiles = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
      : entry.name.endsWith('.ts')
        ? [`${prefix}${entry.name}`]
        : [],
  );

describe('**CSP が admin の通信先を全部許可している**', () => {
  it('CSP が空でない', () => {
    expect(CSP.length).toBeGreaterThan(0);
  });

  it('**admin の認可サーバのドメインが connect-src に含まれる**', () => {
    // admin と infra の 2 箇所に同じホストが出てくる。片方だけ変わると
    // **「ログインだけ動かない」という最も分かりにくい壊れ方**をする。
    expect(directive('connect-src')).toContain(AUTH_CONFIG.loginDomain);
  });

  it('認可サーバのドメインが https:// で始まる（スキーム付きで許可している）', () => {
    expect(AUTH_CONFIG.loginDomain.startsWith('https://')).toBe(true);
  });

  it('**S3 の regional domain 形が connect-src に含まれる**（presigned PUT）', () => {
    // Phase 4 の画像アップロードが CSP で死んでいないことの確認。
    const s3Origins = directive('connect-src').filter((value) =>
      /^https:\/\/[^/]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(value),
    );
    expect(s3Origins).toHaveLength(1);
  });

  it("connect-src に 'self' がある（/api/* は同一オリジン）", () => {
    expect(directive('connect-src')).toContain("'self'");
  });

  it("**script-src に 'wasm-unsafe-eval' がある**（これが無いと shiki が動かない）", () => {
    // admin のバンドルは shiki の oniguruma wasm を base64 で埋め込み、
    // atob してから WebAssembly.instantiate をバッファに対して呼ぶ（実測）。
    // 落とすとプレビューのシンタックスハイライトだけが静かに壊れる。
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it("**script-src に 'unsafe-eval' は無い**（wasm-unsafe-eval とは別物）", () => {
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
  });

  it("**script-src に 'unsafe-inline' は無い**（XSS 緩和の心臓部）", () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it("**style-src に 'unsafe-inline' がある**（Astro のインライン style と shiki の style 属性）", () => {
    expect(directive('style-src')).toContain("'unsafe-inline'");
  });

  it("img-src が 'self' を含む（投稿画像は /media/* 経由の同一オリジン）", () => {
    expect(directive('img-src')).toContain("'self'");
  });
});

describe('**admin は blob: も data: も使っていない**（使い始めたらここが赤くなる）', () => {
  const files = sourceFiles(SRC_DIR);

  it('走査対象が空でない', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    ['blob:', /\bblob:/],
    ['data:', /\bdata:[a-z]/i],
    ['URL.createObjectURL', /createObjectURL/],
  ])('%s が src/ に現れない', (_label, pattern) => {
    const offenders = files.filter((relative) => pattern.test(readFileSync(SRC_DIR + relative, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('検出規則そのものが機能する', () => {
    expect(/\bblob:/.test("img.src = 'blob:https://x/abc';")).toBe(true);
    expect(/\bdata:[a-z]/i.test("img.src = 'data:image/png;base64,...';")).toBe(true);
    expect(/createObjectURL/.test('URL.createObjectURL(file)')).toBe(true);
  });

  it('img-src に blob: も data: も入れていない（要らないので許可しない）', () => {
    expect(directive('img-src')).toEqual(["'self'"]);
  });
});

describe('**SVG をアップロード許可に入れない**', () => {
  it('ALLOWED_CONTENT_TYPES が空でない', () => {
    expect(ALLOWED_CONTENT_TYPES.size).toBeGreaterThan(0);
  });

  it('**image/svg+xml が含まれない**', () => {
    // SVG は /media/* に直接ナビゲートするとサイトのオリジンで**スクリプトを
    // 実行できる文書**として描画される。/media/* にも CSP を付けてはいるが、
    // **入口で塞いでいることのほうが強い。**
    expect(ALLOWED_CONTENT_TYPES.has('image/svg+xml')).toBe(false);
  });

  it('許可されているのはラスタ画像 5 種ちょうど', () => {
    expect([...ALLOWED_CONTENT_TYPES].sort()).toEqual([
      'image/avif',
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('どの許可 type も +xml で終わらない（スクリプトを持てる文書型を入れない）', () => {
    for (const type of ALLOWED_CONTENT_TYPES) {
      expect(type.endsWith('+xml')).toBe(false);
    }
  });
});

describe('**ディレクティブ集合が想定どおり**', () => {
  it('知らないディレクティブが混ざっていない', () => {
    // 将来誰かが 'unsafe-inline' を足したときに「増えたこと」自体が見える。
    const names = CSP.split(';')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name): name is string => name !== undefined && name.length > 0);
    expect(names.sort()).toEqual(
      [
        'base-uri',
        'connect-src',
        'default-src',
        'font-src',
        'form-action',
        'frame-ancestors',
        'frame-src',
        'img-src',
        'object-src',
        'script-src',
        'script-src-attr',
        'style-src',
      ].sort(),
    );
  });

  it("default-src が 'self' である（列挙し忘れが素通しにならない）", () => {
    expect(directive('default-src')).toEqual(["'self'"]);
  });

  it("script-src-attr が 'none' である", () => {
    expect(directive('script-src-attr')).toEqual(["'none'"]);
  });
});
