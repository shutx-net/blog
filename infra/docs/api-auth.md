# 投稿 API と認証

### `AWS_IAM` + OAC はエンドユーザ認証ではない

**これを取り違えると、公開の書き込みエンドポイントをデプロイすることになる。**

`AWS::Lambda::Url` の `AuthType` は `AWS_IAM` で、Function URL に直接アクセスしても
SigV4 署名が無ければ 403 になる。しかしそれが防いでいるのは **Function URL への直接アクセスだけ**である。

OAC の `SigningBehavior` は `always`。CloudFront は **到達したすべてのリクエストに自分で署名を付けて**
オリジンに渡す。つまり `https://<distribution>/api/posts` に **誰が POST しても、匿名でも
Lambda は起動する。** `AWS_IAM` は CloudFront 経由の匿名アクセスを一切止めない。

書き込みを止めているのは Lambda 側の `AUTH_MODE` のほうである。

- 環境変数 `AUTH_MODE` は **必須**。未設定・未知の値ならコールドスタートで例外になり、
  CloudFront には 502 が返る。「黙って全許可」にならないための設計
- 認可判定は **ルータのディスパッチ前**にある。拒否時に GitHub クライアント・presigner・
  SecretReader を **一切呼ばない**（`api/test/unit/router.test.ts` が呼び出し回数 0 を主張）
- `test/posting-api.test.ts` が `Environment.Variables.AUTH_MODE` の値（いまは `cognito`）を
  固定しているので、緩めるときは必ずテストを直すことになる

> **CDK が生成する `AWS::Lambda::Permission` は `InvokeFunctionUrl` の 1 つだけで、
> `lambda:InvokeFunction` を明示的に足さないと関数が一度も起動しない**（`lambda:*` にはしない）。
> 初回デプロイで実際に踏んだ。症状と切り分けは `infra/docs/deploy.md` の
> 「CloudFront から Lambda への invoke permission」。

### POST / PUT では呼び出し側が `x-amz-content-sha256` を付ける必要がある

CloudFront + Lambda Function URL の OAC 構成では、**呼び出し側（＝ブラウザ / 管理画面）が
ボディの SHA256 を `x-amz-content-sha256` ヘッダに入れなければならない。** AWS のドキュメントの原文:

> If you use PUT or POST methods with your Lambda function URL, your users must compute the SHA256
> of the body and include the payload hash value of the request body in the `x-amz-content-sha256`
> header when sending the request to CloudFront. **Lambda doesn't support unsigned payloads.**

**この制約は API 側では吸収できない**（署名は CloudFront が行い、Lambda が検証する）。
知らずに管理画面を書くと、原因の分かりにくい署名エラーに時間を溶かす。

### 閲覧者の `Authorization` ヘッダは CloudFront に上書きされる

OAC の `SigningBehavior` が `always` である帰結として、CloudFront は自分の SigV4 署名を
`Authorization` ヘッダに書く。**閲覧者が送った `Authorization` は失われる。**

したがって ID トークンを `Authorization: Bearer` で送る一般的な設計は **そのままでは使えない**。
`no-override` に切り替える手もあるが、そうすると今度は **ブラウザ側が Lambda URL のホストに対して
SigV4 署名を行う必要**が生じ、SPA では現実的でない。

#### 解決策

```
x-blog-authorization: Bearer <Cognito ID token>
```

定数は `api/src/auth/transport.ts` の `AUTH_HEADER` / `AUTH_SCHEME`。
**Cookie は採らない** — ブラウザが自動で送るため同一オリジンの `/api/*` に対する CSRF が
成立する。カスタムヘッダはクロスオリジンから preflight 無しに付けられないので
**CSRF が構造的に防がれる**。SPA が Managed Login のリダイレクトからトークンを受け取る以上
HttpOnly にもできず、Cookie 側に利点が無い。

`x-amz-` で始まる名前は避けている（OAC が `x-amz-date` / `x-amz-security-token` /
`x-amz-content-sha256` を自分で付けるため）。全部小文字なのは、Lambda 側が
`headers[name.toLowerCase()]` で正規化しているから。

#### このヘッダが本当にオリジンに届くことの根拠（推測ではなく実測）

1. **AWS のドキュメント**: OAC の `SigningBehavior: always` は
   「CloudFront signs all origin requests, **overwriting the Authorization header from the
   viewer request** if one exists」と明記されている（＝上書きされるのは `Authorization` だけ）。
2. **オリジンリクエストポリシーの定義**: `/api/*` は `Managed-AllViewerExceptHostHeader`
   （ID `b689b0a8-53d0-40ab-baf2-68738e2966ac`）で、実測の内容は
   `HeaderBehavior: allExcept` / `Headers: [host]` / `CookieBehavior: all` /
   `QueryStringBehavior: all`。**`host` 以外の全ヘッダがオリジンに渡る。**
3. **対照実験（値を変えると結果が変わる）**: 本番ディストリビューションに対して
   - `POST /api/posts` + ボディ + `x-amz-content-sha256` **正しい値** -> **503**（Lambda まで届いた）
   - 同じリクエストで `x-amz-content-sha256` を **間違った値** に -> **404 HTML**（署名検証に落ちた）
   - ヘッダ無し -> **404 HTML**

   **値を変えると結果が変わる以上、viewer のヘッダ値は確かにオリジン側で使われている。**
   加えて `X-Blog-Authorization` を足しても 503 のまま（カスタムヘッダを足しても OAC 署名は
   壊れない）、1,800 バイトのヘッダ値でも壊れないことを実測した。Cognito の ID トークンは
   1〜2KB なので余裕で通る。

**唯一未検証の輪**: Lambda のハンドラ内で実際にこのヘッダを読めることは、デプロイしないと
観測できない。**`infra/docs/deploy.md` の「デプロイ手順」の手順 4 で実地確認すること。**

### 認証の拒否に 403 と 404 を使わない

**`CustomErrorResponses` は `DistributionConfig` 直下にあり、ビヘイビア単位では外せない。**
origin（Lambda）が返した 403 / 404 も `/404.html` の HTML に差し替えられる。

実測（2026-08-31、本番ディストリビューション）:

```
GET /api/nope   -> 404 / content-type: text/html / server: AmazonS3 / x-cache: Error from cloudfront
GET /api/health -> 200 / content-type: application/json / x-cache: Miss from cloudfront
```

`/api/nope` に対して Lambda のルータは `404 {"error":"not_found"}` を返しているが、
CloudFront が日本語の HTML ページに差し替えている。`x-cache: Error from cloudfront` がその証拠。
403 も同じ表に載っているので同様に化ける。

**したがって認証の拒否に 403 を使うと、admin からは「エンドポイントが無い」と区別が付かなくなる。**
「トークンを出し直せ」「あなたは別のユーザだ」「経路が無い」の 3 つが全部同じ HTML 404 になる。

`CustomErrorResponses` を外すと、OAC + S3 REST オリジンで存在しないキーが 403 のまま閲覧者に
見える。**よって直すべきは CloudFront ではなく API 側のステータス選択である。**

| 拒否理由 | ステータス | `error` |
| --- | --- | --- |
| `auth-not-configured`（`AUTH_MODE=deny-all`） | **503** | `auth_not_configured` |
| `unauthenticated`（ヘッダ欠落 / スキーム不正） | **401** | `unauthenticated` |
| `invalid-token`（署名・iss・aud・token_use・exp・改竄） | **401** | `invalid_token` |
| `not-authorized`（正当なトークンだが別ユーザ） | **401** | `not_authorized` |
| `unavailable`（JWKS が取得できない） | **503** | `auth_unavailable` |

401 と 503 はどちらも `CustomErrorResponses` の表に無いので **素通しで JSON のまま届く**
（実測で 503 が届くことは確認済み）。

`not-authorized` に 401 を使うのは意味論的には妥協である（本来 403）。
**妥協する代わりに、機械可読な `error` コードで区別できるようにしてある。**
表の `statusCode` は TypeScript の型で `401 | 503` に制限してあるので、
**403 と 404 はそもそも書けない**（`api/src/auth.ts`）。
`api/test/unit/router.test.ts` が 5 理由 x 3 保護経路の 15 通りを走査して
「401 か 503」「403 でない」「404 でない」を主張している。

> **admin 側の切り分け表**: HTML の 404 が返ってきたら、それは **認証の失敗ではない。**
> 「`x-amz-content-sha256` の付け忘れ／値の誤り（署名が壊れている）」か
> 「そのパスが存在しない」かのどちらかである。

### Cognito の feature plan に Essentials を選ぶ

**Lite ではなく Essentials（`UserPoolTier: ESSENTIALS`）。理由は Managed Login。**

- AWS 開発者ガイド:「Managed login is available in the **Essentials and Plus tiers**.
  The classic hosted UI is available in all feature tiers.」
- AWS 料金ページ: 無料枠は Lite も Essentials も **10,000 MAU / 月・アカウント**で、
  「The free tier does not automatically expire ... available to both existing and new AWS
  customers indefinitely」。

**MAU 1 では Lite と Essentials の請求額はどちらも 0 円なので、安いほうを選ぶ動機が存在しない。**
Essentials は `CreateUserPool` の既定でもある。

**Plus は採らない。** 料金ページに「There is no free tier for the Plus tier.」とあり、
threat protection（旧 advanced security features）に MAU 1 の個人ブログが月額を払う理由が無い。
