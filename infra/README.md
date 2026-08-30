# infra

- `BlogSiteStack` — 非公開 S3 + CloudFront (OAC) による静的サイト配信。配信用とメディア用の 2 バケット。
- `BlogCicdStack` — GitHub Actions が OIDC で assume する最小権限のデプロイロール。

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
| `AWS::S3::Bucket` | `MediaBucketE52FC6E4` | メディア用。上と同じ設定 + **バージョニング有効**・非現行バージョン 90 日で失効 |
| `AWS::S3::BucketPolicy` | `MediaBucketPolicyB24E187B` | 同上（`AWS:SourceArn` はこのディストリビューションに限定） |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin1S3OriginAccessControl7D960FE6` | 配信用オリジン。`s3` / `always` / `sigv4` |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA` | メディア用オリジン。同上（**OAC はオリジンごとに別**） |
| `AWS::CloudFront::Distribution` | `SiteDistribution3FF9535D` | `redirect-to-https` / `DefaultRootObject: index.html` / `/media/*` の追加ビヘイビア / 403・404 を `/404.html` にマップ |
| `AWS::CloudFront::Function` | `RewriteUriFunctionF5D8A5AC` | `cloudfront-js-2.0` / viewer-request（デフォルトビヘイビアのみ） |

配信用バケット・バケットポリシー・ディストリビューション・Function・Origin1 の OAC の論理 ID は
**Phase 1 から 1 文字も変わっていない**（＝既存リソースの置換は起きない）。

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

1. `.github/workflows/oidc-probe.yml` を作業ブランチのまま `workflow_dispatch` で 1 回回し、
   実際の `sub` を目で見る。**IAM を deploy する前に。**
   上の表に日付つきで記録し、`DEPLOY_SUBJECT` と食い違っていたら実測値のほうに合わせる
2. `npx -w infra cdk diff BlogCicdStack` を取り、**アカウント ID をマスクして** PR 本文に貼る
   （`AGENTS.md`）。信頼ポリシーの更新はロールの置換を伴わない
   （`AssumeRolePolicyDocument` は更新可能なプロパティ）ので、**ロール ARN は変わらない**
3. `npx -w infra cdk deploy BlogCicdStack`
4. 上の 3 つの変数を `gh variable set` で入れる
5. probe ワークフローを削除して PR をマージする。`site/**` が変わっていなくても
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

`validate_cloudformation_template` — **両スタックとも 0 error / 0 warning / 0 info**。

### cfn-guard（bundled `aws-security` ルールセット）

| スタック | 結果 |
| --- | --- |
| `BlogCicdStack` | **0 件（COMPLIANT）** |
| `BlogSiteStack` | **6 件**。すべて S3 関連で、CloudFront・IAM への指摘は 0 件 |

**Phase 2 が新しく増やした指摘はゼロ。** 6 件は Phase 1 と同一で、ルール ID も同じ。
IAM ロール・IAM ポリシー・OIDC プロバイダ・CloudFront の追加ビヘイビア・`CustomErrorResponses` の
いずれに対しても指摘は出なかった。

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
- **メディアバケットの CORS は admin フェーズで。** 管理画面がブラウザから presigned PUT で
  直接 S3 に上げるには CORS が要るが、`admin/` も `api/` も無い現時点では許可すべき Origin が
  決まらず（カスタムドメインも未定）、正しい値を書けないうえテストで検証もできない。
  CORS の追加はバケットの置換を伴わない更新なので、後から安全に足せる
- **`env` を明示するのは ACM のフェーズで。** 下の「`env` を明示しない」を参照
- **`aws s3 sync` に必要な IAM アクションの最小集合は実デプロイ未検証。** 下の
  「デプロイロールに S3 の grant メソッドを使わない」を参照

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

**`cdk deploy` の前に実トークンで確認すること。** `.github/workflows/oidc-probe.yml` を
`workflow_dispatch` で 1 回だけ回すと、実際に発行される `sub` と `aud` だけを表示する。
プレフィックスはどの ref で走らせても同じなので、`main` にマージする前の作業ブランチで確認できる。
確認が済んだらこのワークフローは削除する。

| 実測日 | 実際に発行された `sub` | 判定 |
| --- | --- | --- |
| （未実施） | — | probe を回したらここに記録する |

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
