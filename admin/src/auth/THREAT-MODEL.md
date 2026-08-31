# 管理画面の認証 — 脅威モデル

**この文書はトークン保持方式の根拠である。** 「なぜ `localStorage` ではないのか」を
後から再議論しないための唯一の出典なので、保持方式を変えたくなったらまずここを読むこと。

計測はすべて 2026-08-31 に実環境に対して行ったもので、主張ではない。

## 守っている資産

Cognito の **ID トークン（有効 60 分）** と **refresh トークン（24 時間）**。
この 2 つは次の 2 経路を起動できる。

| 経路 | できること |
| --- | --- |
| `POST /api/posts` | public な GitHub リポジトリへのコミット |
| `POST /api/media/presign` | メディアバケットへの presigned PUT |

### 盗まれた ID トークンで 60 分間にできること

記事の投稿・改竄、メディアのアップロード。

### できないこと

- GitHub App の秘密鍵の取得（api は返さない。Secrets Manager から読んで JWT に署名するだけ）
- AWS API の直接操作（ブラウザに AWS 資格情報を渡す設計を採っていない。IdentityPool は作っていない）
- 他ユーザへの昇格（単一著者プールで `cognito:username` の完全一致。`selfSignUpEnabled: false`）
- 投稿の隠蔽（Git がすべて記録し、revert できる）

**被害は公開・可視・可逆である。** これが「保持方式の選択に過剰な代償を払わない」判断の土台になる。

## 攻撃者 A: admin オリジンでの XSS（**主敵。仮想の話ではない**）

実測: `admin/src/preview/pipeline.ts` の実パイプラインは Markdown 中の生 HTML を
そのまま通す。

```
<img src="x" onerror="alert(1)">   -> そのまま出力に残る
[click](javascript:alert(1))       -> <a href="javascript:alert(1)"> になる
<svg onload=alert(1)>              -> <svg onload="alert(1)"></svg> になる
```

そして `admin/src/editor/bind.ts:98` がそれを `preview.innerHTML` に代入する。
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

**Phase 5 でこれを CloudFront の `ResponseHeadersPolicy` として実装した**
（`infra/lib/response-headers.ts`）。**サニタイズは採らない** — パイプラインで消毒すると
`admin/test/parity/published-html.test.ts` のバイト一致が壊れ、`bind.ts` の `innerHTML`
境界だけで消毒すると「プレビューは安全・公開ページは危険」という乖離が生まれて
プレビューの存在理由と衝突する。**CSP はレスポンスヘッダなので一致証明のどれにも触れない。**

なお `admin/test/build/output.test.ts` が「インライン `<script>` を出力に含めない」を
既に固定しているので、CSP は admin 自身を壊さない。

### CSP が塞がないもの（正直に）

- `<meta http-equiv="refresh">` によるリダイレクト（CSP に該当ディレクティブが無い）
- プレビュー枠内の表示なりすまし
- CSS による情報抜き出し（`style-src 'unsafe-inline'` を許す以上ゼロにはできない）

いずれも**スクリプト実行を伴わないので、守っている資産（トークン）には届かない。**
CSS の送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
`'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる。

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
24 時間有効な refresh トークンがディスクに残り続けることと天秤にかけて後者を選んでいる。

不便を理由に `localStorage` へ変えたくなる圧力は構造的にかかる。
**変えるなら、この表の「採らない理由」に反論してから変えること。**

## リフレッシュトークンの寿命は観測できない

Cognito の refresh トークンは不透明文字列で `exp` を持たない。24 時間という値は
`describe-user-pool-client` の**設定値**であって、トークン自体からは読めない。

**したがって「失効した」ことは `invalid_grant` を受け取って初めて分かる。**
「もうすぐ切れます」という警告は実装しない — 根拠となるデータが無いのに出すと嘘になる。

編集中に失効を踏んだときは**自動リダイレクトしない**。下書きを保全して、
明示的な再ログインを促す（`src/auth/refresh.ts` と `src/editor/app.ts`）。
