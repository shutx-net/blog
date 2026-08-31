# infra

- `BlogSiteStack` — 非公開 S3 + CloudFront (OAC) による静的サイト配信。配信用とメディア用の 2 バケット。
- `BlogCicdStack` — GitHub Actions が OIDC で assume する最小権限のデプロイロール。

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

## コマンド

```sh
npm run -w infra test        # pretest で cdk synth（全スタック）してから vitest run
npm run -w infra typecheck   # tsc --noEmit（型検査のみ。テスト実行には使わない）
npx -w infra cdk synth       # スタック名を省くと全スタックを cdk.out に書き出す
npx -w infra cdk diff        # deploy の前に必ず。PR 本文に貼る（AGENTS.md）
```

`test/synth-artifact.test.ts` はディスク上の `cdk.out/*.template.json` を **両スタック分** 読むため、
`pretest` で必ず `cdk synth` を先に走らせている。単体で `vitest run` する場合は先に synth すること。
`pretest` でスタックを名指ししないのは、名指しすると片方のスタックの synth 崩れをテスト前に
検出できなくなるため（`test/toolchain.test.ts` が機械的に固定している）。

`cdk synth` に `--all` というオプションは無い（指定すると `Unknown option(s): --all` と言われて無視される）。

## 構成

### BlogSiteStack

| リソース | 論理 ID | 要点 |
| --- | --- | --- |
| `AWS::S3::Bucket` | `SiteBucket397A1860` | 配信用。ブロックパブリックアクセス 4 つとも有効 / SSE-S3 / `enforceSSL` / `DeletionPolicy: Retain` / **バージョニングなし** |
| `AWS::S3::BucketPolicy` | `SiteBucketPolicy3AC1D0F8` | SecureTransport=false の Deny と、CloudFront への `s3:GetObject` Allow のみ |
| `AWS::S3::Bucket` | `MediaBucketE52FC6E4` | メディア用。上と同じ設定 + **バージョニング有効**・非現行バージョン 90 日で失効 + **CORS 1 本**（`AllowedOrigins` は `SITE_ORIGIN` 1 本、`AllowedMethods` は `PUT` のみ） |
| `AWS::S3::BucketPolicy` | `MediaBucketPolicyB24E187B` | 同上（`AWS:SourceArn` はこのディストリビューションに限定） |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin1S3OriginAccessControl7D960FE6` | 配信用オリジン。`s3` / `always` / `sigv4` |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA` | メディア用オリジン。同上（**OAC はオリジンごとに別**） |
| `AWS::CloudFront::Distribution` | `SiteDistribution3FF9535D` | `redirect-to-https` / `DefaultRootObject: index.html` / `/media/*` の追加ビヘイビア / 403・404 を `/404.html` にマップ |
| `AWS::CloudFront::Function` | `RewriteUriFunctionF5D8A5AC` | `cloudfront-js-2.0` / viewer-request（デフォルトビヘイビアのみ） |
| `AWS::Cognito::UserPool` | `AdminAuthUserPoolBFAE8287` | **`AdminAuth`**。管理画面のログイン。`UserPoolTier: ESSENTIALS` / **`AllowAdminCreateUserOnly: true`** / `UsernameConfiguration.CaseSensitive: true` / MFA は TOTP のみ / パスワード 16 文字 / `DeletionProtection: ACTIVE` / `DeletionPolicy: Retain` |
| `AWS::Cognito::UserPoolDomain` | `AdminAuthUserPoolLoginDomain53790831` | **Managed Login**（`ManagedLoginVersion: 2`）。`Domain` は `shutx-blog-admin`（**グローバルに一意な物理名。意図的な例外**） |
| `AWS::Cognito::UserPoolClient` | `AdminAuthUserPoolAdminClient7A4B432D` | public client（`GenerateSecret: false`）。`AllowedOAuthFlows: ["code"]` / `AllowedOAuthScopes: ["openid"]` / **`ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"]` ちょうど** / `PreventUserExistenceErrors: ENABLED` / id・access 60 分・refresh 1 日 |
| `AWS::SecretsManager::Secret` | `PostingApiGitHubAppPrivateKeyBB7A7648` | **`PostingApi`**。GitHub App の秘密鍵。**Properties は `Description` のみ**（空のシークレット）/ `DeletionPolicy: Retain` |
| `AWS::Logs::LogGroup` | `PostingApiFunctionLogGroupCAC55A4B` | `RetentionInDays: 30`。Lambda に作らせず先に作る（実行ロールに `logs:CreateLogGroup` が要らなくなる） |
| `AWS::IAM::Role` | `PostingApiExecutionRoleC51CD7D8` | **`ManagedPolicyArns` を持たない**。マネージドポリシーは 1 つも付けない |
| `AWS::IAM::Policy` | `PostingApiExecutionRoleDefaultPolicy9EF9FB76` | 4 アクションのみ（`logs:CreateLogStream` / `logs:PutLogEvents` / `s3:PutObject` / `secretsmanager:GetSecretValue`）。ワイルドカードも `Resource: "*"` も 0 件 |
| `AWS::Lambda::Function` | `PostingApiFunctionEFE83FA3` | `nodejs24.x` / `ReservedConcurrentExecutions: 2` / **`AUTH_MODE=cognito`**（Phase 4 で `deny-all` から切り替え）+ `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` は `Ref`、`COGNITO_ALLOWED_USERNAME` はリテラル / `Code` は `api/dist` のアセット |
| `AWS::Lambda::Url` | `PostingApiFunctionFunctionUrlCB228805` | **`AuthType: AWS_IAM`**（`NONE` は完全公開になる） |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin3FunctionUrlOriginAccessControl1ACDDE31` | 投稿 API オリジン。`lambda` / `always` / `sigv4` |
| `AWS::Lambda::Permission` | `SiteDistributionOrigin3InvokeFromApi...D7364C80` | `cloudfront.amazonaws.com` に `lambda:InvokeFunctionUrl`。`SourceArn` をこのディストリビューションに限定（confused deputy 対策） |

配信用バケット・バケットポリシー・ディストリビューション・Function・Origin1 の OAC の論理 ID は
**Phase 1 から 1 文字も変わっていない**（＝既存リソースの置換は起きない）。
メディア用 OAC（`...Origin2S3OriginAccessControlE0FE6FAA`）も **Phase 2 から変わっていない**。
Phase 3 の `cdk diff` は新規 8 リソースと Distribution の in-place 更新だけで、**置換も削除も 0 件**。

#### 投稿 API のエンドポイント

| メソッド | パス | 認証 | 備考 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 不要 | `authMode` を返す。**デプロイ後に fail-closed 状態を確認できる** |
| `GET` | `/api/health/github-app` | 必要 | 鍵で installation token を取れるかの **真偽だけ** を返す。`?versionStage=AWSPENDING` で鍵ローテーションを検証できる |
| `POST` | `/api/posts` | 必要 | Git Data API で 1 記事 1 コミット |
| `POST` | `/api/media/presign` | 必要 | presigned PUT URL の発行 |

**Phase 4 で `AUTH_MODE` を `deny-all` から `cognito` に切り替えた。** 認証が必要な 3 経路は
`x-blog-authorization: Bearer <Cognito ID token>` を要求し、pool の JWKS に対して実鍵で検証する。

**トークンの運び方（`admin/` を作る側が実装する契約）:**

```
x-blog-authorization: Bearer <Cognito ID token>
```

ヘッダ名は **全部小文字**、値は `Bearer` + 半角スペース 1 つ + ID トークン。定数は
`api/src/auth/transport.ts` の `AUTH_HEADER` / `AUTH_SCHEME` として export されている。
**`Authorization` は使えない**（下の「閲覧者の `Authorization` ヘッダは CloudFront に上書きされる」）。
Cookie も使わない（ブラウザが自動で送るため CSRF が成立する。カスタムヘッダなら構造的に防がれる）。

**使うのは ID トークンであって access トークンではない。** `token_use: 'id'` を要求し、
`aud` がアプリクライアント ID と一致することを検証する。access トークンを送ると
**401 `{"error":"invalid_token"}`** になる（access トークンは `aud` ではなく `client_id` を持つ）。

**期待できるステータスは 200 / 201 / 400 / 415 / 401 / 503 だけ。** 認証系の失敗は
**401**（`unauthenticated` / `invalid_token` / `not_authorized`）か
**503**（`auth_not_configured` / `auth_unavailable`）で、JSON の `error` フィールドで区別する。
**403 と 404 は API の認証経路からは絶対に返らない**（下の「認証の拒否に 403 と 404 を使わない」）。

`api/test/unit/router.test.ts` が「503 が返る」ではなく **「コラボレータの呼び出し回数が 0」** を
主張しており、`test/posting-api.test.ts` が環境変数の値を固定している。
**切り戻しは `PostingApi` の `auth` を `{ mode: 'deny-all' }` に戻して deploy し直すだけ**
（下の「デプロイ手順（Phase 4）」）。

### BlogCicdStack

| リソース | 論理 ID | 要点 |
| --- | --- | --- |
| `AWS::IAM::OIDCProvider` | `GitHubOidcProvider7EBF861F` | `token.actions.githubusercontent.com` / `ClientIdList: [sts.amazonaws.com]` / **ThumbprintList なし** / `DeletionPolicy: Retain` |
| `AWS::IAM::Role` | `GitHubActionsDeployRoleA6F4AD3D` | 信頼ポリシーは 1 文だけ。`sub` を `repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/main` に `StringEquals` で完全一致固定（**immutable subject claim 形式**。下の「`sub` の完全一致固定…」を参照） |
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

**実行時に Output を読ませることはできない。** デプロイロールの権限は下の 6 アクションだけで
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
   2026-08-30 に実測済みで下の表に記録がある。リポジトリを作り直した場合だけやり直すこと
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
   - `aws s3 sync` が AccessDenied を出さないか（**下の TODO の答え**）
   - `aws cloudfront wait invalidation-completed` が 600 秒以内に返るか
7. 結果を日付つきでここに記録し、TODO から「`aws s3 sync` の最小権限は未検証」を消す。
   **同時に `test/toolchain.test.ts` の「TODO に『実デプロイ未検証』が残っている」という
   アサーションを、「もう無い」側に反転させること**（宿題が閉じたことをテストで固定する）
8. 事後確認: `aws iam get-role --role-name ... --query 'Role.RoleLastUsed'` が空でなくなっている
   （現在は `{}`）。`https://d8gsxbwzr6ft8.cloudfront.net/rss.xml` に `blog.invalid` が
   **1 度も現れない**こと

AccessDenied が出た場合は `s3:GetObject` → `s3:ListBucketMultipartUploads` →
`s3:ListMultipartUploadParts` の順に **1 つずつ**足し、そのつど `EXPECTED_ACTIONS` と
上の権限表を同時に更新する。**まとめて `s3:*` にしないこと。**

**失敗しても慌てないための性質**: assume に失敗した場合、ワークフローは
`Configure AWS Credentials` で止まる。S3 には何も書かれず、バケットは前の状態のまま。
**ビルドを assume より前に置いているので、壊れたビルドが公開される経路も無い。**

**メディアバケットには一切触れない。** `BlogCicdStack` のテンプレート全文に `MediaBucket` という
文字列が 1 度も現れないことを `test/cicd-deploy-permissions.test.ts` が機械的に確認している。
設計判断5（バケットを分ける）の目的そのもの — バケットを分けても CI にメディアへの権限を渡したら意味が無い。

ステートフル資源の論理 ID は `test/media-bucket.test.ts` で集合として固定している。論理 ID が
変わると置換（＝バケット作り直し）になるため、リファクタで動かさないこと。**特に `MediaBucket` は
中身を Git から再生成できない**ので、配信用より重い意味を持つ。

## 検証結果（aws-cdk-lib 2.267.0 / aws-cdk 2.1139.0 で実測）

### cfn-lint

`validate_cloudformation_template` — **Phase 4 時点の実測（2026-08-31）。**

| スタック | 結果 |
| --- | --- |
| `BlogCicdStack` | **0 error / 0 warning / 0 info** |
| `BlogSiteStack` | **0 error / 1 warning / 0 info**（Phase 3 から変化なし。Cognito 3 リソースと CORS の追加で **1 件も増えなかった**） |

**`E3004`（Circular Dependencies）は 0 件。** これは形式的な確認ではない。
メディアバケットの CORS の `AllowedOrigins` に `distribution.distributionDomainName` を
入れると循環参照になり、**`cdk synth` は exit 0 で素通しする**（実測）。
`E3004` を見ているのが実質的な最後の砦なので、**この確認を省略しないこと**
（下の「`SITE_ORIGIN` 定数」）。

唯一の指摘は **`W3005`**。

```
W3005 'PostingApiExecutionRoleC51CD7D8' dependency already enforced by a 'GetAtt'
      at 'Resources/PostingApiFunctionEFE83FA3/Properties/Role'
```

**トリアージ: 受容する。** これは CDK が `AWS::Lambda::Function` に自動で付ける
`DependsOn: [<Role>DefaultPolicy, <Role>]` のうち、`Role` のほうが `Fn::GetAtt` で
既に暗黙の依存になっているという指摘である。しかし **`DefaultPolicy` への依存は暗黙にはならず、
消すとポリシー添付前に関数が作られて実行時に権限不足になりうる**ため、CDK は意図的に両方を書いている。
ユーザコードから片方だけ削るにはエスケープハッチが要り、得られるのは lint の 1 行、
失うのはデプロイ順序の保証である。割に合わない。

### cfn-guard（bundled `aws-security` ルールセット）

| スタック | 結果 |
| --- | --- |
| `BlogCicdStack` | **0 件（COMPLIANT）** |
| `BlogSiteStack` | **6 件**。すべて S3 関連で、CloudFront・IAM・**Cognito** への指摘は 0 件 |

**Phase 4 時点の実測（2026-08-31）: 6 件のまま、ルール ID も完全に同一。**
`S3_BUCKET_DEFAULT_LOCK_ENABLED` / `S3_BUCKET_LOGGING_ENABLED` / `S3_BUCKET_NO_PUBLIC_RW_ACL` /
`S3_BUCKET_REPLICATION_ENABLED` / `S3_BUCKET_SSL_REQUESTS_ONLY` / `S3_BUCKET_VERSIONING_ENABLED`。

**Phase 4 が新しく増やした指摘は 0 件。** bundled `aws-security` ルールセットには
**Cognito のルールが 1 つも無い。** 次に誰かが同じ検証をしたとき
「6 件のまま＝ツールが動いていない」と誤解しないよう、
**Phase 4 で追加したどのリソースが 1 件も指摘を生まなかったかを列挙しておく。**

- `AWS::Cognito::UserPool`（Essentials / MFA TOTP / パスワード 16 文字 / `DeletionProtection: ACTIVE`）
- `AWS::Cognito::UserPoolClient`（public client / code grant のみ / scope は openid のみ）
- `AWS::Cognito::UserPoolDomain`（Managed Login v2）
- メディアバケットの `CorsConfiguration`（S3 の 5 ルールは **CORS の有無と無関係に**発火するため、
  CORS を足しても件数もルール ID も変わらない）

**Phase 5 時点の実測（2026-08-31）: 6 件のまま、ルール ID も件数も完全に同一。
Phase 5 が新しく増やした指摘は 0 件。**

cfn-lint も変化なし（`BlogSiteStack` は error 0 / warning 1 / info 0。warning は既知の
`W3005`、`PostingApiFunctionEFE83FA3` の冗長な `DependsOn`。`BlogCicdStack` は 0/0/0）。

**Phase 5 で追加して 1 件も指摘を生まなかったリソース:**

- `AWS::CloudFront::ResponseHeadersPolicy`（CSP / X-Content-Type-Options / Referrer-Policy）
- `defaultBehavior` と `/media/*` の `ResponseHeadersPolicyId`

**cfn-guard の出力は 6 件すべて `resource: "Unknown"` を返す。** ルール単位で集約するため、
どのバケットが該当したかは機械的には分からない。`SiteBucket` と `MediaBucket` の
どちらが原因かはルールごとの判断（上のバケット単位トリアージ表）を参照すること。

**Phase 2 が新しく増やした指摘はゼロ。** 6 件は Phase 1 と同一で、ルール ID も同じ。
IAM ロール・IAM ポリシー・OIDC プロバイダ・CloudFront の追加ビヘイビア・`CustomErrorResponses` の
いずれに対しても指摘は出なかった。

**Phase 3 が新しく増やした指摘も 0 件。** 件数は 6 件のままで、ルール ID も完全に同一。
次に誰かが同じ検証をしたとき「6 件のまま＝ツールが動いていない」と誤解しないよう、
**Phase 3 で追加したどのリソースが 1 件も指摘を生まなかったかを列挙しておく。**

- `AWS::Lambda::Function`（`nodejs24.x` / 予約同時実行あり）
- `AWS::Lambda::Url`（`AuthType: AWS_IAM`）
- `AWS::Lambda::Permission`
- `AWS::SecretsManager::Secret`（値の無い空シークレット）
- `AWS::Logs::LogGroup`
- `AWS::IAM::Role` / `AWS::IAM::Policy`（`PostingApi` の実行ロール）
- 3 本目の `AWS::CloudFront::OriginAccessControl`（`lambda` タイプ）
- `/api/*` の追加ビヘイビア

このルールセットはこの構成では原理的に 0 件にできない（指摘どおりに直すと、ログ用バケットが
新たな違反を生んで 6 件 → 8 件に増える）。したがって受け入れ条件は「0 件」ではなく
**「全件をトリアージして理由付きで記録する」** こととする。

違反は `resource: "Unknown"` と **ルール単位に集約されて** 返るため、どのリソースが原因かは
ツール側からは特定できない。バケットが 2 個になったので、下表は **バケットごとに判断を分けて** 書く。

> **重要な観察: メディアバケットに `versioned: true` を入れても `S3_BUCKET_VERSIONING_ENABLED` は消えない。**
> ルール単位の集約なので、テンプレート内に 1 つでも条件を満たさないバケット（＝配信用）があれば
> 発火し続ける。件数だけ見ていると「対応しても減らない」ように見えるが、実際にはメディア側は対応済みである。

| ルール | 配信用 `SiteBucket` | メディア用 `MediaBucket` | 理由 |
| --- | --- | --- | --- |
| `S3_BUCKET_SSL_REQUESTS_ONLY` | **対応済み（誤検知）** | **対応済み（誤検知）** | どちらも `enforceSSL: true` で `aws:SecureTransport=false` の Deny 文が入っている。ルールは remediation に `"Resource":"*"` を期待するが、CDK は Resource をバケット ARN と `<ARN>/*` に絞る。絞ったほうが厳しいので、ルールの形に合わせて緩める理由がない |
| `S3_BUCKET_NO_PUBLIC_RW_ACL` | **対応済み（誤検知）** | **対応済み（誤検知）** | どちらもブロックパブリックアクセス 4 つとも `true`、`AccessControl`（ACL）は未設定。`Principal` がワイルドカードなのは SecureTransport の **Deny** 文だけで、`Allow` のワイルドカードは 0 件（`test/distribution-oac.test.ts` が固定） |
| `S3_BUCKET_VERSIONING_ENABLED` | **意図的に見送り** | **対応済み** | 配信用は `sync --delete` のたびに削除マーカーと旧版が溜まるだけで、中身は Git から完全に再生成できる。メディアは設計判断4 により Git から再生成できない唯一の資産なので有効にし、`noncurrentVersionExpiration: 90 日` で無限増加を防いでいる。**この非対称は意図的**で、`test/media-bucket.test.ts` が両方向を固定している |
| `S3_BUCKET_DEFAULT_LOCK_ENABLED` | **意図的に見送り** | **意図的に見送り** | 配信用は毎デプロイ `sync --delete` で作り直す成果物で、オブジェクトロックは上書き・削除と正面から衝突する。メディアは誤削除対策をバージョニングで足りると判断した（オブジェクトロックは一度有効にすると解除できず、運用の自由度を大きく損なう） |
| `S3_BUCKET_REPLICATION_ENABLED` | **意図的に見送り** | **意図的に見送り（後続フェーズで再検討の余地）** | 配信用は Git から再生成可能なので費用しか生まない。メディアは再生成できないぶん価値はゼロではないが、個人ブログの規模ではバージョニング + `Retain` で足りると判断した |
| `S3_BUCKET_LOGGING_ENABLED` | **意図的に見送り（後続フェーズで再検討）** | **意図的に見送り（後続フェーズで再検討）** | S3 サーバアクセスログには第 3 のバケットが要り、そのバケット自体が新たな違反を生む（実測で 6 件 → 8 件に増える）。必要になった時点で CloudFront 標準ログとあわせて運用フェーズで設計する |

## セキュリティヘッダ / CSP（Phase 5）

`AWS::CloudFront::ResponseHeadersPolicy` を **1 個**作り、**デフォルトビヘイビアと
`/media/*` の 2 つ**に付けている。`/api/*` には**付けない**（JSON 応答に CSP は効かず、
あのビヘイビアは OAC の署名条件で繊細に調整されている）。

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
  style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval';
  script-src-attr 'none';
  connect-src 'self' <Cognito の Managed Login ドメイン> <メディアバケットの regional domain>
```

`connect-src` の 2 つのホストは**構成要素から導出している**（`UserPoolDomain` の `Ref` と
`bucketRegionalDomainName` の `Fn::GetAtt`）。**物理名は書いていない**（AGENTS.md）。

同時に `X-Content-Type-Options: nosniff` / `Referrer-Policy: same-origin` /
`X-Frame-Options: DENY` / `Strict-Transport-Security` も出す。
**Phase 5 より前の実配信は、これらを 1 つも返していなかった**（実測）。

### なぜ CSP なのか（サニタイズしない理由）

admin のプレビューには**実在する XSS 経路**がある。実測で、実パイプラインは Markdown 中の
生 HTML をそのまま通し（`<img src=x onerror=...>` / `<a href="javascript:...">` /
`<svg onload=...>` が出力に残る）、`admin/src/editor/bind.ts` がそれを `innerHTML` に入れる。

**それでもサニタイズは採らない。**

- パイプラインで消毒すると `admin/test/parity/published-html.test.ts` の**バイト一致が壊れる。**
- `bind.ts` の境界だけで消毒すると「プレビューは安全・公開ページは危険」という**乖離**が生まれ、
  プレビューが本番を再現しなくなる（プレビューの存在理由と衝突する）。

**CSP はレスポンスヘッダなので、3 つの一致証明のどれにも触れない。**

### `script-src` に `'unsafe-inline'` を入れない（ここが心臓部）

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

### `style-src` の `'unsafe-inline'` は外せない

実測で site/dist にはインライン `<style>` が **10 個**あり（Astro のスコープ付きスタイル）、
shiki はトークンごとに `style="color:#..."` 属性を吐く。厳格な `style-src 'self'` は
**両方を壊す。** インラインスタイルはスクリプトを実行しないので、`script-src` の厳格さと
引き換えにはならない。送出口は `img-src 'self'` と `connect-src` の限定で塞がっており、
`'unsafe-inline'` は外部 URL を許可しないので `@import url(https://evil/...)` も弾かれる。

**site が `<style>` を吐く限りこのフェーズでは外せない。** `output.test.ts` が
「インライン `<style>` が実在すること」も主張しているので、**外せる状態になったら気づける。**

### `<meta http-equiv>` では配らない

**`frame-ancestors` は `<meta>` では無視される**（CSP 仕様が `report-uri` / `frame-ancestors` /
`sandbox` を meta で無効と明記している）。クリックジャッキング対策を落としたくないので
**ヘッダ一択**。加えて meta は HTML 応答にしか乗らず、パース位置より前のリソースには効かない。
**2 箇所で二重管理するとドリフトするので併用もしない。**

### HSTS に `includeSubDomains` と `preload` を付けない

`max-age` は 1 年（31536000）だが、**`includeSubDomains` も `preload` も付けない。**
`*.cloudfront.net` は**他人と共有するドメイン**なので、サブドメイン全体に HSTS を
宣言するのは「自分のものでないホストに対する宣言」になる。preload リストへの登録は
取り消しが難しく、共有ドメインでは特に不可逆な副作用が大きい。

**独自ドメインに移ったら、この 2 つを付けるかどうかを改めて決めること**
（そのときは自分のドメインなので付けてよい）。

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

**残る「ブラウザが本当にスクリプトを止めたか」は手動確認に送る**（DEVELOPERS.md）。

### デプロイ順序

**CSP は admin より先か同時に出すこと。** トークンをブラウザに置く変更（Phase 5 の admin）が、
緩和の無い状態で先行してはならない。CSP は `cdk deploy`、admin は `aws s3 sync` で
**経路が別**なので片方だけ先に出せてしまう。

CSP は既存のサイトを壊さない（実測: site/dist はインライン `<script>` 0 件・
インラインイベントハンドラ 0 件・外部スクリプト参照 0 件）ので、**admin より先に出しても
副作用が無い。**

## デプロイ手順（Phase 4）

**`cdk deploy` は人間が承認して実行する。**（AGENTS.md: `infra/` を変えた PR では
`cdk diff` の出力を本文に貼る）

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
curl -s https://d8gsxbwzr6ft8.cloudfront.net/api/health
# => {"status":"ok","authMode":"cognito"}
```

**(2) トークン無しで書き込み経路が閉じているか**

```sh
BODY='{}'
SHA=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -H "x-amz-content-sha256: $SHA" \
  -d "$BODY" https://d8gsxbwzr6ft8.cloudfront.net/api/posts
# => 401  （本文は {"error":"unauthenticated"}）
```

**404 の HTML が返ってきたら 403 を返してしまっている** — 設計違反なので直すこと
（あるいは `x-amz-content-sha256` が間違っている。上の切り分け表を参照）。

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

echo "$LOGIN/login?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=https://d8gsxbwzr6ft8.cloudfront.net/admin/"
```

ブラウザで開いて code を取り、`/oauth2/token` で ID トークンに交換してから:

```sh
curl -s -H "x-blog-authorization: Bearer $ID_TOKEN" \
  https://d8gsxbwzr6ft8.cloudfront.net/api/health/github-app
# => 200 {"status":"degraded","canMintInstallationToken":false,...}
```

GitHub App が未作成なので中身は `degraded` でよい。
**200 が返ること自体が「ヘッダが Lambda に届き、JWT 検証が通った」の証拠である。**

**(5) 別ユーザのトークンが弾かれるか**（2 人目を一時的に作って確認し、確認後に削除する）

```sh
# => 401 {"error":"not_authorized"}
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username <2 人目>
```

**(6) `SITE_ORIGIN` 定数のドリフト確認**

```sh
aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
```

`SITE_ORIGIN` の `https://` を除いた部分と一致すること。

**(7) CORS の確認**（admin ができてから）

```sh
MEDIA=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" --output text)
curl -s -D- -o /dev/null -X OPTIONS \
  -H 'Origin: https://d8gsxbwzr6ft8.cloudfront.net' \
  -H 'Access-Control-Request-Method: PUT' \
  "https://$MEDIA.s3.ap-northeast-1.amazonaws.com/media/probe.png"
# => Access-Control-Allow-Origin が CloudFront ドメインで返ること
```

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
| `DistributionDomainName` | 配信ドメイン。**`SITE_ORIGIN` 定数と突き合わせる** |
| `DistributionId` | キャッシュ無効化 |
| `AdminUserPoolId` | `aws cognito-idp admin-create-user --user-pool-id` |
| `AdminUserPoolClientId` | admin の OAuth `client_id` |
| `AdminLoginDomain` | Managed Login の URL |
| `AdminUserPoolIssuerUrl` | ID トークンの `iss`。JWKS は `<issuer>/.well-known/jwks.json` |
| `GitHubAppSecretName` | `aws secretsmanager put-secret-value --secret-id` |
| `PostingApiFunctionName` | 投稿 API の Lambda 関数名 |

Construct の中で作った Output は論理 ID が `<構築子パス><名前><ハッシュ>` になるので、
**`?ends_with(OutputKey, '<名前>')` で引くこと。**

## TODO（本フェーズで意図的に残した宿題）

- **最初の `cdk deploy` の直前に、クロススタック参照の強さをもう一度考えること。**
  `cdk.json` の `@aws-cdk/core:defaultCrossStackReferences` は現在 `strong`。strong は
  Export / `Fn::ImportValue` を使うため、producer である `BlogSiteStack` は consumer が
  存在する限り Export を消せない（deadly embrace）。`weak`（`Fn::GetStackOutput`）なら
  結合を作らない。**weak への切り替えが 1 行で済むのは最初の deploy までである**
  （デプロイ後は `both` → deploy → `weak` の 3 段階移行が要る）。判断の材料は
  「strong の失敗は静かで後から効き、weak の失敗は最初のデプロイで大きな音を立てて落ちる」
- **TLS 最低バージョンを上げられない。** デフォルトの `*.cloudfront.net` 証明書を使う限り
  ディストリビューションは TLSv1 のセキュリティポリシーに固定され、`minimumProtocolVersion` は
  カスタム証明書を指定したときにしか描画されない。カスタムドメイン + ACM を入れるフェーズで
  `SecurityPolicyProtocol.TLS_V1_2_2021` を設定する。`cdk.json` の context に
  `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021: true` を入れて地ならしだけ済ませてある
- **管理画面（`admin/`）がまだ無い。** 本フェーズは admin が実装すべき契約（ヘッダ名・値の形・
  `x-amz-content-sha256`・OAuth のパラメータ・返りうるステータス）を固定するところまで。
  Managed Login からトークンを受け取って `x-blog-authorization` に載せる SPA は別途作る
- **カスタムドメインと ACM。** Cognito の Managed Login も CloudFront も、いまは AWS が配る
  ドメインをそのまま使っている。`SITE_ORIGIN` 定数と `ADMIN_LOGIN_DOMAIN_PREFIX` を差し替えるのは
  このフェーズになる（下の「`SITE_ORIGIN` 定数」）
- **refresh token rotation を入れていない。** Essentials で使えるが、aws-cdk-lib 2.267.0 の
  `configureAuthFlows` が `props.refreshTokenRotationGracePeriod || authFlows.push('ALLOW_REFRESH_TOKEN_AUTH')`
  と書かれており、**有効にすると `ExplicitAuthFlows` から `ALLOW_REFRESH_TOKEN_AUTH` が消える**（実測）。
  この相互作用を検証してから入れること
- **GitHub App がまだ存在しない。** `GITHUB_APP_CLIENT_ID` は `not-configured` というプレースホルダで、
  シークレットも空。App の作成は Web UI でしかできず、鍵の投入は `DEVELOPERS.md` の手順で行う。
  Phase 4 で `AUTH_MODE=cognito` になったので、**認証を通せば GitHub を呼ぶ経路に到達する。**
  ただし秘密鍵が空なので `GET /api/health/github-app` は
  `{"status":"degraded","canMintInstallationToken":false}` を返し、`POST /api/posts` は
  `503 key_not_provisioned` になる。**認証されていない相手はそこに到達できない**ので、
  この状態で deploy しても安全であることは変わらない
- **`env` を明示するのは ACM のフェーズで。** 下の「`env` を明示しない」を参照

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

## 設計上の約束ごと

### CloudFront Function は ES5.1 の範囲で書く

`functions/rewrite-uri.js` は CloudFront Functions のランタイムで動く。ローカルの単体テストは
node 24 の `node:vm` 上で走るため、**実ランタイムより大幅に寛容**で、ローカル green でも
デプロイ後に落ちうる。node 側に ES5.1 相当への静的な制限機構は無いので、規律で守る。

- `var` / `lastIndexOf` / `charAt` の範囲で書く。`const` / `let` / アロー関数 / `endsWith` を使わない
- ランタイムは `cloudfront-js-2.0` に固定してある（CDK の既定は `JS_1_0`。省略すると静かに 1.0 に落ちる）
- テストハーネスはソースの先頭に `'use strict';` を付けて評価する。CloudFront Functions は
  常に strict mode で動作し、これは変更できないため
- 実ランタイムでの検証は、デプロイを行うフェーズで `aws cloudfront test-function` による
  スモークテストとして足す

### エラーページは `/404.html` に解決される

CloudFront の `errorResponses` は 403 と 404 の両方を `ResponsePagePath: /404.html`・
`responseHttpStatus: 404` にマップしている。403 も入れるのは、OAC + S3 REST オリジンでは
バケットポリシーに `s3:ListBucket` が無く、S3 が「存在しない」と「権限が無い」を区別しないため、
存在しないキーが 404 ではなく 403 (AccessDenied) で返るからである。

- **`/404.html` は S3 のキー `404.html` に解決される。** Astro は `src/pages/404.astro` を
  `build.format` に関わらず `dist/404.html` として出す特別扱いをするが、これは infra からは
  検証できない（別ワークスペース）。もし `dist/404/index.html` になっていると
  エラーページ自体が 403 になって無意味になるので、site トラック側のビルド出力テストで固定すること
- **`CustomErrorResponses` は `DistributionConfig` 直下にあり、ビヘイビア単位ではなく
  ディストリビューション全体に効く。** したがって存在しない `/media/xxx.png` へのリクエストは
  403 → HTML の 404 ページ（`Content-Type: text/html`）を 404 ステータスで返す。`<img>` から見ると
  壊れた画像になるが、害は無いので受け入れる。ビヘイビア単位にする方法は CloudFront に存在しない
- `ErrorCachingMinTTL` は既定と同じ 10 秒を明示している。既定と同値でも、明示すると
  テンプレートに描画されてテストで固定でき、将来 300 秒などに変えたときに差分として見える

### 記事スラッグにドットを使わない

URI 書き換えは「最後のスラッシュより後にドットがあれば静的ファイル」というヒューリスティック。
そのため `/posts/node-24.19-notes` のようなドット入りスラッグは書き換えられない
（`test/rewrite-uri.test.ts` に既知の限界として固定済み）。
`site/src/content.config.ts` の Zod スキーマでスラッグを検証する際にドットを弾くこと。

### メディアバケットを別 Stack にできない（実験で確定済み）

設計判断5 が要求しているのは「**バケット**を分ける」ことであって「**スタック**を分ける」ことではない。
`sync --delete` からメディアを守る目的は、同一スタック内の別バケットで完全に満たされる。
`MediaBucket` は `lib/media-bucket.ts` の Construct として `SiteStack` の中に置いてある。

これは好みではなく、別 Stack が **物理的に不可能** だと実験で確定したためである。
`BlogMediaStack` がバケットを持ち、`SiteStack` の Distribution が `additionalBehaviors` で
参照する版を実際に書いて `cdk synth` すると、こう落ちる。

```
[«DependencyCycle» 'BlogMediaStack' depends on 'BlogSiteStack'
 (BlogMediaStack -> BlogSiteStack/SiteDistribution/Resource.Ref).
 Adding this dependency (BlogSiteStack -> BlogMediaStack/MediaBucket/Resource.RegionalDomainName)
 would create a cyclic reference.]
```

原因は依存が双方向になること。`aws-cloudfront-origins/lib/s3-bucket-origin.js` の
`grantDistributionAccessToBucket()` を読むと、`withOriginAccessControl()` は
`bucket.addToResourcePolicy()` を呼び、`AWS:SourceArn` 条件に Distribution の `Ref` を埋め込む。
つまり **バケット側のポリシーが Distribution を参照する**。同時に Distribution の
`Origins[].DomainName` は **バケットの `RegionalDomainName` を参照する**。別スタックにあると
この 2 本が逆向きのクロススタック参照になって循環する。

回避策はどれも代償が大きく、**採ってはならない**。

- バケットに物理名をハードコードして `fromBucketAttributes` で import する — 「物理名を
  ハードコードしない」方針に反するうえ、import したバケットには `addToResourcePolicy` が効かず、
  CDK が `Cannot update bucket policy of an imported bucket` と **警告するだけで失敗せず、
  バケットポリシーが黙って作られない**。confused deputy 対策を手書きで維持する羽目になる
- `SourceArn` をワイルドカードに緩める — セキュリティを落として構造の都合を通すことになり本末転倒

将来どうしても別スタックにしたくなったら、Distribution も一緒に移すか、メディア専用の
第 2 ディストリビューションを立てるしかない。

対照的に `CicdStack` は Stack にしてよい。参照が **一方向** だからである（`CicdStack` は
`SiteStack` のバケット ARN とディストリビューションを読むだけで、`SiteStack` 側に何も書き込まない）。
`cdk_best_practices` の「Model with constructs, deploy with stacks — Represent logical units as
Construct, not Stack. Use stacks only for deployment composition」とも一致する。

### `AWS_IAM` + OAC はエンドユーザ認証ではない

**これを取り違えると、公開の書き込みエンドポイントをデプロイすることになる。**

`AWS::Lambda::Url` の `AuthType` は `AWS_IAM` で、Function URL に直接アクセスしても
SigV4 署名が無ければ 403 になる。しかしそれが防いでいるのは **Function URL への直接アクセスだけ**である。

OAC の `SigningBehavior` は `always`。CloudFront は **到達したすべてのリクエストに自分で署名を付けて**
オリジンに渡す。つまり `https://<distribution>/api/posts` に **誰が POST しても Lambda は起動する。**
匿名でも起動する。`AWS_IAM` は CloudFront 経由の匿名アクセスを一切止めない。

書き込みを止めているのは Lambda 側の `AUTH_MODE=deny-all` のほうである。

- 環境変数 `AUTH_MODE` は **必須**。未設定・未知の値ならコールドスタートで例外になり、
  CloudFront には 502 が返る。「黙って全許可」にならないための設計
- 認可判定は **ルータのディスパッチ前**にある。拒否時に GitHub クライアント・presigner・
  SecretReader を **一切呼ばない**（`api/test/unit/router.test.ts` が呼び出し回数 0 を主張）
- `test/posting-api.test.ts` が `Environment.Variables.AUTH_MODE == 'deny-all'` を固定しているので、
  緩めるときは必ずテストを直すことになる

さらに本フェーズでは GitHub App 自体が存在せずシークレットも空なので、仮に上を全部すり抜けても
書き込みは成立しない。**この状態でのデプロイは安全である。**

> **初回デプロイ後の確認。** AWS のドキュメントは OAC から Lambda function URL を叩くのに
> `lambda:InvokeFunctionUrl` と `lambda:InvokeFunction` の 2 つを `add-permission` する例を示しているが、
> CDK が生成する `AWS::Lambda::Permission` は `InvokeFunctionUrl` の 1 つだけである。
> 初回デプロイ後に `GET /api/health` が **HTTP 403 (AccessDenied)** で返るなら、
> 不足しているのは後者。`lambda:InvokeFunction` を明示的に足すこと（`lambda:*` にはしない）。

### POST / PUT では呼び出し側が `x-amz-content-sha256` を付ける必要がある

CloudFront + Lambda Function URL の OAC 構成では、**呼び出し側（＝ブラウザ / 管理画面）が
ボディの SHA256 を `x-amz-content-sha256` ヘッダに入れなければならない。** AWS のドキュメントの原文:

> If you use PUT or POST methods with your Lambda function URL, your users must compute the SHA256
> of the body and include the payload hash value of the request body in the `x-amz-content-sha256`
> header when sending the request to CloudFront. **Lambda doesn't support unsigned payloads.**

**この制約は API 側では吸収できない**（署名は CloudFront が行い、Lambda が検証する）。
知らずに管理画面を書くと、原因の分かりにくい署名エラーに時間を溶かす。
**admin フェーズの最初のタスクを「fetch ラッパで `x-amz-content-sha256` を必ず付ける」にすること。**
本フェーズは deploy しないので実地検証はできていない。

### 閲覧者の `Authorization` ヘッダは CloudFront に上書きされる

OAC の `SigningBehavior` が `always` である帰結として、CloudFront は自分の SigV4 署名を
`Authorization` ヘッダに書く。**閲覧者が送った `Authorization` は失われる。**

したがって ID トークンを `Authorization: Bearer` で送る一般的な設計は **そのままでは使えない**。
`no-override` に切り替える手もあるが、そうすると今度は **ブラウザ側が Lambda URL のホストに対して
SigV4 署名を行う必要**が生じ、SPA では現実的でない。

#### 解決策（Phase 4 で確定）

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
観測できない。**下の「デプロイ手順（Phase 4）」の手順 4 で実地確認すること。**

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
見える（Phase 2 の判断）。**よって直すべきは CloudFront ではなく API 側のステータス選択である。**

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

**Lite ではなく Essentials。理由は Managed Login。**

- AWS 開発者ガイド:「Managed login is available in the **Essentials and Plus tiers**.
  The classic hosted UI is available in all feature tiers.」
- AWS 料金ページ: 無料枠は Lite も Essentials も **10,000 MAU / 月・アカウント**で、
  「The free tier does not automatically expire ... available to both existing and new AWS
  customers indefinitely」。

**MAU 1 では Lite と Essentials の請求額はどちらも 0 円なので、安いほうを選ぶ動機が存在しない。**
Essentials は `CreateUserPool` の既定でもある。

**Plus は採らない。** 料金ページに「There is no free tier for the Plus tier.」とあり、
threat protection（旧 advanced security features）に MAU 1 の個人ブログが月額を払う理由が無い。

### `SITE_ORIGIN` 定数

`infra/lib/site-stack.ts` に配信ドメインを **文字列でハードコードしている。**
「物理名をハードコードしない」方針の **意図的な例外**である。

```ts
export const SITE_ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';
```

**理由 1: `distribution.distributionDomainName` は原理的に使えない。**
`CorsConfiguration` は `AWS::S3::Bucket` **本体**のプロパティなので、そこに Distribution の
`Fn::GetAtt` を入れると循環参照になる。

```
Media.Properties.CorsConfiguration...AllowedOrigins = Fn::GetAtt [Dist, DomainName]
Dist.Properties...Origins[0].DomainName            = Fn::GetAtt [Media, RegionalDomainName]
```

**実測（実際に循環を作って確認した）:**

| 検出手段 | 結果 |
| --- | --- |
| `npx -w infra cdk synth` | **exit 0 で成功する。** CLI は同一スタック内のリソース間循環を検出しない |
| `Template.fromStack()`（vitest） | **throw する。** ただしテストファイルの読み込み時点で落ちるので、どのアサーションが何を言っているか分からない（全 `it` が消える） |
| cfn-lint | **E3004** で検出する |

`cdk synth` だけを回していると `cdk deploy` で初めて分かる。だから
`test/media-bucket.test.ts` に「**`AWS::S3::Bucket` の `Properties` から Distribution を
`Fn::GetAtt` している箇所が 1 つも無い**」という名指しの回帰テストを置いてある。
バケットポリシー（別リソース）が Distribution を参照するのは問題ない。

**理由 2:** 同じ値が Cognito の `CallbackURLs` でも必要で、どのみち synth 時に確定した
文字列でなければならない。**CORS と `CallbackURLs` の両方がこの 1 定数を参照する**
（2 か所に別々の文字列を書くと「ログインはできるが画像が上がらない」という
デバッグしにくい壊れ方をする）。

**理由 3:** カスタムドメインを入れるフェーズで、この 1 定数を差し替えるだけで済む。

**この定数を変えるのは CloudFront のドメインが変わったときだけ。** ドリフトの確認:

```sh
aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
```

`ADMIN_LOGIN_DOMAIN_PREFIX`（`shutx-blog-admin`）も同じ性質の例外である。Cognito の
プレフィックスドメインは **AWS グローバルで一意**でなければならず、CDK に自動生成させられない。
他アカウントに取られていれば `cdk deploy` が明示的なエラーで落ちるだけなので静かには壊れない。
**アカウント ID を混ぜて一意性を上げる案は採らない** — Managed Login の URL は利用者の
ブラウザに表示されるので、そこに AWS アカウント ID を載せたくない。

### `/api/*` のビヘイビアで既定に任せてはいけない 4 つ

| 設定 | 既定 | 既定のままだと |
| --- | --- | --- |
| `allowedMethods` | `GET` / `HEAD` | **POST が 405 になる** |
| `cachePolicy` | `CACHING_OPTIMIZED` | API の応答がキャッシュされる |
| `originRequestPolicy` | なし | — （`ALL_VIEWER` にすると `Host` が転送され、**OAC の署名が必ず失敗する**） |
| `viewerProtocolPolicy` | — | `redirect-to-https` にすると **リダイレクトで POST のボディが失われる**。`https-only` で拒否する |

`functionAssociations` は **付けない**。URI 書き換え Function は拡張子の無いパスに `/index.html` を
足すので、`/api/posts` が `/api/posts/index.html` になって 404 になる。
`test/distribution-api-behavior.test.ts` が 4 つとも固定している。

### 投稿 API も別 Stack にできない（ただし理由が上とは違う）

`PostingApi` も `lib/posting-api.ts` の Construct として `SiteStack` の中にある。
**同じ結論だが、原因はメディアバケットのときとは別物である。** ここを
「OAC だから循環する」と丸めて覚えると、メディアバケットに触らない別の Lambda まで
不要に `SiteStack` へ押し込むことになる。

`FunctionUrlOrigin.withOriginAccessControl()` は `S3BucketOrigin` と **形が違う**。
`s3-bucket-origin` はバケット側のリソースポリシーを書き換えるので、バケットのスタックに
Distribution の `Ref` が入る。対して `function-url-origin` の `addInvokePermission()` は
`new lambda.CfnPermission(scope, ...)` を **bind の scope（＝ Distribution 側のスタック）** に作る。
実測でも `AWS::Lambda::Permission` は `BlogSiteStack` 側に生成され、参照は
`SiteStack -> ApiStack` の一方向で済む。**つまり OAC だけなら別スタックにできる。**

循環させているのは presigned URL 側の要件のほうである。

- Lambda はメディアバケットの **名前** を環境変数で知る必要がある（Api -> Site）
- Lambda の IAM は同バケットの ARN に `s3:PutObject` を必要とする（Api -> Site）
- Distribution は Function URL を必要とする（Site -> Api）

実測エラー（環境変数だけの版でも起きる）。

```
'BlogSiteStack' depends on 'BlogApiStack'
 (BlogSiteStack -> BlogApiStack/Api/Function/FunctionUrl/Resource.FunctionArn).
 Adding this dependency (BlogApiStack -> BlogSiteStack/MediaBucket/Bucket/Resource.Ref)
 would create a cyclic reference.
```

正確な条件は「**Distribution が参照するリソースと、そのリソースが参照する `SiteStack` 内の
リソースが両方存在すること**」。将来どうしても分けたくなったら、メディアバケットも
Distribution も一緒に動かすしかない。

### `additionalBehaviors` の宣言順が本番の差分になる

`additionalBehaviors` のキー順は **`/media/*` -> `/api/*` から変えてはいけない。**

CDK は `Object.entries` の順（＝挿入順）でオリジンに `Origin1` / `Origin2` / `Origin3` と
番号を振り、OAC の論理 ID はその番号から作られる。実測で `/api/*` を先に書くと、
メディア用 OAC の論理 ID がこう変わる。

| 宣言順 | メディア用 OAC の論理 ID |
| --- | --- |
| `/media/*` -> `/api/*`（正） | `SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA` |
| `/api/*` -> `/media/*`（誤） | `SiteDistributionOrigin3S3OriginAccessControl4BE73D82` |

機能は同じだが、デプロイ時に **OAC の置換とバケットポリシーの書き換え** が起きる。
ソース上まったく見えない依存なので、`test/distribution-oac.test.ts` が OAC の論理 ID 集合を
リテラルで固定している。

### OIDC プロバイダにサムプリントを書かない

`iam.OidcProviderNative`（`AWS::IAM::OIDCProvider`）に `thumbprints` を **渡していない**。
古い記事に出てくる `6938fd4d98bab03faadb97b34396831e3780aea1` のような固定値をコピーすると、
GitHub が証明書を切り替えた日に assume が全部落ちる時限爆弾になる。

根拠は AWS のドキュメント（IAM User Guide "Obtain the thumbprint for an OpenID Connect identity
provider" および `iam:UpdateOpenIDConnectProviderThumbprint` の API リファレンス）の記述である。

> Amazon Web Services secures communication with OIDC identity providers (IdPs) using our library of
> trusted root certificate authorities (CAs) to verify the JSON Web Key Set (JWKS) endpoint's TLS
> certificate. If your OIDC IdP relies on a certificate that is not signed by one of these trusted
> CAs, only then we secure communication using the thumbprints set in the IdP's configuration.

GitHub のように公的な CA に署名された IdP では、そもそもサムプリントが使われない。
`AWS::IAM::OIDCProvider` の CloudFormation リファレンスでも `ThumbprintList` は `Required: No` で、
「省略すると IAM が OIDC プロバイダのサーバ証明書の中間 CA サムプリントを取得して使う」とある。
`test/cicd-oidc-trust.test.ts` が `ThumbprintList` 不在をテストで固定している。

**あわせて、レガシーの `iam.OpenIdConnectProvider` は使わない。** aws-cdk-lib 2.267.0 の
`aws-iam/lib/oidc-provider.d.ts` に「DO NOT ADD NEW FEATURES TO THIS CONSTRUCT」「maintained for
backward compatibility only」「For new functionality, developers should use OidcProviderNative
instead」と明記されている。実装を読むと、レガシー版は `Custom::AWSCDKOpenIdConnectProvider` という
カスタムリソースを作り、その裏の Lambda 実行ロールに `iam:CreateOpenIDConnectProvider` /
`iam:DeleteOpenIDConnectProvider` / `iam:UpdateOpenIDConnectProviderThumbprint` などを
`Resource: "*"` で付与する。**IAM の ID プロバイダを丸ごと操作できる Lambda がアカウントに常駐する**
ことになり、「public リポジトリの CI に最小権限を与える」という `CicdStack` の主題と真っ向から衝突する。
テストは `AWS::Lambda::Function` と `AWS::CloudFormation::CustomResource` が 0 個であることを
機械的に禁止している（レガシー版に差し替えると 16 件のアサーションが落ちることを実測確認済み）。

`removalPolicy: RETAIN` を明示しているのも重要（CDK の既定は `DESTROY`）。OIDC プロバイダは
**URL ごとにアカウントに 1 つしか作れない共有資源** で、`CicdStack` を消すと同じプロバイダを
信頼している他のロールが全部壊れる。逆に、同じアカウントで別のプロジェクトが既に
`token.actions.githubusercontent.com` のプロバイダを作っていると `cdk deploy` が
`EntityAlreadyExists` で失敗する。その場合は新規作成をやめて
`iam.OidcProviderNative.fromOidcProviderArn(...)` で既存を import する分岐に切り替えること
（ARN は `cdk.json` の context で渡す形が素直）。認証情報が無いので既存の有無は実デプロイまで分からない。

### `sub` の完全一致固定がワークフロー YAML に課す制約

信頼ポリシーの `sub` を `repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/main` に
`StringEquals` で **完全一致固定** している。これは GitHub 側の挙動と結合した契約なので、
ワークフロー YAML では次を必ず守ること。

- **トリガは `main` への push**（または `main` を ref とする `workflow_dispatch`）。
  `pull_request` で走らせると `sub` は `...:pull_request` になって assume が失敗する
- **ジョブに `environment:` を付けない。** 付けると `sub` は
  `...:environment:<name>` になって assume が失敗する
- ジョブに `permissions: { id-token: write, contents: read }` が要る
- **ロール ARN は YAML に直書きせず、GitHub Actions の変数（secret ではなく variable でよい）から読む。**
  public リポジトリに AWS アカウント ID を晒す必要は無い。ARN は `DeployRoleArn` の CfnOutput で出る

これらは `test/workflow-deploy-oidc.test.ts` が `DEPLOY_SUBJECT` から期待値を**導出**して
機械的に固定している。定数を書き換えたらワークフロー YAML も直さないと落ちる。

**緩めて回避しないこと。** `StringLike` に落とした瞬間にこのスタックの主要な成果が失われる。

#### immutable subject claim（2026-07-15 の変更への追随。実測 2026-08-30）

GitHub は 2026-07-15 に OIDC の subject claim の既定形式を変更した。
同日以降に**作成された**リポジトリは、オプトインの有無に関わらず既定で
`repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH` という **immutable 形式**を発行する
（同日以降のリネームや移管も同様に移行する）。区切りに `@` が選ばれているのは、
GitHub のユーザ名にもリポジトリ名にも `@` が現れ得ないため。

本リポジトリの実測値（2026-08-30 に `gh` で取得）:

| 取得コマンド | 値 |
| --- | --- |
| `gh api repos/shutx-net/blog --jq .created_at` | `2026-08-30T06:14:14Z`（**カットオフの 46 日後**） |
| `gh api users/shutx-net --jq .id` | `169037737` |
| `gh api repos/shutx-net/blog --jq .id` | `1351152011` |
| `gh api repos/shutx-net/blog/actions/oidc/customization/sub` | `{"use_default":true,"use_immutable_subject":false,"sub_claim_prefix":"repo:shutx-net@169037737/blog@1351152011"}` |

`use_immutable_subject: false` は「**明示的にオプトインしていない**」の意味であって
「legacy を使う」の意味ではない。カットオフ後に作られたリポジトリは既定が immutable なので、
オプトインの有無に関わらず immutable になる。API が返す `sub_claim_prefix` がまさに
immutable 形式そのものであることが、この読み方を裏づけている。

Phase 2 の時点の値（`repo:shutx-net/blog:ref:refs/heads/main`）のままだと、**初回デプロイが
`Not authorized to perform sts:AssumeRoleWithWebIdentity` で必ず落ちる。**

**効能と限界。** 名前ではなく ID で固定するので、リポジトリ名もオーナー名も変えて構わない。
逆に **リポジトリを作り直すと `repo_id` が変わって壊れる**。その場合は `cicd-stack.ts` の
`GITHUB_OWNER_ID` / `GITHUB_REPOSITORY_ID` を実測値で更新して deploy し直すこと
（`AssumeRolePolicyDocument` は更新可能なプロパティなのでロールの置換は起きず、ARN も変わらない）。

**実トークンで確認済み。** 一時的な probe ワークフロー（`workflow_dispatch` 限定、AWS 非依存、
トークンをマスクして `sub` と `aud` だけを出力）を作業ブランチで 1 回回して実測し、
役目を終えたので削除した。

| 実測日 | 実際に発行された `sub` | 判定 |
| --- | --- | --- |
| 2026-08-30 | `repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/<branch>` | immutable 形式。`DEPLOY_SUBJECT` と一致 |

**`gh api repos/shutx-net/blog/actions/oidc/customization/sub` が返す
`use_immutable_subject: false` は誤導である。** 同じ応答の `sub_claim_prefix` は immutable 形式を
返しており、実際に発行されるトークンも immutable 形式だった。この 2 つが食い違って見えるので、
ドキュメントだけで判断してはいけない。

再確認が必要になったら（リポジトリの作り直し、オーナー移管など）、probe を作り直すより
`gh api .../actions/oidc/customization/sub` の `sub_claim_prefix` を見るのが速い。
実測が要るときは `id-token: write` だけを持つ `workflow_dispatch` のジョブで
`ACTIONS_ID_TOKEN_REQUEST_URL` を叩き、**JWT を即 `::add-mask::` してから**
ペイロードの `sub` だけを出す。public リポジトリのログは誰でも読める。

なぜここまで厳しくするかというと、**IAM 自身のガードが弱いから**である。AWS のドキュメントは
「IAM checks the role trust policy condition to verify that the condition key
`token.actions.githubusercontent.com:sub` is present and that its value is not solely a wildcard
character (`*` and `?`) or null」としか言っていない。つまりリポジトリ名もブランチ名も
ワイルドカードにした sub は IAM の検査を通過してしまう。public リポジトリなので
ロール ARN は漏れる前提で考える必要がある。`test/cicd-oidc-trust.test.ts` は 6 方向から囲っている。

1. 信頼ポリシーの文がちょうど 1 つ（正しい文の隣にゆるい第 2 の文を足す裏口を禁止する）
2. `Principal` のキー集合が `["Federated"]` ちょうどで、このスタックの OIDCProvider を指す
3. `Condition` の演算子キー集合が `["StringEquals"]` ちょうど
4. `StringEquals` のキー集合が `aud` と `sub` ちょうど 2 つ
5. それぞれの値が完全一致（定数とリテラルの両方に対して主張する）
6. 信頼ポリシー全文にワイルドカード文字が 1 つも無い

実効性は 8 種類のミューテーションで実測確認済み（それぞれ 1〜16 件のアサーションが赤くなる）。

| 改変 | 赤くなるアサーション |
| --- | --- |
| (a) `sub` 条件を丸ごと消す | 3 件 |
| (b) `StringEquals` → `StringLike` + ワイルドカード | 6 件 |
| (c) `sub` → `repository_owner` に差し替え | 3 件 |
| (d) `aud` 条件を消す | 2 件 |
| (e) どのリポジトリからでも assume できる `sub` | 3 件 |
| (f) レガシーの `OpenIdConnectProvider` に差し替え | 16 件 |
| (g) 古い固定サムプリントを足す | 1 件 |
| (h) `removalPolicy: RETAIN` を落とす | 1 件 |

**GitHub environment を使う代替案。** `sub` を `repo:shutx-net/blog:environment:production` に固定し、
environment 側の保護ルールでブランチを縛るという選択肢もある（AWS のドキュメントも
"we strongly recommend adding protection rules to the environment" と推奨している）。
採らなかったのは、GitHub 側の手作業設定が増え、infra のテストからは検証できなくなるため。

### デプロイロールに S3 の grant メソッドを使わない

`cdk_best_practices` は「Use grant methods for permissions instead of manual IAM policies」と言うが、
**S3 についてはこれに従っていない。** `aws-cdk-lib/aws-s3/lib/perms.js` を実際に読むと
`bucket.grantWrite()` が展開する集合はこうなっている。

- `BUCKET_PUT_ACTIONS` = `s3:PutObject` / `s3:PutObjectLegalHold` / `s3:PutObjectRetention` /
  `s3:PutObjectTagging` / `s3:PutObjectVersionTagging` / `s3:Abort*`
- `BUCKET_DELETE_ACTIONS` = `s3:DeleteObject*`

必要な 3 個に対して 7 個で、しかも `s3:Abort*` と `s3:DeleteObject*` という **ワイルドカードを含む**。
`s3:DeleteObject*` はバージョン付きバケットでは `s3:DeleteObjectVersion` まで含んでしまう。
public リポジトリから assume できるロールにワイルドカードのアクションを入れないという方針を優先し、
ここは明示列挙にしている。

逆に **CloudFront は `grantCreateInvalidation()` を使う。** 実測で
`arn:<partition>:cloudfront::<account>:distribution/<id>` にスコープされた 1 アクションだけを吐き、
手書きより正確で短い（`Resource: '*'` にならない）。

**`s3:GetObject` は付与していない。** ローカル → S3 方向の `aws s3 sync` は ListObjectsV2
（`s3:ListBucket`）でリモート側を列挙し、サイズと更新時刻で比較して PutObject するだけで
GetObject は使わない、というのが根拠。**ただしこれは実デプロイで確認していない**（認証情報が無い）。
最初の sync で AccessDenied が出たら、エラーメッセージが名指しする API に対応するアクションを
`s3:GetObject` → `s3:ListBucketMultipartUploads` → `s3:ListMultipartUploadParts` →
`s3:PutObjectTagging` の順に **1 つずつ** 足すこと。**まとめて `s3:*` にしないこと。**
足したアクションと理由をこの README に追記し、`test/cicd-deploy-permissions.test.ts` の
`EXPECTED_ACTIONS`（完全一致）も同時に更新する。完全一致なのでこっそり広げると必ず落ちて気づける。

`s3:PutObjectAcl` も入れていない（ブロックパブリックアクセスが 4 つとも有効で ACL は使わないため）。

### 複数リソースに対するアサーションの書き方

第 2 バケットの追加で、Phase 1 のアサーションのうち 4 件が「**落ちないまま静かに弱くなった**」。
`hasResource` / `hasResourceProperties` / `Array.prototype.find` はいずれも
「**1 件でも** 一致すれば通る」ため、リソースが 1 個から 2 個になった瞬間に
「全部が満たす」から「どれか 1 個が満たす」へ退化する。
`Template.allResourcesProperties` が該当 0 件で通る（Phase 1 で踏んだ）罠の **兄弟** で、
向きが逆であり、**赤くならないぶん見つけにくい**。

実測で確認した退化の例（いずれも締め直し前は緑のままだった）。

| 改変 | 締め直し前 | 締め直し後 |
| --- | --- | --- |
| `SiteBucket` を `RemovalPolicy.DESTROY` にする | `site-bucket.test.ts` 8/8 緑 | 赤 |
| `SiteBucket` から `encryption` を外す | `site-bucket.test.ts` 8/8 緑 | 赤 |
| `MediaBucket` から `enforceSSL` を外す | `site-bucket.test.ts` 8/8 緑 | 赤 |
| メディアオリジンを OAC 無しで結線する | `AWS:SourceArn` のアサーションが緑 | 赤 |

以後、リソースが複数になりうる型に対しては次の 4 つの型のいずれかで書くこと。

1. リソース横断の不変条件 → `template.allResourcesProperties(type, {...})`。
   ただし **直前に必ず件数の非空ガードを置く**
2. `DeletionPolicy` / `UpdateReplacePolicy` のように Properties の外にあるものは
   `allResourcesProperties` では書けないので、`findResources(type)` の戻り値を全件ループする。
   件数アサーションを先に置く
3. 特定リソース固有の主張（配信用だけバージョニング無効、等）は **論理 ID で名指し** して
   `findResources(type)[LOGICAL_ID]` を取り、存在を確かめてから中身を見る。名指しが非空ガードを兼ねる
4. `Array.prototype.find` は filter + 件数アサーション + 全件ループに置き換える

`site-bucket.test.ts`（配信用を名指し）と `media-bucket.test.ts`（全バケット走査）は
一見重複しているが、**重複させておくのが正しい**。片方が将来消えたり書き換えられたりしても、
もう片方に保証が残る。

**なお `removalPolicy: RemovalPolicy.RETAIN` の行を消すのは改変にならない。**
`s3.Bucket` の `removalPolicy` の既定が `RETAIN` なので、行を消してもテンプレートは 1 バイトも
変わらない（実測で確認）。ミューテーションテストを書くときは `DESTROY` を明示すること。

### cdk_best_practices との既知の乖離

いずれも意図的。

- **`env` を明示していない（Phase 1 の記述を撤回する）。** Phase 1 の README は
  「`env` はデプロイを扱う `CicdStack` のフェーズで導入する」と書いたが、**これは撤回する。**
  理由は 2 つ。(1) `CicdStack` を作る本フェーズでも AWS 認証情報が無く、
  `env: { account: process.env.CDK_DEFAULT_ACCOUNT, ... }` と書いても認証情報の有無で
  テンプレートが変わってしまう — アサーションテストが環境依存になる。(2) `CicdStack` で必要な
  ARN はすべて `AWS::Partition` / `AWS::AccountId` の疑似パラメータで組める（実測で確認）。
  `env` が本当に要るのは ACM 証明書を us-east-1 に置く必要が出るカスタムドメインのフェーズなので、
  そこに送る
- **ステートフル（S3）とステートレス（CloudFront）を同一スタックに置いている。**
  個人ブログでバケットの中身は Git から完全に再生成できるビルド成果物であり「ステートフル」の
  実質が薄い。スタックを割るとクロススタック参照が増え、`withOriginAccessControl` による
  バケットポリシーの自動更新（同一スタック内で行われる）が使えなくなる副作用のほうが大きい
- **`terminationProtection` を設定していない。** `removalPolicy: RETAIN` でバケット自体は
  保護しており、個人ブログの規模には過剰と判断した
- **`cdk init` を使っていない。** 空ディレクトリを要求し独自の `package.json` と jest 構成を
  吐くうえ、CDK CLI が PATH に無く `npx -w infra cdk` は `infra/package.json` が先に無いと
  呼べない（鶏と卵）。そのため `cdk.json` の context（フィーチャーフラグ）は手で書いている
- **cdk-nag を入れていない。** `cdk_best_practices` が「適用前に必ずユーザーの同意を取れ」と
  明示しているため、導入可否は人間の判断待ち

### ツールチェーン

- `aws-cdk-lib` と `aws-cdk`（CLI）は **完全固定**（`^` を付けない）。両者のバージョンを
  ずらさないため。`test/toolchain.test.ts` が固定文字列であることを機械的に検査している
- CDK CLI は nix ではなく npm の devDependency。必ず `npx -w infra cdk` で呼ぶ（DEVELOPERS.md）
- TypeScript のトランスパイラは入れていない。node 24 の型ストリップで `node bin/blog.ts` が
  そのまま動くため、`cdk.json` の `app` は `node bin/blog.ts`。ts-node も tsx も要らない
- その代償として **erasable syntax のみ**に制限される（enum / namespace / パラメータプロパティ /
  decorators が使えない）。`tsconfig.json` の `"erasableSyntaxOnly": true` で型検査時に強制している。
  これが無いと enum を書いた瞬間に `cdk synth` だけが実行時に落ちる
- `"type": "module"` なので相対 import は拡張子必須（`./site-stack.ts` のように `.ts` まで書く）
