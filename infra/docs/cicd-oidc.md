# OIDC とデプロイロール

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

**`use_immutable_subject: false` は誤導である。** 「明示的にオプトインしていない」の意味であって
「legacy を使う」の意味ではなく、同じ応答の `sub_claim_prefix` は immutable 形式そのものを返す。
カットオフ後に作られたリポジトリは、オプトインの有無に関わらず immutable になる。

legacy 形式（`repo:shutx-net/blog:ref:refs/heads/main`）のままだと、**初回デプロイが
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

実際に発行されたトークンも immutable 形式だった。**`use_immutable_subject` と
`sub_claim_prefix` は食い違って見えるので、ドキュメントだけで判断してはいけない。**

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
GetObject は使わない、というのが根拠。**初回デプロイ（2026-08-30）の実走で 6 アクションで
足りることが確定した**（`infra/docs/deploy.md` の「実デプロイで解決した宿題」）。
それでも AccessDenied が出たら、
エラーメッセージが名指しする API に対応するアクションを
`s3:GetObject` → `s3:ListBucketMultipartUploads` → `s3:ListMultipartUploadParts` →
`s3:PutObjectTagging` の順に **1 つずつ** 足すこと。**まとめて `s3:*` にしないこと。**
足したアクションと理由をこのファイル（`infra/docs/cicd-oidc.md`）に追記し、`test/cicd-deploy-permissions.test.ts` の
`EXPECTED_ACTIONS`（完全一致）も同時に更新する。完全一致なのでこっそり広げると必ず落ちて気づける。

`s3:PutObjectAcl` も入れていない（ブロックパブリックアクセスが 4 つとも有効で ACL は使わないため）。
