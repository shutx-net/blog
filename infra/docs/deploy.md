# デプロイ

## CloudFront から Lambda への invoke permission（実デプロイで判明）

`FunctionUrlOrigin.withOriginAccessControl` が出す permission は
`lambda:InvokeFunctionUrl` の **1 文だけ**で、それだけでは CloudFront は関数を呼べない。
CloudFront 開発者ガイド "Restrict access to an AWS Lambda function URL origin" は
`add-permission` を **2 回**実行するよう明示している。

| Action | 出所 |
| --- | --- |
| `lambda:InvokeFunctionUrl` | CDK が自動で作る |
| `lambda:InvokeFunction` | **`site-stack.ts` で明示的に足している** |

**症状が誤読しやすい。** 2026-08-30 の初回デプロイで実際に踏んだときの観測はこうだった。

```
POST /api/posts -> 404
server: AmazonS3
x-cache: Error from cloudfront
```

Function URL の IAM 認可が 403 を返し、それを `CustomErrorResponses(403 -> /404.html)` が
404 に差し替えるので、S3 の 404 ページが返る。**「/api/* のルーティングが効いていない」
ように見えるが、実際にはビヘイビアは正しく Lambda に向いている。**

決め手はロググループが空であることだった。**認可は関数の起動前に行われるので、
弾かれるとログが 1 行も出ない。** 逆に言えば、ログが空なら permission を疑う。

AWS のブログ記事 "Secure your Lambda function URLs using Amazon CloudFront origin access
control" は `InvokeFunctionUrl` だけを示しており開発者ガイドと食い違うが、
**実環境の挙動は開発者ガイドのほうと一致する。**

`test/distribution-media-behavior.test.ts` が 2 本あることと、どちらもこの
ディストリビューションに限定されていることを固定している（片方を消すと 4 件が赤くなる）。

## デプロイ手順

**`cdk deploy` は人間が承認して実行する。**
（AGENTS.md: `infra/` を変えた PR では `npx -w infra cdk diff` の出力を本文に貼る）

### 1. まず差分を見る

```sh
npx -w infra cdk diff BlogSiteStack
```

新規は Cognito 3 リソース（`UserPool` / `UserPoolDomain` / `UserPoolClient`）、
更新は Lambda の `Environment.Variables`（`AUTH_MODE` と `COGNITO_*` 3 つ）と
メディアバケットの `CorsConfiguration` だけであること。**IAM ロール・Lambda 関数・
`Custom::*` の数が増えていないこと**を目で確認する。

### 2. デプロイ（1 回の `cdk deploy` で完結する）

```sh
npx -w infra cdk deploy BlogSiteStack
```

`AUTH_MODE=cognito` の Lambda はユーザプールへの `Ref` を持つので、CloudFormation は
**Cognito を先に作る**。2 段階に割る必要は無い。

`domainPrefix`（`shutx-blog-admin`）が他アカウントに取られていると、ここで明示的な
エラーになる。その場合は `ADMIN_LOGIN_DOMAIN_PREFIX` を変えて再実行する。

### 3. デプロイ後の受け入れ確認（この順で）

**(1) モードが切り替わったか**（無認証で確認できる）

```sh
curl -s https://blog.shutx.net/api/health
# => {"status":"ok","authMode":"cognito"}
```

**(2) トークン無しで書き込み経路が閉じているか**

```sh
BODY='{}'
SHA=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -H "x-amz-content-sha256: $SHA" \
  -d "$BODY" https://blog.shutx.net/api/posts
# => 401  （本文は {"error":"unauthenticated"}）
```

**404 の HTML が返ってきたら 403 を返してしまっている** — 設計違反なので直すこと
（あるいは `x-amz-content-sha256` が間違っている。`infra/docs/api-auth.md` の
「認証の拒否に 403 と 404 を使わない」の切り分け表を参照）。

**(3) ユーザを作る**（帯域外。**CDK には書かない** — このリポジトリは public）

```sh
POOL_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolId')].OutputValue" --output text)

aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
  --username shutx --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
  --username shutx --password '<16 文字以上・4 種混在>' --permanent
```

`--username` は `COGNITO_ALLOWED_USERNAME`（`ADMIN_USERNAME` 定数）と
**完全一致**でなければならない（プールは `CaseSensitive: true`）。

**(4) Managed Login で実際にトークンを取り、ヘッダで通す**
（**唯一デプロイしないと確かめられない輪**）

```sh
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolClientId')].OutputValue" --output text)
LOGIN=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminLoginDomain')].OutputValue" --output text)

echo "$LOGIN/login?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=https://blog.shutx.net/admin/"
```

ブラウザで開いて code を取り、`/oauth2/token` で ID トークンに交換してから:

```sh
curl -s -H "x-blog-authorization: Bearer $ID_TOKEN" \
  https://blog.shutx.net/api/health/github-app
# => 200 {"status":"degraded","canMintInstallationToken":false,...}
```

中身が `degraded` でも構わない。
**200 が返ること自体が「ヘッダが Lambda に届き、JWT 検証が通った」の証拠である。**

**(5) 別ユーザのトークンが弾かれるか**（2 人目を一時的に作って確認し、確認後に削除する）

```sh
# => 401 {"error":"not_authorized"}
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username <2 人目>
```

**(6) `CLOUDFRONT_ORIGIN` 定数のドリフト確認**

```sh
aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
```

**`CLOUDFRONT_ORIGIN`** の `https://` を除いた部分と一致すること。**`SITE_ORIGIN` ではない** —
正のオリジンは `CUSTOM_ORIGIN`（`blog.shutx.net`）に移っており、カスタムドメインの方は
この Output には出ない（`Aliases` は CfnOutput にしていない。
`infra/docs/cdk-structure.md` の「`SITE_ORIGIN` 定数」）。

**(7) CORS の確認**

```sh
MEDIA=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" --output text)
curl -s -D- -o /dev/null -X OPTIONS \
  -H 'Origin: https://blog.shutx.net' \
  -H 'Access-Control-Request-Method: PUT' \
  "https://$MEDIA.s3.ap-northeast-1.amazonaws.com/media/probe.png"
# => Access-Control-Allow-Origin: https://blog.shutx.net（送った Origin がそのまま返る）
```

**`Origin:` を `https://d8gsxbwzr6ft8.cloudfront.net` に替えてもう 1 回走らせること** —
`SITE_ORIGINS` の 2 本目（退路）の CORS が生きていることは、ここでしか確かめられない。

### 4. 切り戻し

`infra/lib/site-stack.ts` の `PostingApi` の `auth` を `{ mode: 'deny-all' }` に戻して
deploy し直す。

```ts
auth: { mode: 'deny-all' },
```

- **Cognito のリソースは消えない**（`deletionProtection: true` / `RemovalPolicy.RETAIN`）
- **api 側の `deny-all` は `COGNITO_*` を 1 つも読まない**ので、
  **壊れた Cognito 設定を抱えたまま安全側に倒せる**
- 戻すと認証が必要な 3 経路はすべて `503 auth_not_configured` になる

### CfnOutput 一覧

| Output 名（末尾一致で引く） | 用途 |
| --- | --- |
| `SiteBucketName` | `aws s3 sync` の宛先 |
| `MediaBucketName` | presigned PUT の宛先バケット |
| `DistributionDomainName` | CloudFront の既定ドメイン。**`CLOUDFRONT_ORIGIN` 定数と突き合わせる**（`SITE_ORIGIN` ではない） |
| `DistributionId` | キャッシュ無効化 |
| `AdminUserPoolId` | `aws cognito-idp admin-create-user --user-pool-id` |
| `AdminUserPoolClientId` | admin の OAuth `client_id` |
| `AdminLoginDomain` | Managed Login の URL |
| `AdminUserPoolIssuerUrl` | ID トークンの `iss`。JWKS は `<issuer>/.well-known/jwks.json` |
| `GitHubAppSecretName` | `aws secretsmanager put-secret-value --secret-id` |
| `PostingApiFunctionName` | 投稿 API の Lambda 関数名 |

Construct の中で作った Output は論理 ID が `<構築子パス><名前><ハッシュ>` になるので、
**`?ends_with(OutputKey, '<名前>')` で引くこと。**

## 実デプロイで解決した宿題（2026-08-30）

初回デプロイと deploy ワークフローの実走で確定したもの。**ローカルでは原理的に確かめられなかった
項目ばかりなので、結論だけでなく確かめ方も残す。**

| 宿題 | 結果 |
| --- | --- |
| `lambda:InvokeFunction` は要るか | **要った。** 無いと関数が一度も起動しない。`site-stack.ts` で明示的に足した |
| `aws s3 sync` の最小 IAM アクション | **6 アクションで足りた。`s3:GetObject` は不要。** 意図的に外した判断が正しかった |
| `workflow_dispatch` の `sub` 形式 | **`:ref:refs/heads/main`。** AWS/GitHub のドキュメントに記載が無く推測だったが、assume が成功したので確定 |
| immutable subject 形式 | **実際に発行される。** probe と本番 assume の両方で確認 |
| node のバージョン固定 | CI の実行ログで `v24.19.0`。nix shell と一致 |

確かめ方（同じことを再検証するとき）:

```sh
gh run view <run-id> --log | grep -iE 'Assuming role|upload:|invalidation'
```

`Assuming role with OIDC` が出れば信頼ポリシーは通っている。`upload:` が出れば
`s3 sync` の権限は足りている。**どちらもローカルからは確認できない**
（信頼ポリシーが GitHub OIDC の principal しか受け付けないため、SSO からは assume できない）。
