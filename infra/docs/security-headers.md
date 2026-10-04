# セキュリティヘッダ / CSP

`AWS::CloudFront::ResponseHeadersPolicy` を **3 本**作り（`SecurityHeaders` /
`MediaHeaders` / `AssetsHeaders`）、**デフォルトビヘイビア・`/media/*`・`/_astro/*` の
3 つ**に付けている。ビヘイビアは全部で 4 本あり、`/api/*` にだけ**付けない**（JSON 応答に
CSP は効かず、あのビヘイビアは OAC の署名条件で繊細に調整されている）。

**3 本に分かれている理由は `Cache-Control` の値だけ**（サイトは `no-cache`、`/media/*` と
`/_astro/*` は `immutable`）。**セキュリティヘッダのほうは 3 本で同一でなければならない**ので、
`site-stack.ts` は `securityHeadersBehavior` を 1 つのローカル変数に括り出して出所を 1 つに
している。`distribution-response-headers.test.ts` が**サイト以外の全件**をサイト側と
突き合わせて一致を固定している（名指しの 2 本ではない。4 本目を足した日にも同じ穴が開かない）。

**`/admin/*` 専用のビヘイビアは新設していない。** admin はデフォルトビヘイビアで
配信されているので、サイトと admin で 1 つのポリシーを共有すれば足りる。新設すると
`distribution-behavior.test.ts` と `distribution-media-behavior.test.ts` の
ビヘイビア件数・順序のアサーションを書き換えることになる。

ポリシー本文は `infra/lib/response-headers.ts` の `buildCsp()` が組み立てる。
**このファイルは依存ゼロの純粋モジュール**で、`admin/test/unit/csp-contract.test.ts` が
同じ関数を import して「admin が実際に通信する先を許可し漏れていないか」を突き合わせている
（`import` 文が 1 つも無いことを infra 側のテストが固定している）。

```
Content-Security-Policy:
  default-src 'self'; base-uri 'self'; object-src 'none'; frame-src 'none';
  frame-ancestors 'none'; form-action 'self'; img-src 'self'; font-src 'self';
  style-src 'self'; style-src-attr 'unsafe-inline';
  script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none';
  connect-src 'self' <Cognito の Managed Login ドメイン> <メディアバケットの regional domain>
```

`connect-src` の 2 つのホストは**構成要素から導出している**（`UserPoolDomain` の `Ref` と
`bucketRegionalDomainName` の `Fn::GetAtt`）。**物理名は書いていない** — 直書きすると、
片方だけ変わった日に「ログインだけ動かない」「画像だけ上がらない」という最も分かりにくい
壊れ方をする。

同時に `X-Content-Type-Options: nosniff` / `Referrer-Policy: same-origin` /
`X-Frame-Options: DENY` / `Strict-Transport-Security` も出す。
**ResponseHeadersPolicy を入れる前の実配信は、これらを 1 つも返していなかった**（実測）。

### なぜ CSP なのか（サニタイズしない理由）

admin のプレビューには**実在する XSS 経路**がある。実測で、実パイプラインは Markdown 中の
生 HTML をそのまま通し（`<img src=x onerror=...>` / `<a href="javascript:...">` /
`<svg onload=...>` が出力に残る）、`admin/src/editor/bind.ts` がそれを `innerHTML` に入れる。

**それでもサニタイズは採らない。**

- パイプラインで消毒すると `admin/test/parity/published-html.test.ts` の**バイト一致が壊れる。**
- `bind.ts` の境界だけで消毒すると「プレビューは安全・公開ページは危険」という**乖離**が生まれ、
  プレビューが本番を再現しなくなる（プレビューの存在理由と衝突する）。

**CSP はレスポンスヘッダなので、3 つの一致証明のどれにも触れない。**

### `script-src` に `'unsafe-inline'` を入れない

インラインイベントハンドラ（`onerror` / `onload`）も `javascript:` URL も、
`script-src` に `'unsafe-inline'` が無ければ動かない。`script-src-attr 'none'` で
**二重化**している（`script-src` へのフォールバックに頼らない）。

`admin/test/build/output.test.ts` が admin/dist と site/dist の両方について
**インライン `<script>` 0 件・インラインイベントハンドラ属性 0 件・`javascript:` 0 件**を
固定しているので、**この厳格さは既存の何も壊さない。**

**テストの書き方に注意。** 素朴な `not.toContain("'unsafe-inline'")` は
**`style-src` 側の `'unsafe-inline'` に当たって誤検出する。** `;` で分割し、
**ディレクティブ名の完全一致**で引くこと（`script-src` を探して `script-src-attr` を
巻き込まないこと）。この落とし穴自体もテストにしてある。

### `'wasm-unsafe-eval'` を消さないこと

admin のバンドルは **shiki** の oniguruma **WebAssembly** を base64 で JS チャンクに埋め込み
（実測 622,325 B）、`atob` してから `WebAssembly.instantiate` をバッファに対して呼ぶ。
**`'wasm-unsafe-eval'` が無いと WebAssembly はブロックされ、プレビューのシンタックス
ハイライトだけが静かに壊れる**（プレビューと公開ページの見た目が食い違う）。

**`'unsafe-eval'` と取り違えないこと。** 前者は WebAssembly だけを許し JS の `eval()` は
許さないので XSS 防御は損なわれないが、後者は `eval()` を開けてしまい防御が崩れる。

### `style-src` は `'self'` だけ。`'unsafe-inline'` は `style-src-attr` にだけ残す

以前は `style-src 'self' 'unsafe-inline'` だった。理由は 2 つあり、片方ずつ解いた。

1. site/dist の HTML が全件インライン `<style>` を持っていた（`inlineStylesheets: "always"`）。
   設定を外して外部 `/_astro/Layout.*.css` にしたので、同一オリジンの `'self'` で足りる。
2. shiki はトークンごとに `style="color:#..."` **属性**を吐く（実測: コードフェンス 2 本の
   記事 1 件で `style=` 属性 **29 個**、`<style>` ブロック 0 個）。

**CSP3 では `style-src-attr` を明示すると `style` 属性はそちらに支配され、`style-src` に
フォールバックしない。** だから 2 は `style-src-attr 'unsafe-inline'` で許すしかない。逆に
`style-src-attr` を**空や `'none'` で**足すと属性が拒否され、コードフェンスの色が飛ぶ。

**得られた強化は限定的である。** できるようになったのは `<style>` ブロックの注入を禁じる
ことだけで、`style` 属性は許したままだ。インラインスタイルはスクリプトを実行しないので、
`script-src` の厳格さと引き換えにはならない。送出口は `img-src 'self'` と `connect-src` の
限定で塞がっており、`'unsafe-inline'` は外部 URL を許可しないので
`@import url(https://evil/...)` も弾かれる（そもそも `@import` は属性には書けない）。

`admin/test/build/output.test.ts` は **site/dist のインライン `<style>` が 0 件**であることを
要求する（**以前と逆向きの見張り**。1 件でも現れたら `style-src 'self'` がそれをブロックし、
そのページは見た目を失う）。外部ファイルで出ること自体は
`site/astro.config.mjs` の `build.inlineStylesheets: "never"` が宣言している。

**本番の記事にコードフェンスが無い間、2 の効き目は検証できない。** `style=` 属性が 0 個なので、
`style-src-attr` を壊しても既存ページは無症状で通る（`published-html.test.ts` の
バイト一致も素通りする）。色が飛ぶのは記事を書いた日だ。**ディレクティブそのものの有無は
`distribution-response-headers.test.ts` が固定している。**

### `<meta http-equiv>` では配らない

**`frame-ancestors` は `<meta>` では無視される**（CSP 仕様が `report-uri` / `frame-ancestors` /
`sandbox` を meta で無効と明記している）。クリックジャッキング対策を落としたくないので
**ヘッダ一択**。加えて meta は HTML 応答にしか乗らず、パース位置より前のリソースには効かない。
**2 箇所で二重管理するとドリフトするので併用もしない。**

### HSTS に `includeSubDomains` と `preload` を付けない

`max-age` は 1 年（31536000）だが、**`includeSubDomains` も `preload` も付けない。**
これは保留ではなく、`blog.shutx.net` を alias に足した時点で**改めて決め直した結果**である。

1. **`blog.shutx.net` の下にホストが 1 つも無い。** サブドメインを作るリソースがこの
   スタックに無いので、`includeSubDomains` には**守る対象が存在しない。** 逆に、将来
   `*.blog.shutx.net` に HTTPS を話せないホストを置いた日には、**ブラウザが `max-age` の
   残り（最大 1 年）だけそこへ平文で到達できなくなる。** 得るものが無く、失うものだけがある。
2. 親の `shutx.net` は**このスタックの管理外**で、中身も別物（実測
   `dig +short shutx.net` -> `75.2.60.5` / `99.83.190.102`。このディストリビューションでは
   ない）。HSTS はヘッダを返したホストとその子にしか効かないので `includeSubDomains` を
   付けても親には及ばないが、**宣言の射程を自分が面倒を見る範囲に収める**という線は動かさない。
3. `preload` はリストから外す申請が通っても、それがブラウザのリリースに乗るまで効かない。
   個人ブログに対して**解除コストだけ**が残る。

**カスタムドメインが付いて、HSTS 自体は初めて実利を持った。** 手で打たれたりリンクされたり
するのは `blog.shutx.net` のほうで、スキームを省いた最初の 1 本は平文で出て 301 を踏む
（既定ビヘイビアは `REDIRECT_TO_HTTPS`）。HSTS があれば 2 回目以降はブラウザが送る前に
`https` へ上げるので、その 1 往復が消える。

**「`*.cloudfront.net` は他人と共有するドメインだから」は理由にならない。** `includeSubDomains`
が及ぶのは**ヘッダを返したホストの子**であって兄弟ではなく、他テナントの
`dXXXXXXXXXXXXX.cloudfront.net` は兄弟である。**値（どちらも false）は 1 文字も変えていないが、
根拠は上の 3 つに置き換わっている。**

### CSP の効果はこの環境で観測できない

実測で **jsdom は CSP を一切強制しない**（`script-src-attr 'none'` を与えた場合と
与えない場合で `<div onclick>` の発火は**どちらも 1 回**で同一。`<img onerror>` が
どちらも 0 回なのは **jsdom が画像を取りに行かないだけ**で CSP のおかげではない）。
**「CSP が onerror を止めた」という緑のテストは原理的に書けず、書けば嘘になる。**

検証は 3 層に分けてある。

| 層 | 何を言えるか | どこ |
| --- | --- | --- |
| テンプレート | ポリシー文字列とビヘイビアへの結線が正しい | `infra/test/distribution-response-headers.test.ts` |
| 整合 | アプリが必要とするものを許可し漏れていない | `admin/test/unit/csp-contract.test.ts` |
| 実配信 | ヘッダが実際に届いている | `npm run -w admin auth-smoke` |

**残る「ブラウザが本当にスクリプトを止めたか」は手動確認に送る**
（`docs/aws-ops.md` の「ブラウザでの確認が必須」）。

#### 手動確認の結果（2026-08-31、Edge で実施）

エディタの本文に `<img src=x onerror="alert(1)">` を入力したときのコンソール:

```
GET https://d8gsxbwzr6ft8.cloudfront.net/admin/x 404 (Not Found)
Executing inline event handler violates the following Content Security Policy
directive 'script-src-attr 'none''. ... The action has been blocked.
```

**アラートは出ない。** 画像の読み込みが失敗して `onerror` の発火が試みられ、CSP が止めている。

上の 3 層はいずれも「ポリシーが正しく届いている」までしか言えないので、
**実際に止まることの証拠はこの記録だけである。**

CSP を変更したら、この確認をやり直すこと。特に `script-src` に `'unsafe-inline'` が
入ると、この防御は無言で消える。

### デプロイ順序

**CSP は admin より先か同時に出すこと。** トークンをブラウザに置く変更が、
緩和の無い状態で先行してはならない。CSP は `cdk deploy`、admin は `aws s3 sync` で
**経路が別**なので片方だけ先に出せてしまう。

CSP は既存のサイトを壊さない（実測: site/dist はインライン `<script>` 0 件・
インラインイベントハンドラ 0 件・外部スクリプト参照 0 件）ので、**admin より先に出しても
副作用が無い。**
