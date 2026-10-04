# 配信とキャッシュ

## 配信の実測値（2026-10-03）

PSI の指摘 2 件（「レンダリングをブロックしているリクエスト」「ネットワークの依存関係ツリー」）を
裁定するために測ったもの。**裁定そのものはこのファイルの
「CSS をインライン化しない」「HTTP/3 を有効にする」「`/_astro/*` は immutable…」の 3 節**にある。

計測対象は本番 `https://blog.shutx.net`。DNS は Cloudflare だが **grey cloud（DNS only）** を
実測で確認済みなので、前段に別の CDN は無い。

| 項目 | 値 |
| --- | --- |
| HTML `/` | wire **736 B** / raw 2114 B |
| CSS `/_astro/Layout.3W-5Im-W.css` | wire **1846 B** / raw 6741 B |
| 圧縮方式の推定 | 手元の brotli q11 = 1750 B / **q5 = 1858 B** / gzip -9 = 2005 B。**配信は概ね brotli q5 相当** |
| `Compress` | **全ビヘイビアで `true`**（テンプレート実測）。やることは残っていない |
| `Vary` | `Accept-Encoding`（CloudFront が圧縮時に付けるもので正しい） |
| ページ構成 | `<script>` 0 本 / webfont 0 本 / `<style>` 0 本。**`site/public/` 自体が存在せず favicon も無い**ので、リクエストは **HTML と CSS の 2 本だけ** |
| TLS | TLSv1.3 / X25519 / `TLS_AES_128_GCM_SHA256`。証明書は **RSA 2048**（`Amazon RSA 2048 M04`、チェーン PEM 5270 B） |
| `x-cache` | `Hit from cloudfront` 5/5（連続取得）。`x-amz-cf-pop` は国内 POP（実測で `NRT57-P9` / 再測定では `KIX82-P7`。POP は経路と時刻で変わる） |

デプロイの前後で変わったもの（**後者はすべてデプロイ後の実測**）:

| | デプロイ前 | デプロイ後 |
| --- | --- | --- |
| `alt-svc` | **無し** | `h3=":443"; ma=86400` |
| DNS の HTTPS(SVCB) RR | `1 . alpn="h2"` | 直後は `1 . alpn="h2"` のまま、**約 25 分後に `1 . alpn="h2,h3"`**（TTL 60 秒。3 リゾルバで一致） |
| `/` の `Cache-Control` | `no-cache` | `no-cache`（据え置き） |
| `/_astro/*.css` の `Cache-Control` | `no-cache`（ETag 付きの条件付き GET で**毎ナビゲーション 304**） | **`public, max-age=31536000, immutable`** |
| 存在しない `/_astro/*` | — | `HTTP/2 404` + **`cache-control: no-cache`**（懸念していた故障モードは不成立） |
| セキュリティヘッダ 5 本 | — | CSP / HSTS / `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` が **`/` と `/_astro/*` でバイト一致**。差は `Cache-Control` だけ |

**HTTP/3 で確認したのは `alt-svc` の広告までで、QUIC の実接続は未確認である。** 理由と、
DNS の RR が `h2,h3` に変わったことから出てくる宿題は「HTTP/3 を有効にする」の節にある。

タイミングの実測（国内から、デプロイ後）: HTML 単発の ttfb 96〜106 ms（デプロイ前 87 ms。誤差の範囲）、
CSS 単発 82〜91 ms、同一接続で連続取得すると HTML 93.2 ms -> **CSS 20.8 ms**。
**インライン化で消えるはずだった往復の実額はこの 21 ms** で、PSI のスコアを作る Lantern では
初期輻輳ウィンドウに収まるため **0 ms** と計上される。

**Lighthouse 13.5.0 の `core/config/default-config.js` を直接読んだ結果**:
`render-blocking-insight`（:441）/ `network-dependency-tree-insight`（:440）/ `cache-insight`（:427）は
**3 つとも weight 0**。パフォーマンススコアは FCP 10（:419）/ LCP 25（:420）/ TBT 30（:421）/
CLS 25（:422）/ SI 10（:423）だけで構成される。**この 3 件をどう直してもスコアは動かない。**

### `/_astro/*` は immutable、`/admin/assets/*` は no-cache

`/_astro/*` だけが `public, max-age=31536000, immutable` を返す（`ASTRO_ASSETS_CACHE_CONTROL`）。
サイトの他のすべては `no-cache` のままである（AGENTS.md の「Cache-Control」）。

**真である条件は「同じ URL が二度と別の中身を返さない」こと。** vite は
`_astro/<名前>.<内容ハッシュ>.<拡張子>` という名前で出力する（実測は 1 ファイル、
`/_astro/Layout.3W-5Im-W.css`）。CSS を 1 バイト直せばハッシュが変わって**別の URL**になり、
それを指す HTML は `no-cache` なので必ず検証されて新しい名前が届く。したがって古い URL を
1 年キャッシュしたままでも、古い見た目のページは生まれない。

前提は 3 つあり、**どれも CloudFront 側では保証できない。** 崩れても何も壊れたようには見えず、
ヘッダが静かに `no-cache` へ戻る（あるいは配るものが無くなる）だけなので、テストで固定してある。

| 前提 | 固定しているもの |
| --- | --- |
| 出力先が `_astro`（Astro の `build.assets` の既定値） | `site/test/unit/stylesheets.test.ts`（設定オブジェクトの値を読む）と `test/distribution-assets-behavior.test.ts`（`site/astro.config.mjs` をテキスト走査し、コメント行を落としてから `assets:` / `assetsPrefix:` の不在を見る）。**CDN の宣言とあの設定ファイルを結び付けているのは後者だけ** |
| そもそも外部ファイルとして出ること（`build.inlineStylesheets: "never"`） | 同じ 2 本（下の「CSS をインライン化しない」） |
| 名前に内容ハッシュが入っていること | `site/test/build/` が `dist/_astro/` の実ファイル名を走査する |

**`/admin/assets/*` は含まれない。** `admin/vite.config.ts` が `base: '/admin/'` を宣言するので
出力は `/admin/assets/*`（実測 391 ファイル）で、`/_astro/*` にはパターンとして一致しない。
admin の資産はデフォルトビヘイビア経由の `no-cache` のままで、それは意図した判断である
（`/admin/*` 専用のビヘイビアは作らない。`infra/docs/security-headers.md`）。

**ポリシーは 3 本目を新設した。`MediaHeaders` を使い回していない。** 値は同じだが**真である条件が
違う**（メディアは**キーがランダム**で二度使われない / `_astro` は**中身のハッシュ**が名前に入る）。
1 本に寄せると、どちらかの条件が崩れた日に両方が参照している宣言を触ることになり、無関係なパスの
キャッシュ戦略を道連れにする。定数も `MEDIA_CACHE_CONTROL` と別に置いてある（`response-headers.ts`）。

**エッジの TTL は既定の Managed-CachingOptimized（`658327ea-...`、DefaultTTL 86400）のまま。**
独自キャッシュポリシーで 1 年にもできるが、閲覧者に届く `Cache-Control` を決めるのは
ResponseHeadersPolicy のほうで、違いは「POP ごとに 1 日 1 回 S3 まで検証に行くかどうか」だけ。
閲覧者から見える差は無く、リソースと概念が 1 つ増える。

#### 懸念していた故障モードは起きない（実測で確認した）

`CustomErrorResponses` はディストリビューション全体に効く（ビヘイビア単位ではない）ので、
**存在しない `/_astro/*` の 404 に `immutable` が乗るなら**、`aws s3 sync --delete` と invalidation の
間に古い HTML を受け取った閲覧者が、消えた旧 CSS の URL を最大 1 年ぶん「無い」と覚えうる。
デプロイ後に測った結果、**そうはならない。**

```sh
curl -sI https://blog.shutx.net/_astro/does-not-exist.css
# => HTTP/2 404 / content-type: text/html / cache-control: no-cache
curl -sI https://blog.shutx.net/media/           # 対照: /media/* に一致するが鍵が無い
# => HTTP/2 404 / content-type: text/html / cache-control: no-cache
```

**CloudFront はエラーページの差し替えに、要求が一致したビヘイビアではなく
デフォルトビヘイビアの ResponseHeadersPolicy を当てる。** `/404.html` は `/media/*` にも
`/_astro/*` にも一致しないオブジェクトなので、ヘッダもデフォルト側の `no-cache` に従う。

したがって残るのは `/media/*` が今日すでに持っている性質と同じもの（存在しない資産には HTML の
404 が返る）で、1 パス増えただけである。被害はその 1 回の表示が素のままになることだけで、HTML が
`no-cache` なので次のナビゲーションで新しいファイル名を取りに行って自然に治る。

**これはテンプレートからは読み取れない**（`CustomErrorResponses` にヘッダの話は書かれていない）。
**固定しているのはテストではなく上の 1 回の観測だけ**なので、ヘッダの付き方を触る変更を入れる
ときは同じ `curl` を打ち直すこと。同じ内容は `site-stack.ts` の `ASTRO_ASSETS_PATH_PATTERN` の
JSDoc にも書いてある。

#### 得られたもの（PSI のスコアは動かない）

- **実訪問者の毎ナビゲーションから条件付き GET が 1 本消える。** 有効化前の `/_astro/*.css` は
  `no-cache` で、ETag 付きの再検証が毎回走って 304 が返っていた（実測）。
- PSI の `cache-insight` が黙る（`Stylesheet` は `STATIC_RESOURCE_TYPES` に含まれ、`no-cache` は
  ttl 0 と判定される。`trace_engine` の `insights/Cache.js` / `helpers/Network.js:31-37` を読んで確認）。
- **ラボスコアは 1 点も動かない。** PSI は必ずクリーンプロファイル（cold）で読むのでキャッシュの
  恩恵を受けず、そもそも `cache-insight` は Lighthouse 13.5.0 の
  `core/config/default-config.js:427` で **weight 0** である。

### CSS をインライン化しない

`site/astro.config.mjs` が `build.inlineStylesheets: "never"` を宣言している。**CSP の
`style-src 'self'` はインライン `<style>` を拒否する**ので、インライン化はそのまま
「全ページのスタイルが当たらない」になる。

**既定の `"auto"` は危ない。** vite の `assetsInlineLimit`（既定 4096 B、`shouldInlineAsset` は
`Buffer.byteLength < 4096` の厳密比較）を下回ると Astro が勝手にインライン化する。実測で再現した:
ビルド後の CSS を 3643 B にして `"auto"` でビルドすると **13/13 の HTML がインライン `<style>` を
持ち、`<link rel=stylesheet>` は 0 本、`dist/_astro/` は空**になった。本番ならこれは
`style-src 'self'` に全ページまとめてブロックされる状態である。

いまの余裕は **2645 B**（実測 2026-10-03）。

| 対象 | サイズ |
| --- | --- |
| `site/src/styles/global.css` のルール | 8438 B（コメントを除いた実体。これが minify されて下の行になる） |
| ビルド後 `/_astro/Layout.3W-5Im-W.css` | **6741 B**（4096 B まで 2645 B） |
| 同・配信時（brotli） | **1846 B** |

**`global.css` のソースサイズは比較に一度も登場しないので、ここには意図的に記録しない**
（コメントを 1 行足すたびに腐る。実際この表の値は作業中に 2 度動いた）。コメントを削っても
4096 B に 1 バイトも近づかないし、逆に「コメントが多いから安全」でもない — 効くのは
minify 後の 6741 B だけである。

**サイズ依存の偶然の不変条件を、宣言された不変条件に置き換えたことが要点。** 「いまは 4096 B を
超えているから外部ファイルになる」ではなく「決してインライン化しない」と書いた。今日のサイズでは
出力は 1 バイトも変わらない（`diff -r` で確認済み）。**買ったのはバイトではなく不変条件**であり、
副作用として `/_astro/*` のビヘイビアが将来も意味を持ち続ける。

#### 落ちるテストと、原因を名指しするテスト

- `site/test/unit/stylesheets.test.ts` — `build.inlineStylesheets` の値を直接主張する。**原因を名指しする**
- `test/distribution-assets-behavior.test.ts` — `site/astro.config.mjs` をテキスト走査して同じ値を
  主張する。**原因を名指しする**（こちらだけが CDN 側の宣言と結び付いている）
- `admin/test/build/output.test.ts` — `site/dist` を走査してインライン `<style>` が **0 件**で
  あることを要求する（admin の pretest が site をビルドするので成立する）。**結果は見えるが
  原因は名指しできない**。しかも `"auto"` のままだと、ビルド後の CSS が 4096 B を割る日まで緑でいる
- `site/test/build/output.test.ts` の `it('emits exactly one stylesheet')` — **これは別の故障
  モードの見張りである。** ページに scoped な `<style>` を書いても `"never"` の下ではインラインに
  ならず、astro は **2 本目の外部スタイルシート**として出す。実測（`about.astro` に scoped
  `<style>` を足してビルド）: `_astro/about.DkpeXflv.css` **53 B** が増え、インライン `<style>` は
  **0 件のまま**で、上の admin のガードは**通る**。赤くなるのはこの 1 本だけだった。
  **つまり scoped `<style>` を捕まえているのは `admin/test/build/output.test.ts` ではない。**
- `site/test/build/output.test.ts` の**目次テスト 7 本**も、`"always"` へ戻すと赤くなる。ただし
  落ち方が紛らわしい: あれは目次を出さないページ（見出しの無い記事・`about` / `privacy`・一覧・
  タグ）に `post__toc` が出ていないことを `not.toContain` で見ているので、**インラインされた
  CSS 本文に含まれる `.post__toc` セレクタに当たって**落ちる。読めるメッセージは「そのページに
  目次が漏れた」であって、インライン化は名前に出てこない（実測）。`"never"` はこの 7 本にとっても
  荷重がかかっているが、**原因を正しく名指しするのは上の 2 本だけである**

#### インライン化で得られる時間は 0 ms（だから CSP を緩める案は全部却下した）

PSI が指摘する「レンダリングをブロックしているリクエスト」= `render-blocking-insight` と
「ネットワークの依存関係ツリー」= `network-dependency-tree-insight` は、Lighthouse 13.5.0 の
`core/config/default-config.js` で **どちらも weight 0**（:441 / :440。スコアの内訳は上の
「配信の実測値」）。**この 2 件を消してもパフォーマンススコアは 1 点も動かない。**

動きうるのは FCP / LCP の実数だが、PSI mobile のそれは Lantern が算出する。Lantern の実モジュール
（`@paulirish/trace_engine` 0.0.65 の `TCPConnection`）を rtt 150 ms / 1.6 Mbps で**実行して**測った:

- HTML 736 B（cold, TLS）= 450 ms。初期輻輳ウィンドウ 10 x 1460 = 14600 B のうち **13864 B が余る**
- CSS 1846 B（warm h2, 同一オリジン）= **0 ms**（余りに収まるので `timeToFirstByte` も
  ダウンロードのラウンドトリップも 0）

**つまりスコアを作っているモデルの中で、render-blocking な CSS は既に 0 ms である。**
国内の実機で同一接続の連続取得を測ると CSS の ttfb は 20.8 ms（HTML 93.2 ms の後）で、
インライン化で消えるのはこの 1 往復ぶんだけ。報告される `118 ms` / `351 ms` は観測値であって
スコアの入力ではない（simulated throttling では実リクエストは絞られない）。

却下した案と理由:

| 案 | 却下理由 |
| --- | --- |
| `"always"` + `style-src` に `'unsafe-inline'` を戻す | 文書化された強化の巻き戻し。`admin/test/unit/csp-contract.test.ts` と `admin/test/build/output.test.ts` が落ちる |
| `"always"` + sha256 ハッシュを CDK の CSP に入れる | **致命的。** ハッシュは CDK（`cdk deploy`、人間が実行）に載り、CSS は `deploy.yml`（自動）で出る。**CSS を 1 バイト変えた次のデプロイで、人が `cdk deploy` を打つまで全ページが素のままになる。** CI で更新する道も無い — デプロイロールは S3 の 4 アクション + `cloudfront:CreateInvalidation` / `GetInvalidation` だけで、`cloudfront:Update*` を足すと **CI ロールが CDN のセキュリティ設定を書けるようになる** |
| Astro の `security.csp`（6.0.0 で正式化。astro 7.2.9 が入っている） | 出力が `<meta http-equiv>` **のみ**で、このリポジトリが明文で禁じている形（`frame-ancestors` が meta では無視され、2 箇所でドリフトする）。加えて Astro 自身が *"Shiki isn't currently supported. By design, Shiki functions use inline styles that cannot work with Astro CSP implementation."* と書いている（`astro/dist/types/public/config.d.ts:751`）。そして **CSP は複数ポリシーの AND** なので、meta にハッシュを入れてもヘッダ側の `style-src 'self'` が別途ブロックする。**解決しない** |
| 手書きの `<meta>` CSP | 同上（meta では配らない） |
| viewer-response の CloudFront Function でハッシュを足す | ハッシュが関数コード（infra 側）に載るので sha256 案と同じ時限爆弾。origin-response の Lambda@Edge で本文から計算する案は、`test/distribution-behavior.test.ts` が「どのビヘイビアも Lambda@Edge を使っていない」を全走査で固定している |
| CDK の custom header で `Link: </_astro/...css>; rel=preload` | ファイル名にハッシュが入るので同型（失敗は軽く、無駄な preload 1 本で描画は壊れない）。だが得られる時間は Lantern で 0 ms、実機でも `<link>` は HTML の先頭パケット（raw 2114 B）内で既に発見済み |

### HTTP/3 を有効にする

`httpVersion: HttpVersion.HTTP2_AND_3` を**明示**している。**既定は `http2`** で、しかも
aws-cdk-lib 2.267.0 は `props.httpVersion ?? HttpVersion.HTTP2` と書くので、**この 1 行を消しても
テンプレートからキーが消えるのではなく `"http2"` が描画される**（実測）。欠けたようには見えないまま
HTTP/3 だけが無効に戻るため、`test/distribution-behavior.test.ts` が `'http2and3'` をリテラルで固定する。

採った理由:

- `cdk diff` の HTTP/3 のぶんは `DistributionConfig.HttpVersion` の **1 行**だけ（in-place。置換も
  削除も 0。実測。同じデプロイに `/_astro/*` が同乗している — 全体の差分は `infra/docs/stacks.md` の「BlogSiteStack」）。
  効くのは**ビューアとの接続だけ**で、CloudFront からオリジンへの接続には関係しない
- QUIC は TCP の 3-way と TLS1.3 の握手を畳んで **2 RTT を 1 RTT** にする。実測の握手は
  connect 34 ms / tls 56 ms なので、取れるのは握手 1 往復ぶん。転送そのものは速くならない
- `HTTP3` 単独ではなく `HTTP2_AND_3` なので**退路が常にある**。CloudFront の HTTP/3 は TLS1.3 と
  SNI を話せるビューアにだけ使われ、話せないビューアや UDP/443 が塞がれた経路は h2 のまま通る

確かめ方: 有効なら応答に `alt-svc: h3=":443"; ma=86400` が付く。**有効化前の `blog.shutx.net` には
無かった**ことを実測済みで、正の対照は h3 が有効な CloudFront である `d1.awsstatic.com`。

```sh
curl -sI https://blog.shutx.net/ | grep -i alt-svc
# => alt-svc: h3=":443"; ma=86400
```

**ただし確認できたのは広告（`alt-svc`）までで、QUIC の実接続は未確認である。** 手元の curl 8.5.0 は
HTTP/3 非対応（`curl -V` の Features に `HTTP3` が無い）なので、UDP/443 で実際に話せたかは
**確かめていない。確かめるならブラウザが要る。**

#### 反対側の実測（判断を見直す条件つき）

**PSI mobile のスコアを作る Lighthouse の Lantern は h3 をモデル化していない。**
`ConnectionPool.js:46` が `request.protocol === 'h2'` とリテラル比較しており、`'h3'` は
**非多重化**（1 オリジン 6 本の HTTP/1.1 相当）として扱われる。同じ `TCPConnection` を
rtt 150 ms / 1.6 Mbps で走らせた実測では、同一オリジン 2 本目の CSS 1846 B は **h2 なら 0 ms /
h2 扱いされないと 150 ms**。**PSI が h3 を記録すると、シミュレートされる FCP / LCP が
150 ms 悪化しうる。**（`modern-http-insight` は助けにならない。実装は `/HTTP\/[01][.\d]?/i` で
**HTTP/1.x だけ**を指摘するので h2 も h3 も合格する。）

有効化を決めたときの見込みは「PSI の初回接続は h2 のまま記録される」だった。根拠は 2 つで、
(a) PSI は毎回クリーンプロファイルなので `alt-svc` のキャッシュを持たない、
(b) CloudFront の DNS HTTPS(SVCB) RR が h3 を広告していない、だった。

**(b) はもう成り立っていない。** 実測の推移（すべて 2026-10-03）:

| 時点 | `dig +short -t HTTPS d8gsxbwzr6ft8.cloudfront.net` |
| --- | --- |
| デプロイ前 | `1 . alpn="h2"` |
| デプロイ直後（23:35 頃） | `1 . alpn="h2"` |
| その約 25 分後に再測定 | **`1 . alpn="h2,h3"`** |

最後の行は既定リゾルバ / `@1.1.1.1` / `@8.8.8.8` の 3 つで一致し、RR の **TTL は 60 秒**
（デプロイ直後にまだ古い値が見えたのはこれで説明がつく）。RR が付いているのは配信ドメイン
`d8gsxbwzr6ft8.cloudfront.net` のほうで、**AWS がいつどういう条件でこれを書き換えるかは観測して
いない**（有効化との因果は確かめていない。値そのものが上のとおりだという事実だけである）。

**それでも結論は変わる。h3 が DNS で広告されている以上、対応ブラウザは `alt-svc` のキャッシュが
無くても初回接続で QUIC を選びうる = 上の 150 ms が現実になりうる。**

**したがって判断の見直し条件は満たされている。次にやるのは実測である:**

1. PSI mobile を回して **FCP / LCP** を有効化前の値と比べる（スコアそのものではなく実数を見る。
   `render-blocking-insight` / `network-dependency-tree-insight` / `cache-insight` は weight 0 なので
   スコアは動かない）
2. 悪化していれば `httpVersion` を `HttpVersion.HTTP2` に戻す。**直すのは 3 箇所**（`site-stack.ts` の
   `httpVersion` の行とコメント / `test/distribution-behavior.test.ts` のリテラル / この節）
3. 悪化していなければこの節に実測値を足して据え置く

**「`alt-svc` が付いたから成功」で閉じないこと。** 得ているのは握手 1 往復ぶんで、失いうるのは
Lantern 上の 150 ms である。
