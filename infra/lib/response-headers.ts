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
 * プレビュー枠内の表示なりすまし、CSS による情報抜き出し（`style-src-attr 'unsafe-inline'` を
 * 許す以上ゼロにはできない。`<style>` ブロックは `style-src 'self'` が禁じるので、
 * 経路は `style` 属性だけに狭まった）。いずれもスクリプト実行を伴わないので、守っている資産である
 * トークンには届かない。送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
 * `'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる
 * （そもそも `@import` は属性には書けない）。
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
 * `includeSubDomains` と `preload` は**付けない。独自ドメイン `blog.shutx.net` を alias に
 * 足した時点で改めて決め直した結果として、どちらも据え置く。**理由は 3 つ。
 *
 *   1. **`blog.shutx.net` の下にホストが 1 つも無い。** サブドメインを作るリソースが
 *      このスタックに無いので、`includeSubDomains` には**守る対象が存在しない。** 逆に、
 *      将来 `*.blog.shutx.net` に HTTPS を話せないホストを置いた日には、**ブラウザが
 *      max-age の残り（最大 1 年）だけそこへ平文で到達できなくなる。** 得るものが無く、
 *      失うものだけがある。
 *   2. 親の `shutx.net` は**このスタックの管理外**で、中身も別物（実測 75.2.60.5 /
 *      99.83.190.102 = このディストリビューションではない）。HSTS はヘッダを返した
 *      ホストとその子にしか効かないので `includeSubDomains` を付けても親には及ばないが、
 *      **宣言の射程を自分が面倒を見る範囲に収める**という線は動かさない。
 *   3. `preload` はリストから外す申請が通っても、それがブラウザのリリースに乗るまで
 *      効かない。個人ブログに対して**解除コストだけ**が残る。
 *
 * この 3 つは `infra/README.md` の同名の節にも書いてあり、`infra/test/toolchain.test.ts` が
 * **節を切り出して本文を固定している。** 判断を変えるならテストも一緒に直すことになる。
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
 *
 * **下の `ASTRO_ASSETS_CACHE_CONTROL` と値は同じだが、別の定数である。** 真である条件が
 * 違うので、片方の条件が変わっても他方を巻き込まない（理由はそちらの JSDoc）。
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * `/_astro/*`（Astro がビルドした CSS / JS）が返す `Cache-Control`。1 年 + `immutable`。
 *
 * **真である条件は「同じ URL が二度と別の中身を返さない」こと。** vite は
 * `_astro/<名前>.<内容ハッシュ>.<拡張子>` という名前で出力する（実測は 1 ファイル、
 * `_astro/Layout.3W-5Im-W.css`）。CSS を 1 バイト直せばハッシュが変わって別の URL になり、
 * それを指す HTML は `SITE_CACHE_CONTROL`（`no-cache`）なので必ず検証されて新しい名前が届く。
 * したがって「古い URL を 1 年キャッシュしたまま」でも古いページは生まれない。
 *
 * 前提が 2 つあり、**どちらもこのファイルでは保証できないのでテストが固定している。**
 *
 *   1. **出力先が `_astro` であること。** これは Astro の `build.assets` の既定値
 *      （`astro/dist/core/config/schemas/defaults.js` の `assets: "_astro"`）で、
 *      `site/astro.config.mjs` は `build.assets` も `build.assetsPrefix` も書いていない。
 *      書いた日に CloudFront 側のパターン（`ASTRO_ASSETS_PATH_PATTERN`）に一致しなくなり、
 *      **ヘッダは静かに `no-cache` へ戻る**（何も壊れたように見えない）。
 *      `site/test/unit/stylesheets.test.ts` が両者の不在を主張する。
 *   2. **名前に内容ハッシュが入り、そもそも外部ファイルとして出ること。**
 *      後者は `site/astro.config.mjs` の `build.inlineStylesheets: "never"` が宣言し、
 *      同じ `stylesheets.test.ts` が値を固定する（既定の `"auto"` はビルド後のサイズが
 *      vite の 4096 B を下回ると勝手にインライン化し、`dist/_astro/` が空になる）。
 *      前者は `site/test/build/` が `dist/_astro/` の実ファイル名を走査して主張する。
 *
 * **`MEDIA_CACHE_CONTROL` と同値だが共有しない。** 値が一致しているのは結果で、根拠が別物
 * （メディアは**キーがランダム**で二度使われない / `_astro` は**中身のハッシュ**が名前に入る）。
 * 1 本に寄せると、どちらかの根拠が崩れた日に**両方が参照している宣言**を触ることになり、
 * 無関係なパスのキャッシュ戦略を道連れにする。3 本のポリシーでセキュリティヘッダが
 * 一致していることは `infra/test/distribution-response-headers.test.ts` が別に固定している。
 */
export const ASTRO_ASSETS_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
 * # `style-src` は `'self'` だけ。`'unsafe-inline'` は `style-src-attr` にだけ残す
 *
 * 以前は `style-src 'self' 'unsafe-inline'` だった。理由は 2 つあり、片方ずつ解いた。
 *
 *   1. site/dist の HTML が全件インライン `<style>` を持っていた
 *      （`inlineStylesheets: "always"`）。設定を外して外部
 *      `/_astro/Layout.*.css` にしたので、同一オリジンの `'self'` で足りる。
 *   2. shiki はトークンごとに `style="color:#..."` **属性**を吐く（実測: コードフェンス
 *      2 本の記事 1 件で `style=` 属性 29 個、`<style>` ブロック 0 個）。
 *
 * **CSP3 では `style-src-attr` を明示すると `style` 属性はそちらに支配され、`style-src` に
 * フォールバックしない。** だから 2 は `style-src-attr 'unsafe-inline'` で許すしかない。
 * 逆に `style-src-attr` を**空や `'none'` で**足すと属性が拒否され、コードフェンスの色が飛ぶ。
 *
 * **得られた強化は限定的である。** できるようになったのは `<style>` ブロックの注入を禁じる
 * ことだけで、`style` 属性は許したままだ。インラインスタイルはスクリプトを実行しないので、
 * `script-src` の厳格さと引き換えにはならない。
 *
 * **本番の記事にコードフェンスが無い間、2 の効き目は検証できない。** `style=` 属性が 0 個
 * なので、`style-src-attr` を壊しても既存ページは無症状で通る。色が飛ぶのは記事を書いた日だ。
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
    "style-src 'self'",
    // shiki の `style="color:#..."` 属性のため。`'none'` にすると色が飛ぶ。
    // `script-src-attr 'none'` との非対称は意図的（上の JSDoc）。
    "style-src-attr 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    `connect-src 'self' ${origins.cognitoOrigin} ${origins.mediaOrigin}`,
  ].join('; ');
