/**
 * CloudFront が返すセキュリティヘッダの中身。**依存ゼロの純粋モジュールとして保つこと。**
 *
 * `aws-cdk-lib` も `constructs` も import しないのは、`admin` のテストがこのファイルを
 * 直接読んで「admin が実際に通信する先を CSP が許可しているか」を突き合わせるため
 * （`admin/test/unit/csp-contract.test.ts`）。同じ関数が両方の主張の出所になるので、
 * ディレクティブの取りこぼしが片側だけ起きない。CDK 側の結線は `site-stack.ts`。
 *
 * # 緩和は CSP のみ。サニタイズはしない
 *
 * admin のプレビューには実在する XSS 経路がある（実測: 実パイプラインが
 * `<img src=x onerror>` / `<a href="javascript:">` / `<svg onload>` を素通しし、
 * `admin/src/editor/bind.ts` がそれを `innerHTML` に入れる）。それでもサニタイズは採らない。
 *
 *   - パイプラインで消毒すると `admin/test/parity/published-html.test.ts` のバイト一致が壊れる。
 *   - `bind.ts` の境界だけで消毒すると「プレビューは安全・公開ページは危険」という乖離が生まれ、
 *     プレビューが本番を再現しなくなる（プレビューの存在理由と衝突する）。
 *
 * **CSP はレスポンスヘッダなので、3 つの一致証明のどれにも触れない。**
 *
 * 実測した 4 つのベクタのうち、`<img src=x onerror="alert(1)">` と `<svg onload=alert(1)>`
 * （インラインイベントハンドラ）と `[click](javascript:alert(1))`（navigation 時の inline check）は
 * `script-src` に `'unsafe-inline'` が無いことで止まる。前者は `script-src-attr 'none'` で
 * 二重化している。`<script>alert(2)</script>` は `innerHTML` 経由では HTML 仕様上実行されない。
 *
 * 残るのは `<meta http-equiv="refresh">` によるリダイレクト（CSP に該当ディレクティブが無い）、
 * プレビュー枠内の表示なりすまし、CSS による情報抜き出し（`style-src 'unsafe-inline'` を
 * 許す以上ゼロにはできない）。いずれもスクリプト実行を伴わないので、守っている資産である
 * トークンには届かない。送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
 * `'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる。
 *
 * # `<meta http-equiv>` では配らない
 *
 * **`frame-ancestors` は `<meta>` では無視される**（CSP 仕様が明記している）。加えて meta は
 * HTML 応答にしか乗らず、パース位置より前のリソースには効かない。2 箇所で二重管理すると
 * ドリフトするので併用もしない。
 */

export interface CspOrigins {
  /**
   * 認可サーバのオリジン（Managed Login のドメイン）。
   *
   * 無いとログインが動かない。`/oauth2/token` と `/oauth2/revoke` への `fetch` は
   * 別オリジンなので `default-src 'self'` では届かない。
   * **物理名を書かず `UserPoolDomain` から導出すること。**
   */
  readonly cognitoOrigin: string;

  /**
   * メディアバケットのオリジン（`https://<bucket>.s3.<region>.amazonaws.com`）。
   *
   * 無いと画像アップロードが壊れる。presigned PUT は別オリジンへの `fetch` である。
   * **物理名を書かず `bucketRegionalDomainName` から導出すること**
   * （AGENTS.md「物理名をハードコードしない」）。
   */
  readonly mediaOrigin: string;
}

/**
 * `Referrer-Policy` の値。
 *
 * 外部サイトへ遷移したときに管理画面の URL（`?code=` が一瞬載りうる）を送らないため。
 * `code` は交換の前に URL から消しているが、二重化しておく。
 */
export const REFERRER_POLICY = 'same-origin';

/**
 * HSTS の max-age（秒）。1 年。
 *
 * `includeSubDomains` と `preload` は**付けない。** `*.cloudfront.net` は他人と共有する
 * ドメインなので、サブドメイン全体への HSTS 宣言は「自分のものでないホストに対する宣言」に
 * なる。preload リストへの登録は取り消しが難しく、共有ドメインでは特に不可逆。
 *
 * **独自ドメインに移ったら、この 2 つを付けるか改めて決めること**（そのときは自分のドメイン）。
 */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * サイト（HTML / RSS / sitemap / admin）が返す `Cache-Control`。
 *
 * **実測で、配信 HTML には `Cache-Control` が 1 つも付いていなかった。** `Cache-Control` も
 * `Expires` も無いと、ブラウザは*ヒューリスティックキャッシュ*を適用する（一般に
 * `Last-Modified` からの経過時間の 10% 程度）。デプロイ時の invalidation は CloudFront に
 * しか効かないので、一度サイトを見た人は不定の時間だけ古い HTML を見続ける。
 * **記事を更新したのに反映されない、として実際に踏んだ。**
 *
 * `no-cache` は「キャッシュしてよいが、再利用の前に必ずオリジンで検証せよ」。S3 が ETag を
 * 返すので、変わっていなければ 304 が返り本文は流れず、転送量はほとんど増えない。
 * `no-store` は 304 による再利用まで禁じるので過剰、`max-age=0, must-revalidate` は
 * 実質同義だが意図が読み取りにくい。
 *
 * # ResponseHeadersPolicy で付ける。S3 のメタデータではなく
 *
 * AWS は「response headers policy で付けた `Cache-Control` は **viewer response にのみ**
 * 付き、CloudFront がオブジェクトをどうキャッシュするかには影響しない」と明記している。
 * CDN は DefaultTTL 86400 のままで、更新はこれまでどおり invalidation が担う。
 *
 * **S3 のオブジェクトメタデータに `no-cache` を書いてはいけない。** 現行のキャッシュポリシー
 * （Managed-CachingOptimized）は MinTTL が 1 で 0 より大きく、AWS の表は「MinTTL > 0 のとき
 * `no-cache` / `no-store` / `private` を無視して MinTTL 分キャッシュする」と明記している。
 * 実質 CDN が無効化され、毎リクエストが S3 に行く。
 *
 * `aws s3 sync --cache-control` も使わない。sync の比較はサイズと更新時刻だけで
 * **メタデータを見ない**ので内容が変わっていないオブジェクトが取り残されるうえ、
 * 定義が S3 と CDK の 2 箇所に分かれる。
 */
export const SITE_CACHE_CONTROL = 'no-cache';

/**
 * `/media/*` が返す `Cache-Control`。1 年 + `immutable`。
 *
 * 投稿画像のキーは `api/src/media/presign.ts` が
 * `media/<年>/<月>/<randomBytes(12) の 24 桁 hex>.<拡張子>` として作る。利用者のファイル名を
 * 一切使わず本体がランダムなので、同じキーが二度使われない。上書きが起きない以上、
 * `immutable`（有効期間中は条件付きリクエストすら送らない）がそのまま成立する。
 *
 * **キーの作り方を変えるなら、ここも一緒に変えること。** 決め打ちのキーやファイル名由来の
 * キーにした瞬間に、この宣言は嘘になる。
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * CSP を組み立てる。
 *
 * **`'wasm-unsafe-eval'` を消さないこと。** admin のバンドルは shiki の oniguruma wasm を
 * base64 で JS チャンクに埋め込み、`atob` してから `WebAssembly.instantiate` をバッファに
 * 対して呼ぶ（実測）。これが無いと WebAssembly がブロックされ、**プレビューの
 * シンタックスハイライトだけが静かに壊れる**（プレビューと公開ページの見た目が食い違う）。
 * `'wasm-unsafe-eval'` は WebAssembly だけを許し JS の `eval()` は許さないので XSS 防御は
 * 損なわれない。`'unsafe-eval'` と取り違えないこと。
 *
 * **`style-src 'unsafe-inline'` は外せない。** site/dist の HTML は全件がインライン
 * `<style>` を持ち（`inlineStylesheets: "always"`）、shiki はトークンごとに
 * `style="color:#..."` 属性を吐く。厳格な `style-src 'self'` は両方を壊す。インライン
 * スタイルはスクリプトを実行しないので、`script-src` の厳格さと引き換えにはならない。
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
