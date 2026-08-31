import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const REWRITE_URI = fileURLToPath(
  new URL('../../../infra/functions/rewrite-uri.js', import.meta.url),
);

/**
 * `dist` は pretest（`npm run build`）が作る。api の test/build/bundle.test.ts と同じ形。
 */
const indexHtml = (): string => readFileSync(`${DIST}index.html`, 'utf8');

/** index.html が参照する src / href をすべて集める。 */
const referencedUrls = (html: string): string[] => [
  ...[...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? ''),
];

const allFiles = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );

/**
 * **CloudFront Function の実物を読み込む。**
 *
 * `infra/functions/rewrite-uri.js` は CloudFront Functions のランタイム向けなので
 * ES モジュールではなく素のスクリプト（`function handler(event)` だけがあり
 * export が無い）。写しを書くと「片方だけ直した」が検出できなくなるので、
 * 実ファイルを読んで評価する。
 */
const loadRewriteHandler = (): ((event: { request: { uri: string } }) => { uri: string }) => {
  const source = readFileSync(REWRITE_URI, 'utf8');
  const factory = new Function(`${source}\nreturn handler;`) as () => (event: {
    request: { uri: string };
  }) => { uri: string };
  return factory();
};

const rewrite = (uri: string): string => loadRewriteHandler()({ request: { uri } }).uri;

describe('ビルド成果物が存在する', () => {
  it('dist/index.html がある', () => {
    expect(
      existsSync(`${DIST}index.html`),
      'dist が無い。pretest（npm run build）が先に走る必要がある',
    ).toBe(true);
  });
});

describe('**アセット URL がすべて /admin/ 始まりである**', () => {
  const urls = referencedUrls(indexHtml());

  it('参照している URL の集合が空でない', () => {
    // 空だと下の every が 0 周で緑になる。
    expect(urls.length).toBeGreaterThan(0);
  });

  it.each(urls)('%s が /admin/ で始まる', (url) => {
    // 1 件でも相対や /assets/ になっていると、/admin/ 配下から
    // **site バケットのルート**を取りにいって 404 になる。
    expect(url.startsWith('/admin/')).toBe(true);
  });

  it('参照先のファイルが実在する', () => {
    for (const url of urls) {
      const relative = url.replace(/^\/admin\//, '');
      expect(existsSync(DIST + relative), `${url} の実体が dist に無い`).toBe(true);
    }
  });
});

describe('**CloudFront の URI 書き換えと整合する**', () => {
  it('/admin が /admin/index.html に解決する', () => {
    expect(rewrite('/admin')).toBe('/admin/index.html');
  });

  it('/admin/ が /admin/index.html に解決する', () => {
    expect(rewrite('/admin/')).toBe('/admin/index.html');
  });

  it.each(referencedUrls(indexHtml()))('アセット %s は書き換えられない', (url) => {
    // 最終セグメントにドットがあるので静的ファイルとして素通しされる。
    expect(rewrite(url)).toBe(url);
  });

  it('書き換え関数が実際に動いている（常に恒等ではない）', () => {
    // 上の 2 種類が両方素通しだと「関数が何もしていない」形でも緑になる。
    expect(rewrite('/admin')).not.toBe('/admin');
  });
});

describe('生成物の衛生', () => {
  it('**インラインの <script> が無い**（CSP を後から掛けられる形を保つ）', () => {
    const html = indexHtml();
    // src を持たない <script> ... </script> を探す。
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
      (match) => (match[1] ?? '').trim().length > 0,
    );
    expect(inline.map((match) => match[0])).toEqual([]);
  });

  it('index.html と eager アセットに開発サーバの URL が焼き込まれていない', () => {
    // 遅延チャンク（shiki の言語文法 300 本）は走査しない — 自分で書いた
    // コードではないうえ、文法定義に含まれる文字列で誤検出しうる。
    //
    // **裸の 'localhost' では探さない。** unified の依存（vfile）が引き込む
    // node:url のシムに `File URL host must be "localhost" or empty on darwin`
    // というエラーメッセージが入っており、常に一致してしまう（実測）。
    // 検出したいのは「開発時のオリジンがビルドに焼き込まれた」ことなので、
    // **URL の形**で探す。
    const DEV_ORIGIN = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/;
    const targets = [
      `${DIST}index.html`,
      ...referencedUrls(indexHtml()).map((url) => DIST + url.replace(/^\/admin\//, '')),
    ];
    expect(targets.length).toBeGreaterThan(1);
    for (const path of targets) {
      const match = DEV_ORIGIN.exec(readFileSync(path, 'utf8'));
      expect(match?.[0], `${path} に開発サーバの URL が入っている`).toBeUndefined();
    }
  });

  it('開発サーバ URL の検出規則そのものが機能する', () => {
    // 上のテストは「見つからないこと」を主張するので、規則が壊れていても
    // 緑になる。**規則が実際に検出できることを別に確かめる。**
    const DEV_ORIGIN = /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/;
    expect(DEV_ORIGIN.test('fetch("http://localhost:5173/api")')).toBe(true);
    expect(DEV_ORIGIN.test('fetch("//127.0.0.1/api")')).toBe(true);
    expect(DEV_ORIGIN.test('File URL host must be "localhost" or empty')).toBe(false);
  });

  it('**eager チャンクに client_secret の綴りが無い**', () => {
    // public client なので secret は存在しない。**将来書き込む誤りを
    // ビルド成果物の側から落とす**（このリポジトリは public である）。
    const targets = [
      `${DIST}index.html`,
      ...referencedUrls(indexHtml()).map((url) => DIST + url.replace(/^\/admin\//, '')),
    ];
    expect(targets.length).toBeGreaterThan(1);
    for (const path of targets) {
      expect(readFileSync(path, 'utf8'), `${path} に client_secret が入っている`).not.toContain(
        'client_secret',
      );
    }
  });

  it('**バンドルに Web Storage を触るコードが載っている**', () => {
    // test/unit/auth-seam.test.ts の走査は「1 ファイルにしか書かれていない」しか
    // 言わない。**実際にバンドルへ載っていることは別の主張**である。
    // 載っていなければ、下書きもセッションもリダイレクトを越えられない。
    const entries = referencedUrls(indexHtml())
      .filter((url) => url.endsWith('.js'))
      .map((url) => readFileSync(DIST + url.replace(/^\/admin\//, ''), 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((source) => source.includes('sessionStorage'))).toBe(true);
  });

  it('**ビルド成果物にインラインイベントハンドラ属性が無い**', () => {
    // `script-src-attr 'none'` が既存の何も壊さないことの確認。
    // ここが赤くなったら「CSP がその機能を殺す」の予告になる。
    const html = indexHtml();
    const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)].map((match) => match[0]);
    expect(handlers).toEqual([]);
  });

  it('インラインイベントハンドラの検出規則そのものが機能する', () => {
    // 上は「無いこと」の主張なので、規則が壊れていても緑になる。
    const pattern = /\son[a-z]+\s*=\s*["']/gi;
    expect(pattern.test('<img src=x onerror="alert(1)">')).toBe(true);
  });

  it('**javascript: で始まる href / src がビルド成果物に無い**', () => {
    expect(indexHtml()).not.toMatch(/(?:href|src)\s*=\s*["']\s*javascript:/i);
  });

  it('index.html に noindex が入っている', () => {
    // 認証が入るまで /admin/ の外殻は公開状態で見える。
    // robots.txt への Disallow は site 側への hand-off。
    expect(indexHtml()).toContain('noindex');
  });
});

/**
 * **site/dist にも同じ invariant を張る。**
 *
 * CSP はデフォルトビヘイビア経由で **site と admin の両方**に付く。
 * admin だけ調べても「CSP がサイトを壊す」は捕まらない。
 * `pretest` が `npm run build -w ../site` を先に走らせるので site/dist は存在する。
 */
describe('**CSP がサイトを壊さないことの静的確認（site/dist）**', () => {
  const SITE_DIST = fileURLToPath(new URL('../../../site/dist/', import.meta.url));

  const htmlFiles = (): string[] =>
    allFiles(SITE_DIST)
      .filter((relative) => relative.endsWith('.html'))
      .map((relative) => SITE_DIST + relative);

  it('site/dist に HTML がある（走査が空振りしていない）', () => {
    expect(existsSync(SITE_DIST), 'site/dist が無い。pretest が site をビルドする').toBe(true);
    expect(htmlFiles().length).toBeGreaterThan(0);
  });

  it('**インライン <script> が 0 件**（script-src に unsafe-inline を入れずに済む）', () => {
    const offenders = htmlFiles().filter((path) => {
      const html = readFileSync(path, 'utf8');
      return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].some(
        (match) => (match[1] ?? '').trim().length > 0,
      );
    });
    expect(offenders.map((path) => path.replace(SITE_DIST, ''))).toEqual([]);
  });

  it('**インラインイベントハンドラ属性が 0 件**（script-src-attr none が何も壊さない）', () => {
    const offenders = htmlFiles().filter((path) =>
      /\son[a-z]+\s*=\s*["']/i.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((path) => path.replace(SITE_DIST, ''))).toEqual([]);
  });

  it('**javascript: で始まる href / src が 0 件**', () => {
    const offenders = htmlFiles().filter((path) =>
      /(?:href|src)\s*=\s*["']\s*javascript:/i.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((path) => path.replace(SITE_DIST, ''))).toEqual([]);
  });

  it('**インライン <style> は実在する**（style-src の unsafe-inline が要る根拠）', () => {
    // ここが 0 件になったら 'unsafe-inline' を外せる合図。
    // **外せる根拠が消えたことに気づけるようにしておく。**
    const withStyle = htmlFiles().filter((path) => /<style[^>]*>/i.test(readFileSync(path, 'utf8')));
    expect(withStyle.length).toBeGreaterThan(0);
  });

  it('**外部オリジンのスクリプト参照が無い**（script-src self で足りる）', () => {
    const offenders = htmlFiles().filter((path) =>
      /<script[^>]*\ssrc=["']https?:\/\//i.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((path) => path.replace(SITE_DIST, ''))).toEqual([]);
  });
});

describe('dist の規模', () => {
  const files = allFiles(DIST);

  it('ファイル数が 0 でない', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('**ファイル数が 600 を超えない**', () => {
    // shiki の言語文法が遅延チャンクとして 300 本前後出る（実測 311 ファイル /
    // 11 MB）。**言語を絞る最適化はしない** — 絞った言語のコードフェンスが
    // site では色付き / admin では plaintext になり、プレビュー一致が壊れる。
    // 桁が変わったら aws s3 sync のオブジェクト数と CloudFront の無効化を
    // 見直す合図なので、上限をテストに埋めてある。
    expect(files.length).toBeLessThanOrEqual(600);
  });

  it('eager に読むエントリが 1 MB を超えない（raw）', () => {
    // 最初に必ず読むチャンク。実測 617,715 B / 192,068 B gzip。
    // shiki の wasm（622,325 B）は**最初のコードフェンスまで読まれない**ので
    // ここには入らない。
    const entry = referencedUrls(indexHtml())
      .filter((url) => url.endsWith('.js'))
      .map((url) => statSync(DIST + url.replace(/^\/admin\//, '')).size);
    expect(entry.length).toBeGreaterThan(0);
    for (const size of entry) {
      expect(size).toBeLessThan(1024 * 1024);
    }
  });
});
