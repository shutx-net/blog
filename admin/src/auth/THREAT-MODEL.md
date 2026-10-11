# 管理画面の認証 — 脅威モデル

**この文書はトークン保持方式の唯一の出典である。**
保持方式を変えたくなったらまずここを読むこと。

計測はすべて 2026-08-31 に実環境に対して行ったもので、主張ではない。

## 守っている資産

Cognito の **ID トークン（有効 60 分）** と **refresh トークン（24 時間）**。
この 2 つは次の 2 経路を起動できる。

| 経路 | できること |
| --- | --- |
| `POST /api/posts` | private な記事リポジトリ `shutx-net/blog-content` へのコミット |
| `POST /api/media/presign` | メディアバケットへの presigned PUT |

### 盗まれた ID トークンで 60 分間にできること

記事の投稿・改竄、メディアのアップロード。

### できないこと

- GitHub App の秘密鍵の取得（api は返さない。Secrets Manager から読んで JWT に署名するだけ）
- AWS API の直接操作（ブラウザに AWS 資格情報を渡す設計を採っていない。IdentityPool は作っていない）
- 他ユーザへの昇格（単一著者プールで `cognito:username` の完全一致。`selfSignUpEnabled: false`）
- 投稿の隠蔽（Git がすべて記録し、revert できる）

**被害は可視・可逆である**（記事リポジトリは private だが、公開サイトに出るので気づける）。
これが「保持方式の選択に過剰な代償を払わない」判断の土台になる。

### サインアウトは盗まれた ID トークンの窓を縮めない

`src/auth/sign-out.ts` が `/oauth2/revoke` に出すのは **refresh トークンだけ**。
ID トークンは JWT で、api 側は署名と `exp` だけを見る（`api/src/auth/cognito.ts`。
失効リストは引かない）。**したがって既に盗まれた ID トークンは、サインアウトしても
自分の `exp` まで `/api/*` に通る。** 上限は 60 分（`IdTokenValidity: 60` / 単位 `minutes`。
synth 済みテンプレートの実測値）。

revoke が効くのは「そこから先の発行」に対してであり、これは小さくない —
refresh トークンは **1440 分 = 24 時間**（同じく実測。単位は `days` ではなく `minutes`）
有効で rotation が無く、public client なので交換に secret が要らない。
**保存先を 1 度読まれれば、最大 24 時間にわたって 60 分トークンを発行し続けられる。**
それを止める唯一の手段がサインアウトである。

## 攻撃者 A: admin オリジンでの XSS（**主敵。仮想の話ではない**）

実測: `admin/src/preview/pipeline.ts` の実パイプラインは Markdown 中の生 HTML を
そのまま通す。

```
<img src="x" onerror="alert(1)">   -> そのまま出力に残る
[click](javascript:alert(1))       -> <a href="javascript:alert(1)"> になる
<svg onload=alert(1)>              -> <svg onload="alert(1)"></svg> になる
```

そして `admin/src/editor/bind.ts:106` がそれを `preview.innerHTML` に代入する。
`innerHTML` 経由の `<script>` は HTML 仕様上そもそも実行されないが、
**`onerror` と `onload` は発火し、`javascript:` リンクもクリックで動く。**
著者が外部から Markdown を貼れば成立する。

### 重要な帰結: **どの保存先を選んでも XSS には勝てない**

ページ内で動くスクリプトは、メモリ変数だろうと `sessionStorage` だろうと同じように読める。
そもそもアプリ自身の関数を呼べば新しいトークンを取れる。
**したがって「保存先の選択で XSS を防げる」という主張はこの文書のどこにも無い。**

XSS に効く唯一の対策は **CSP** である。`script-src` に `'unsafe-inline'` を入れなければ
インライン属性ハンドラ（`onerror` / `onload`）は無効化され、`javascript:` URL も動かない。
`script-src-attr 'none'` でさらに明示的に閉じる。

**これは CloudFront の `ResponseHeadersPolicy` として実装してある**
（`infra/lib/response-headers.ts`）。**サニタイズは採らない** — パイプラインで消毒すると
`admin/test/parity/published-html.test.ts` のバイト一致が壊れ、`bind.ts` の `innerHTML`
境界だけで消毒すると「プレビューは安全・公開ページは危険」という乖離が生まれて
プレビューの存在理由と衝突する。**CSP はレスポンスヘッダなので一致証明のどれにも触れない。**

なお `admin/test/build/output.test.ts` が「インライン `<script>` を出力に含めない」を
既に固定しているので、CSP は admin 自身を壊さない。

### CSP が塞がないもの（正直に）

- `<meta http-equiv="refresh">` によるリダイレクト（CSP に該当ディレクティブが無い）
- プレビュー枠内の表示なりすまし
- CSS による情報抜き出し（`style-src-attr 'unsafe-inline'` を許す以上ゼロにはできない。
  `<style>` ブロックは `style-src 'self'` が禁じるので、経路は `style` 属性だけに狭まった）

いずれも**スクリプト実行を伴わないので、守っている資産（トークン）には届かない。**
CSS の送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
`'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる
（そもそも `@import` は `style` 属性には書けない）。

## 攻撃者 B: 他オリジンの JavaScript

Web Storage はオリジン単位なので読めない。

`/api/*` はカスタムヘッダ方式（`x-blog-authorization`）なので、
`api/src/auth/transport.ts` が書いているとおり **CSRF が構造的に成立しない** —
クロスオリジンから preflight 無しにカスタムヘッダは付けられない。

**ただし Cognito の `/oauth2/token` の CORS は防御ではない。** 実測で Cognito は
preflight の `Origin` を検証せず、`https://evil.example.com` を送ってもそのまま
`access-control-allow-origin` に反映する（`access-control-allow-credentials: true` 付き）。
**だからこそ PKCE と `state` が唯一の防御になる。**
「CORS があるから安全」という推論をコードにもコメントにも書かないこと。

### `nonce` を送っていない（意図）

OIDC の `nonce` を authorize 要求に載せていない。`id_token` のリプレイ・注入に対して
効いているのは次の 3 つで、**`nonce` が埋める隙間がこの構成には無い**:

1. **認可コードフロー**だけを使う（`AllowedOAuthFlows: ["code"]`。implicit は配列に無い）。
   ID トークンは `/oauth2/token` の応答本文でだけ受け取るので、
   **URL・fragment から ID トークンを読む経路が存在しない。**
2. **PKCE S256** — code を奪っても verifier が無ければ交換できない。
3. **`state` と verifier を 1 レコード・1 キーで束ね、単回使用にしている**
   （`pending-login.ts`）。「攻撃者の state + 被害者の verifier」の組み合わせが作れない。

加えて api 側は `aud`（= このアプリクライアント）と `iss` と `token_use: 'id'` を
`aws-jwt-verify` で検証し、`cognito:username` の完全一致まで見る。

**それでもこれは「要らない」ではなく「この構成では効果が重複している」である。**
implicit を有効にした日、あるいは ID トークンを URL 経由で受け取る経路を作った日には
**`nonce` が必須になる。** その 2 つを変えるときはここに戻ってくること。

## 攻撃者 C: 端末を共有する第三者・ブラウザ拡張

ブラウザ拡張はどの保存先も読める。共有端末に対しては
**「タブを閉じたら消える」ことが実際に効く。**

## 攻撃者 D: 通信路

https + HSTS。実測で Cognito 側は `strict-transport-security: max-age=31536000` を返す。

## 結論: なぜ `sessionStorage` なのか

**保持方式の選択は、攻撃者 C とタブ寿命に対してだけ差が出る。**
攻撃者 A（XSS）にはどれも勝てず、攻撃者 B にはどれも勝つ。
よって「タブを閉じたら消える」ことを基準に `sessionStorage` を選ぶ。

| 候補 | 採らない理由 |
| --- | --- |
| `localStorage` | タブを閉じてもブラウザを再起動しても残り、**24 時間有効な refresh トークンがディスク上に残り続ける。** オリジンの全タブで共有される。単一著者が短時間の作業を繰り返す用途で、この永続性に見合う利得が無い |
| メモリ変数のみ | (a) **リダイレクト往復でページが作り直されるのでそもそも残らない。** (b) F5 のたびに Cognito への全画面遷移が要る。**その全画面遷移こそが下書きを失う事象そのもの**であり、発生頻度を上げる選択は下書き保全の目的と正面から衝突する。(c) XSS には勝てないので代償に見合う利得が無い |
| Cookie | `api/src/auth/transport.ts` が既に決着させている。ブラウザが自動送信するため同一オリジン `/api/*` に CSRF が成立し、SPA がリダイレクトでトークンを受け取る以上 HttpOnly にもできない。**この判断を蒸し返さない** |

### 受け入れている trade-off

**ブラウザを閉じるたびに再ログインが要る。**「毎日 1 回パスワードを打つ」体験になる。
24 時間有効な refresh トークンがディスクに残り続けることと天秤にかけて、**この不便を選んでいる。**

不便を理由に `localStorage` へ変えたくなる圧力は構造的にかかる。
**変えるなら、この表の「採らない理由」に反論してから変えること。**

## リフレッシュトークンの寿命は観測できない

Cognito の refresh トークンは不透明文字列で `exp` を持たない。24 時間という値は
`describe-user-pool-client` の**設定値**であって、トークン自体からは読めない。

**したがって「失効した」ことは `invalid_grant` を受け取って初めて分かる。**
「もうすぐ切れます」という警告は実装しない — 根拠となるデータが無いのに出すと嘘になる。

編集中に失効を踏んだときは**自動リダイレクトしない**。下書きを保全して、
明示的な再ログインを促す（`src/auth/refresh.ts` と `src/editor/app.ts`）。

**起動時（ページ読み込み時）だけは別で、セッションが無ければログイン画面へ 1 回だけ送る**
（判定は `src/auth/auto-sign-in.ts`、遷移は `src/main.ts`）。編集中に飛ばさないことと両立する
— 判断するのは起動時の 1 回だけで、`refresh.ts` も `app.ts` も**自分から遷移を起こさない**
（`app.ts` が呼ぶのはクリックで渡された注入関数だけ）。
機械化されているのは**綴りの走査**だけで、`test/unit/auth-seam.test.ts` の走査規則 5 が
3 綴りを `main.ts` ちょうど 1 本に限り、`test/unit/auth-refresh.test.ts` が `refresh.ts` に
`redirect` も含めた 4 綴りが現れないことを見ている。**その限界（別の手段で遷移するコードは
捕まえない）はその走査規則のコメントに書いてある。**

### 自動サインインが作った攻撃面（攻撃者視点）

自動化によって**利用者の操作なしに認可要求が飛ぶ**ようになった。
被害者のブラウザで `/admin/` を開かせるだけで `/oauth2/authorize` への往復が始まる。
実測で、それによって新しく可能になったのは次の 2 つ**だけ**である:

1. **固定 1 ホストへの無ジェスチャ遷移。** 攻撃者が influence できる唯一の入力
   （`location.search` 経由の `returnTo`）を 8 通り通しても、**生成される authorize URL は
   1 種類しかない**（ホストは `auth/config.ts` の定数 1 つ、パラメータは 7 個で固定、
   `response_type=code` と `code_challenge_method=S256` も不変）。
   **汎用リダイレクタにはなっていない。**
2. **保存先への 2 キーの書き込み**（pending-login レコードと抑止印）。

成立しないもの:

- **ログイン CSRF** — 単一著者プールで `selfSignUpEnabled: false` なので、
  攻撃者が「自分のアカウントで被害者をログインさせる」ために使えるアカウントを持てない。
- **攻撃者が先に state + verifier を置く** — 書き手は `beginPendingLogin` だけで、
  呼ぶには同一オリジンの JS が要る。それを持つ相手は既にトークンを読める。
- **増幅** — 同じ要求は `/oauth2/authorize` を直接叩いて作れる（URL が公開定数と乱数だけ）。
  `/admin/` を経由する利点が攻撃者側に無い。

**残っている面は 1 つ: `startAutoSignIn` はトップレベル文書かどうかを見ない。**
`top` / `self` / `parent` / `frameElement` / `ancestorOrigins` の綴りが
`auto-sign-in.ts` と `main.ts` に 1 つも無く、**iframe の中でも走る。**
止めているのは**エッジのヘッダだけ**（`frame-ancestors 'none'` と `X-Frame-Options: DENY`。
`/admin/` はデフォルトビヘイビア経由なので `SecurityHeaders` が付く）。
**この 2 つのどちらかを外すと、admin を枠に入れて無ジェスチャでログイン往復を
走らせる経路が開く。**

**`insecure_origin` ガードはスキームしか見ない**（`origin.startsWith('https://')`）。
`https://evil.example` でも `sign_in` を返す — 実効的な番人はガードではなく
Cognito の `CallbackURLs`（https の 2 本にリテラル固定）であり、
不一致は `redirect_mismatch` で Cognito 自身の `/error` に落ちる。
ガードの目的は**ローカルの dev server（http）でエディタが開けなくなるのを避けること**で、
セキュリティ境界ではない。
