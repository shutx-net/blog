# 構成

### BlogSiteStack

| リソース | 論理 ID | 要点 |
| --- | --- | --- |
| `AWS::S3::Bucket` | `SiteBucket397A1860` | 配信用。ブロックパブリックアクセス 4 つとも有効 / SSE-S3 / `enforceSSL` / `DeletionPolicy: Retain` / **バージョニングなし** |
| `AWS::S3::BucketPolicy` | `SiteBucketPolicy3AC1D0F8` | SecureTransport=false の Deny と、CloudFront への `s3:GetObject` Allow のみ |
| `AWS::S3::Bucket` | `MediaBucketE52FC6E4` | メディア用。上と同じ設定 + **バージョニング有効**・非現行バージョン 90 日で失効 + **CORS 1 本**（`AllowedOrigins` は `SITE_ORIGIN` 1 本、`AllowedMethods` は `PUT` のみ） |
| `AWS::S3::BucketPolicy` | `MediaBucketPolicyB24E187B` | 同上（`AWS:SourceArn` はこのディストリビューションに限定） |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin1S3OriginAccessControl7D960FE6` | 配信用オリジン。`s3` / `always` / `sigv4` |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA` | メディア用オリジン。同上（**OAC はオリジンごとに別**） |
| `AWS::CloudFront::Distribution` | `SiteDistribution3FF9535D` | `redirect-to-https` / `DefaultRootObject: index.html` / 追加ビヘイビア 3 本（`/media/*` -> `/api/*` -> `/_astro/*` の順。順序に意味がある） / **`HttpVersion: http2and3`** / 403・404 を `/404.html` にマップ |
| `AWS::CloudFront::ResponseHeadersPolicy` | `AssetsHeaders4F00D1B8` | **`/_astro/*` 用**（`Name` は `BlogSiteStack-assets-headers`）。セキュリティヘッダは他 2 本（`SecurityHeadersE66B69D3` / `MediaHeadersD7B00C3A`）と**同一**で、違いは `Cache-Control` が `public, max-age=31536000, immutable` であることだけ（3 本の一致は `test/distribution-response-headers.test.ts` が固定） |
| `AWS::CloudFront::Function` | `RewriteUriFunctionF5D8A5AC` | `cloudfront-js-2.0` / viewer-request（デフォルトビヘイビアのみ） |
| `AWS::Cognito::UserPool` | `AdminAuthUserPoolBFAE8287` | **`AdminAuth`**。管理画面のログイン。`UserPoolTier: ESSENTIALS` / **`AllowAdminCreateUserOnly: true`** / `UsernameConfiguration.CaseSensitive: true` / MFA は TOTP のみ / パスワード 16 文字 / `DeletionProtection: ACTIVE` / `DeletionPolicy: Retain` |
| `AWS::Cognito::UserPoolDomain` | `AdminAuthUserPoolLoginDomain53790831` | **Managed Login**（`ManagedLoginVersion: 2`）。`Domain` は `shutx-blog-admin`（**グローバルに一意な物理名。意図的な例外**） |
| `AWS::Cognito::UserPoolClient` | `AdminAuthUserPoolAdminClient7A4B432D` | public client（`GenerateSecret: false`）。`AllowedOAuthFlows: ["code"]` / `AllowedOAuthScopes: ["openid"]` / **`ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"]` ちょうど** / `PreventUserExistenceErrors: ENABLED` / id・access 60 分・refresh 1 日 |
| `AWS::SecretsManager::Secret` | `PostingApiGitHubAppPrivateKeyBB7A7648` | **`PostingApi`**。GitHub App の秘密鍵。**Properties は `Description` のみ**（空のシークレット）/ `DeletionPolicy: Retain` |
| `AWS::Logs::LogGroup` | `PostingApiFunctionLogGroupCAC55A4B` | `RetentionInDays: 30`。Lambda に作らせず先に作る（実行ロールに `logs:CreateLogGroup` が要らなくなる） |
| `AWS::IAM::Role` | `PostingApiExecutionRoleC51CD7D8` | **`ManagedPolicyArns` を持たない**。マネージドポリシーは 1 つも付けない |
| `AWS::IAM::Policy` | `PostingApiExecutionRoleDefaultPolicy9EF9FB76` | 4 アクションのみ（`logs:CreateLogStream` / `logs:PutLogEvents` / `s3:PutObject` / `secretsmanager:GetSecretValue`）。ワイルドカードも `Resource: "*"` も 0 件 |
| `AWS::Lambda::Function` | `PostingApiFunctionEFE83FA3` | `nodejs24.x` / `ReservedConcurrentExecutions: 2` / **`AUTH_MODE=cognito`** + `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` は `Ref`、`COGNITO_ALLOWED_USERNAME` はリテラル / `Code` は `api/dist` のアセット |
| `AWS::Lambda::Url` | `PostingApiFunctionFunctionUrlCB228805` | **`AuthType: AWS_IAM`**（`NONE` は完全公開になる） |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin3FunctionUrlOriginAccessControl1ACDDE31` | 投稿 API オリジン。`lambda` / `always` / `sigv4` |
| `AWS::Lambda::Permission` | `SiteDistributionOrigin3InvokeFromApi...D7364C80` | `cloudfront.amazonaws.com` に `lambda:InvokeFunctionUrl`。`SourceArn` をこのディストリビューションに限定（confused deputy 対策） |

配信用バケット・バケットポリシー・ディストリビューション・Function・Origin1 の OAC の論理 ID は
**Phase 1 から 1 文字も変わっていない**（＝既存リソースの置換は起きない）。
メディア用 OAC（`...Origin2S3OriginAccessControlE0FE6FAA`）も **Phase 2 から変わっていない**。
Phase 3 の `cdk diff` は新規 8 リソースと Distribution の in-place 更新だけで、**置換も削除も 0 件**。

**`/_astro/*` と HTTP/3 を足した回も同じ形だった**（実測 2026-10-03）。`cdk diff` は新規 1 リソース
（`AssetsHeaders4F00D1B8`）と Distribution の in-place 更新の **2 件だけ**で、`DistributionConfig` の
内訳は `.CacheBehaviors` への 1 要素追加と `.HttpVersion` の `http2` -> `http2and3` のみ。
**置換 0 / 削除 0。** リソース総数は 24 -> 25。オリジンも OAC も 3 本のまま論理 ID は 1 文字も
動いていない（理由は `infra/docs/cloudfront-routing.md` の
「`additionalBehaviors` の宣言順が本番の差分になる」）。デプロイは 56 秒で完了した。

**同じ `cdk diff` に `Outputs[].Description` の差分が 10 件出るが、これは別件の既存ドリフトである。**
デプロイ済みスタック側の Description はマルチバイト文字が `?` に落ちており（`"aws s3 sync ???????"`
に対しローカルは `"aws s3 sync の宛先バケット"`）、10 件とも `Value` は完全に同一でリソースへの影響は無い。
素の `cdk diff` はこれを `Omitted 10 changes because they are likely mangled non-ASCII characters.` と
丸めて隠すので **`--strict` を付けたときだけ見える。** 差分に出ても、このブランチの変更と読み違えないこと。

#### 投稿 API のエンドポイント

| メソッド | パス | 認証 | 備考 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 不要 | `authMode` を返す。**デプロイ後に fail-closed 状態を確認できる** |
| `GET` | `/api/health/github-app` | 必要 | 鍵で installation token を取れるかの **真偽だけ** を返す。`?versionStage=AWSPENDING` で鍵ローテーションを検証できる |
| `POST` | `/api/posts` | 必要 | Git Data API で 1 記事 1 コミット |
| `POST` | `/api/media/presign` | 必要 | presigned PUT URL の発行 |

**`AUTH_MODE` は `deny-all` から `cognito` に切り替えてある。** 認証が必要な 3 経路は
`x-blog-authorization: Bearer <Cognito ID token>` を要求し、pool の JWKS に対して実鍵で検証する。

**トークンの運び方:**

```
x-blog-authorization: Bearer <Cognito ID token>
```

ヘッダ名は **全部小文字**、値は `Bearer` + 半角スペース 1 つ + **ID トークン**（access トークンを
送ると 401 `{"error":"invalid_token"}` — `token_use: 'id'` と `aud` を検証する）。`Authorization`
も Cookie も採らない理由と定数の在りかは `infra/docs/api-auth.md` の
「閲覧者の `Authorization` ヘッダは CloudFront に上書きされる」。

**期待できるステータスは 200 / 201 / 400 / 415 / 401 / 503 だけ。** 認証系の失敗は
**401**（`unauthenticated` / `invalid_token` / `not_authorized`）か
**503**（`auth_not_configured` / `auth_unavailable`）で、JSON の `error` フィールドで区別する。
**403 と 404 は API の認証経路からは絶対に返らない**
（`infra/docs/api-auth.md` の「認証の拒否に 403 と 404 を使わない」）。

**切り戻しは `PostingApi` の `auth` を `{ mode: 'deny-all' }` に戻して deploy し直すだけ**
（`infra/docs/deploy.md` の「デプロイ手順」）。

### BlogCicdStack

| リソース | 論理 ID | 要点 |
| --- | --- | --- |
| `AWS::IAM::OIDCProvider` | `GitHubOidcProvider7EBF861F` | `token.actions.githubusercontent.com` / `ClientIdList: [sts.amazonaws.com]` / **ThumbprintList なし** / `DeletionPolicy: Retain` |
| `AWS::IAM::Role` | `GitHubActionsDeployRoleA6F4AD3D` | 信頼ポリシーは 1 文だけ。`sub` を `repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/main` に `StringEquals` で完全一致固定（**immutable subject claim 形式**。`infra/docs/cicd-oidc.md` の「`sub` の完全一致固定…」を参照） |
| `AWS::IAM::Policy` | `GitHubActionsDeployRoleDefaultPolicy3AC475A7` | 6 アクションのみ。ワイルドカードも `Resource: "*"` も 0 件 |

デプロイロールに与えているのはこの 6 つだけ。

| アクション | Resource | 理由 |
| --- | --- | --- |
| `s3:ListBucket` | 配信バケットの ARN（`/*` なし） | `aws s3 sync` がリモート側を ListObjectsV2 で列挙する |
| `s3:PutObject` | `<配信バケット ARN>/*` | 差分のアップロード |
| `s3:DeleteObject` | 同上 | `sync --delete` |
| `s3:AbortMultipartUpload` | 同上 | 既定で 8MB 超はマルチパート。Abort できないと課金対象の未完了パートが残る |
| `cloudfront:CreateInvalidation` | このディストリビューションの ARN | デプロイ後のキャッシュ無効化 |
| `cloudfront:GetInvalidation` | 同上 | 無効化の完了待ち |

#### GitHub Actions の変数（secret ではなく variable）

`.github/workflows/deploy.yml` はこの 3 つを読む。**3 つとも秘密ではない**ので variable でよい
（漏れても assume は `sub` 条件で守られる）。secret にするとログで `***` にマスクされて
失敗時の切り分けが無駄に難しくなるだけ。

| 変数名 | 値の取得元（`aws cloudformation describe-stacks`） |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `BlogCicdStack` の Output `DeployRoleArn` |
| `SITE_BUCKET` | `BlogSiteStack` の Output `SiteBucketName` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `BlogSiteStack` の Output `DistributionId` |

```sh
gh variable set AWS_DEPLOY_ROLE_ARN -R shutx-net/blog --body "$(aws cloudformation \
  describe-stacks --stack-name BlogCicdStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DeployRoleArn`].OutputValue' --output text)"
gh variable set SITE_BUCKET -R shutx-net/blog --body "$(aws cloudformation \
  describe-stacks --stack-name BlogSiteStack \
  --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' --output text)"
gh variable set CLOUDFRONT_DISTRIBUTION_ID -R shutx-net/blog --body "$(aws cloudformation \
  describe-stacks --stack-name BlogSiteStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)"
```

**実行時に Output を読ませることはできない。** デプロイロールの権限は上の 6 アクションだけで
`cloudformation:DescribeStacks` は入っていない（IAM ポリシーシミュレータで `implicitDeny` を実測）。
足せば `test/cicd-deploy-permissions.test.ts` の `EXPECTED_ACTIONS` が落ちるし、public リポジトリから
assume できるロールにアカウント全体のスタック構成の読み取りを与えることになる。
そもそも鶏と卵がある — CFN を読むには先に assume が要り、assume にはロール ARN が要る。
**ARN だけは絶対に外から渡すしかない。**

いずれの Output にも `ExportName` は無い（`ExportsOutput*` の 2 つだけが CDK のクロススタック
Export）。つまり `Fn::ImportValue` では取れず、`DescribeStacks` でしか読めない。

変数が未設定でも `${{ vars.X }}` は**空文字に展開されるだけでエラーにならない**ので、
deploy.yml の最初のステップに 3 つの名前を名指しする preflight ガードを置いてある。
`test/workflow-deploy-steps.test.ts` が「ガードが 3 つを名指ししている」「checkout より前にある」
「ワークフローが参照する `vars.` の集合がちょうどこの 3 つ」を機械的に固定している。

#### 初回デプロイの手順（人間が実行する）

**assume が成功することはローカルでは一切証明できない。** 信頼ポリシーが GitHub の OIDC
principal しか受け付けないので SSO からは assume できず、`act` を使っても OIDC トークンは
発行されない。ワークフローのテストは「YAML が契約を満たしている」ことしか言えず、
「GitHub が実際にその `sub` を発行する」ことは言えない。**初回実行が唯一の実証である。**

1. 実際に発行される `sub` を確認する（**IAM を deploy する前に**）。
   2026-08-30 に実測済みで `infra/docs/cicd-oidc.md` の「immutable subject claim」の表に
   記録がある。リポジトリを作り直した場合だけやり直すこと
2. `npx -w infra cdk diff BlogCicdStack` を取り、**アカウント ID をマスクして** PR 本文に貼る
   （`AGENTS.md`）。信頼ポリシーの更新はロールの置換を伴わない
   （`AssumeRolePolicyDocument` は更新可能なプロパティ）ので、**ロール ARN は変わらない**
3. `npx -w infra cdk deploy BlogCicdStack`
4. 上の 3 つの変数を `gh variable set` で入れる
5. PR をマージする。`site/**` が変わっていなくても
   `.github/workflows/deploy.yml` がパスフィルタに入っているので deploy が起動する
   （起動しなければ `workflow_dispatch` で回す）
6. 見るべき順に:
   - preflight ガードが通ったか（変数 3 つが入っているか）
   - `Configure AWS Credentials` が成功したか。**ここが唯一ローカルで検証できなかった箇所。**
     失敗するなら `Not authorized to perform sts:AssumeRoleWithWebIdentity` が出る
   - `aws s3 sync` が AccessDenied を出さないか
     （答えは `infra/docs/deploy.md` の「実デプロイで解決した宿題」）
   - `aws cloudfront wait invalidation-completed` が 600 秒以内に返るか
7. 結果を日付つきで `infra/docs/deploy.md` の「実デプロイで解決した宿題」に記録し、
   閉じた宿題は TODO から消す。
   **同時に `test/toolchain.test.ts` の該当アサーションを「もう無い」側に反転させること**
   （宿題が閉じたことをテストで固定する）
8. 事後確認: `aws iam get-role --role-name ... --query 'Role.RoleLastUsed'` が空でなくなっている。
   `https://blog.shutx.net/rss.xml` に `blog.invalid` が **1 度も現れない**こと

AccessDenied が出た場合の足し方は `infra/docs/cicd-oidc.md` の
「デプロイロールに S3 の grant メソッドを使わない」。
**まとめて `s3:*` にしないこと。**

**失敗しても慌てないための性質**: assume に失敗した場合、ワークフローは
`Configure AWS Credentials` で止まる。S3 には何も書かれず、バケットは前の状態のまま。
**ビルドを assume より前に置いているので、壊れたビルドが公開される経路も無い。**

**メディアバケットには一切触れない。** `BlogCicdStack` のテンプレート全文に `MediaBucket` という
文字列が 1 度も現れないことを `test/cicd-deploy-permissions.test.ts` が機械的に確認している。
`AGENTS.md`「サイト配信用とメディア用で S3 バケットを分ける」の目的そのもの —
バケットを分けても CI にメディアへの権限を渡したら意味が無い。

ステートフル資源の論理 ID は `test/media-bucket.test.ts` で集合として固定している。論理 ID が
変わると置換（＝バケット作り直し）になるため、リファクタで動かさないこと。**特に `MediaBucket` は
中身を Git から再生成できない**ので、配信用より重い意味を持つ。
