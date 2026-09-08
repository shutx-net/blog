/**
 * CloudFront が返すセキュリティヘッダの中身。**このファイルは依存ゼロの純粋モジュール。**
 *
 * `aws-cdk-lib` も `constructs` も import しない。理由は `admin` のテストが
 * このファイルを直接 import して「admin が実際に通信する先を CSP が許可しているか」を
 * 突き合わせるためである（`admin/test/unit/csp-contract.test.ts`）。
 * **同じ関数が両方の主張の出所になるので、ディレクティブの取りこぼしが片側だけ起きない。**
 * CDK 側の結線は `site-stack.ts` にある。
 *
 * # 前提: 緩和は CSP のみ。サニタイズはしない
 *
 * admin のプレビューには実在する XSS 経路がある（実測: 実パイプラインが
 * `<img src=x onerror>` / `<a href="javascript:">` / `<svg onload>` を素通しし、
 * `admin/src/editor/bind.ts` がそれを `innerHTML` に入れる）。
 * **それでもサニタイズは採らない。**
 *
 *   - パイプラインで消毒すると `admin/test/parity/published-html.test.ts` の
 *     バイト一致が壊れる。
 *   - `bind.ts` の境界だけで消毒すると「プレビューは安全・公開ページは危険」という
 *     乖離が生まれ、プレビューが本番を再現しなくなる（プレビューの存在理由と衝突する）。
 *
 * **CSP はレスポンスヘッダなので、3 つの一致証明のどれにも触れない。**
 *
 * # 4 つのベクタが CSP でどう塞がるか
 *
 *   1. `<img src=x onerror="alert(1)">` — インラインイベントハンドラ。
 *      `script-src` に `'unsafe-inline'` が無ければブロックされる。
 *      さらに `script-src-attr 'none'` で明示的に閉じている（二重化）。
 *   2. `[click](javascript:alert(1))` — `javascript:` URL。navigation 時の
 *      inline check に掛かり、`'unsafe-inline'` が無ければ許可されない。
 *   3. `<script>alert(2)</script>` — `innerHTML` 経由では HTML 仕様上そもそも
 *      実行されない。加えて CSP でもブロックされる（二重）。
 *   4. `<svg onload=alert(1)>` — 1 と同じ。
 *
 * # 残余リスク（正直に）
 *
 *   - `<meta http-equiv="refresh">` によるリダイレクト（CSP に該当ディレクティブが無い）
 *   - プレビュー枠内の表示なりすまし
 *   - CSS による情報抜き出し（`style-src 'unsafe-inline'` を許す以上ゼロにはできない）
 *
 * **いずれもスクリプト実行を伴わないので、守っている資産（トークン）には届かない。**
 * 送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
 * `'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる。
 *
 * # 配り方: ヘッダ。`<meta http-equiv>` は使わない
 *
 * **`frame-ancestors` は `<meta>` では無視される**（CSP 仕様が明記している）。
 * クリックジャッキング対策を落としたくないのでヘッダ一択。加えて meta は HTML 応答に
 * しか乗らず、パース位置より前のリソースには効かない。
 * **2 箇所で二重管理するとドリフトするので併用もしない。**
 */

export interface CspOrigins {
  /**
   * 認可サーバのオリジン（Managed Login のドメイン）。
   *
   * **これが無いとログインが動かない。** `/oauth2/token` と `/oauth2/revoke` への
   * `fetch` は別オリジンなので、`default-src 'self'` のままだとブロックされる。
   * **物理名を書かず、`UserPoolDomain` から導出すること。**
   */
  readonly cognitoOrigin: string;

  /**
   * メディアバケットのオリジン（`https://<bucket>.s3.<region>.amazonaws.com`）。
   *
   * **これが無いと画像アップロードが壊れる。** presigned PUT は別オリジンへの
   * `fetch` である。**バケットの物理名を書かず、`bucketRegionalDomainName` から
   * 導出すること**（AGENTS.md「物理名をハードコードしない」）。
   */
  readonly mediaOrigin: string;
}

/**
 * `Referrer-Policy` の値。
 *
 * `same-origin` にしているのは、外部サイトへ遷移したときに管理画面の URL
 * （`?code=` が一瞬載りうる）を送らないため。`code` は交換の前に URL から
 * 消しているが、**二重化しておく。**
 */
export const REFERRER_POLICY = 'same-origin';

/**
 * HSTS の max-age（秒）。**1 年。**
 *
 * `includeSubDomains` と `preload` は**付けない。**
 * `*.cloudfront.net` は他人と共有するドメインなので、サブドメイン全体に HSTS を
 * 宣言するのは「自分のものでないホストに対する宣言」になる。preload リストへの
 * 登録は取り消しが難しく、共有ドメインでは特に不可逆な副作用が大きい。
 *
 * **独自ドメインに移ったら、この 2 つを付けるかどうかを改めて決めること**
 * （そのときは自分のドメインなので付けてよい）。
 */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * サイト（HTML / RSS / sitemap / admin）が返す `Cache-Control`。
 *
 * # なぜ必要か
 *
 * **実測で、配信 HTML には `Cache-Control` が 1 つも付いていなかった。**
 * `Cache-Control` も `Expires` も無いと、ブラウザは*ヒューリスティックキャッシュ*を
 * 適用する（一般に `Last-Modified` からの経過時間の 10% 程度）。
 * デプロイ時の invalidation は **CloudFront にしか効かない**ので、
 * 一度サイトを見た人は不定の時間だけ古い HTML を見続ける。
 * **記事を更新したのに反映されない、として実際に踏んだ。**
 *
 * # なぜ `no-cache` か
 *
 * `no-cache` は「キャッシュしてよいが、再利用の前に必ずオリジンで検証せよ」。
 * S3 が ETag を返すので、変わっていなければ 304 が返り本文は流れない。
 * **転送量はほとんど増えない。**
 *
 * `no-store` は 304 による再利用まで禁じるので過剰。
 * `max-age=0, must-revalidate` は実質同義だが、意図が読み取りにくい。
 *
 * # なぜ ResponseHeadersPolicy で付けるのか（S3 のメタデータではなく）
 *
 * AWS は「response headers policy で付けた `Cache-Control` は **viewer response にのみ**
 * 付き、CloudFront がオブジェクトをどうキャッシュするかには影響しない」と明記している。
 * つまり **CDN は DefaultTTL 86400 のまま**で、更新はこれまでどおり invalidation が担う。
 * オリジンへの負荷は増えない。
 *
 * **S3 のオブジェクトメタデータに `no-cache` を書いてはいけない。**
 * 現行のキャッシュポリシー（Managed-CachingOptimized）は MinTTL が 1 で 0 より大きく、
 * AWS の表は「MinTTL > 0 のとき `no-cache` / `no-store` / `private` を無視して
 * MinTTL 分キャッシュする」と明記している。実質 CDN が無効化され、
 * **毎リクエストが S3 に行く。**
 *
 * `aws s3 sync --cache-control` を使わない理由はもう 1 つある。sync の比較は
 * サイズと更新時刻だけで**メタデータを見ない**ので、内容が変わっていないオブジェクトは
 * 取り残される。定義が S3 と CDK の 2 箇所に分かれる問題も伴う。
 */
export const SITE_CACHE_CONTROL = 'no-cache';

/**
 * `/media/*` が返す `Cache-Control`。**1 年 + `immutable`。**
 *
 * 投稿画像のキーは `api/src/media/presign.ts` が
 * `media/<年>/<月>/<randomBytes(12) の 24 桁 hex>.<拡張子>` として作る。
 * **利用者のファイル名を一切使わず、本体がランダムなので同じキーが二度使われない。**
 * 上書きが起きない以上、`immutable`（有効期間中は条件付きリクエストすら送らない）が
 * そのまま成立する。
 *
 * **キーの作り方を変えるなら、ここも一緒に変えること。** 決め打ちのキーや
 * ファイル名由来のキーにした瞬間に、この宣言は嘘になる。
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * CSP を組み立てる。
 *
 * # `'wasm-unsafe-eval'` を消さないこと
 *
 * admin のバンドルは shiki の oniguruma wasm を **base64 で JS チャンクに埋め込み**、
 * `atob` してから `WebAssembly.instantiate` をバッファに対して呼ぶ（実測）。
 * これが無いと **WebAssembly がブロックされ、プレビューのシンタックスハイライトだけが
 * 静かに壊れる**（プレビューと公開ページの見た目が食い違う）。
 * `'wasm-unsafe-eval'` は **WebAssembly だけ**を許し JS の `eval()` は許さないので、
 * XSS 防御は損なわれない。**`'unsafe-eval'` と取り違えないこと。**
 *
 * # `style-src 'unsafe-inline'` を外せない
 *
 * 実測で site/dist にインライン `<style>` が 10 個あり（Astro のスコープ付きスタイル）、
 * shiki はトークンごとに `style="color:#..."` 属性を吐く。厳格な `style-src 'self'` は
 * **両方を壊す。** インラインスタイルはスクリプトを実行しないので、
 * `script-src` の厳格さと引き換えにはならない。
 */
export const buildCsp = (origins: CspOrigins): string =>
  [
    // 列挙し忘れたディレクティブが素通しにならないための土台。
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // 投稿画像は /media/* 経由の同一オリジンなので 'self' で足りる。
    // admin は blob: も data: も使っていない。
    "img-src 'self'",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    `connect-src 'self' ${origins.cognitoOrigin} ${origins.mediaOrigin}`,
  ].join('; ');
