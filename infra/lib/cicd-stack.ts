import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** GitHub Actions の OIDC 発行者。 */
export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

/** STS を audience に固定する。増やすと信頼範囲が広がる。 */
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/** 信頼するリポジトリのオーナー。 */
export const GITHUB_OWNER = 'shutx-net';

/**
 * オーナーの数値 ID（`gh api users/shutx-net --jq .id`）。
 *
 * 文字列で持つ。これは識別子であって数値ではないし、number にすると template literal へ
 * 埋めるときに桁区切りや指数表記の事故が理屈上あり得る。
 */
export const GITHUB_OWNER_ID = '169037737';

/** 信頼するリポジトリ名。 */
export const GITHUB_REPOSITORY_NAME = 'blog';

/** リポジトリの数値 ID（`gh api repos/shutx-net/blog --jq .id`）。文字列で持つ理由は上と同じ。 */
export const GITHUB_REPOSITORY_ID = '1351152011';

/** 信頼するリポジトリ。public なのでロール ARN は漏れる前提で考える。 */
export const GITHUB_REPOSITORY = `${GITHUB_OWNER}/${GITHUB_REPOSITORY_NAME}`;

/**
 * 信頼ポリシーの sub。**StringEquals で完全一致固定する。緩めて回避しないこと** —
 * StringLike に落とした瞬間にこのスタックの主要な成果が失われる。
 *
 * IAM 自身のガードは弱い。AWS のドキュメントは「条件キー
 * `token.actions.githubusercontent.com:sub` が存在し、その値が単独のワイルドカード
 * (`*` / `?`) や null でないこと」しか検査しないと明記している。リポジトリ名もブランチ名も
 * ワイルドカードにした sub（どの GitHub リポジトリからでも assume できる）は IAM の検査を
 * 通過する。テストは IAM より厳しくなければならない。
 *
 * 形式は immutable subject claim。GitHub は 2026-07-15 に既定の sub 形式を
 * `repo:OWNER/REPO:...` から `repo:OWNER@OWNER-ID/REPO@REPO-ID:...` に変更し、同日以降に
 * 作成されたリポジトリは既定で新形式を発行する（本リポジトリの created_at は 2026-08-30、
 * `gh api repos/shutx-net/blog/actions/oidc/customization/sub` が
 * `sub_claim_prefix: "repo:shutx-net@169037737/blog@1351152011"` を返すことを実測）。
 * **旧形式のまま deploy すると初回の assume が
 * `Not authorized to perform sts:AssumeRoleWithWebIdentity` で必ず落ちる。**
 *
 * 名前ではなく ID で固定するので、リポジトリ名もオーナー名も変えて壊れない。逆に
 * リポジトリを作り直すと repo_id が変わって壊れる（上の 2 つの ID 定数を実測値で更新して
 * deploy し直す）。
 *
 * **この文字列は GitHub 側の挙動と結合した契約で、ワークフロー YAML に制約が及ぶ**
 * （infra/docs/cicd-oidc.md の「`sub` の完全一致固定がワークフロー YAML に課す制約」にも
 * 記載。test/workflow-deploy-oidc.test.ts がこの定数から期待値を導出して機械的に
 * 固定している）:
 *
 * - トリガは main への push（または main を ref とする workflow_dispatch）。
 *   pull_request で走らせると sub は `...:pull_request` になり assume が失敗する
 * - ジョブに `environment:` を付けない。付けると sub は `...:environment:<name>` になる
 * - ジョブに `permissions: { id-token: write, contents: read }` が要る
 * - ロール ARN は YAML に直書きせず GitHub Actions の変数から読む
 *   （public リポジトリに AWS アカウント ID を晒す必要は無い）
 */
export const DEPLOY_SUBJECT = `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPOSITORY_NAME}@${GITHUB_REPOSITORY_ID}:ref:refs/heads/main`;

export interface CicdStackProps extends StackProps {
  /** `aws s3 sync` の宛先。デプロイロールの権限をここに絞る。 */
  readonly siteBucket: s3.IBucket;

  /** キャッシュ無効化の対象。 */
  readonly distribution: cloudfront.IDistribution;
}

/**
 * GitHub Actions が OIDC で assume するデプロイロールのスタック。
 *
 * SiteStack と分けてよいのは参照が一方向だから。CicdStack は SiteStack のバケット ARN と
 * ディストリビューションを読むだけで、SiteStack 側に何も書き込まない（MediaBucket を
 * 別 Stack にできなかったのとは対照的。infra/docs/cdk-structure.md の
 * 「メディアバケットを別 Stack にできない」を参照）。
 *
 * env は意図的に指定しない（env-agnostic）。必要な ARN はすべて疑似パラメータで組める。
 */
export class CicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    // レガシーの iam.OpenIdConnectProvider ではなく OidcProviderNative を使う。レガシー版は
    // Custom::AWSCDKOpenIdConnectProvider を作り、その裏の Lambda 実行ロールに
    // iam:CreateOpenIDConnectProvider 等を Resource: "*" で付与する。native 版は
    // AWS::IAM::OIDCProvider 1 リソースだけを吐く。
    //
    // **thumbprints は渡さない。** AWS は信頼された root CA で JWKS エンドポイントの TLS 証明書を
    // 検証するので、公的な CA に署名された IdP ではサムプリントは使われない。古い記事の固定値を
    // コピーすると、GitHub が証明書を切り替えた日に assume が全部落ちる時限爆弾になる。
    //
    // RETAIN にするのは、OIDC プロバイダが URL ごとにアカウントへ 1 つしか作れない共有資源で、
    // 消すと同じプロバイダを信頼する他のロールが全部壊れるから（既定は DESTROY）。
    const provider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: GITHUB_OIDC_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // roleName は指定しない（物理名をハードコードしない方針。cdk deploy に
    // CAPABILITY_NAMED_IAM が要るようになるのも避けられる）。ARN は CfnOutput で出し、
    // 人間が一度だけ GitHub Actions の変数に入れる。
    const deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
          'token.actions.githubusercontent.com:sub': DEPLOY_SUBJECT,
        },
      }),
      description: 'GitHub Actions assumes this via OIDC to publish site/dist to S3',
    });

    // S3 だけ grant メソッドを使わない。cdk_best_practices は grant を勧めるが、
    // aws-cdk-lib/aws-s3/lib/perms.js の BUCKET_PUT_ACTIONS + BUCKET_DELETE_ACTIONS を読むと
    // bucket.grantWrite() が展開する 7 個には s3:Abort* と s3:DeleteObject* というワイルドカードが
    // 含まれる（後者はバージョン付きバケットでは s3:DeleteObjectVersion まで）。public から assume できる
    // ロールにワイルドカードのアクションを入れない方針を優先し、ここは明示列挙にする。
    //
    // s3:GetObject は入れない。ローカル -> S3 方向の aws s3 sync は ListObjectsV2
    // （s3:ListBucket）でリモートを列挙し、サイズと更新時刻で比較して PutObject するだけ。
    // AccessDenied が出たら s3:GetObject -> s3:ListBucketMultipartUploads ->
    // s3:ListMultipartUploadParts の順に 1 つずつ足し、そのつど
    // infra/docs/cicd-oidc.md の「デプロイロールに S3 の grant メソッドを使わない」と
    // test/cicd-deploy-permissions.test.ts の EXPECTED_ACTIONS を更新する。
    // **まとめて s3:* にしないこと。**
    //
    // s3:PutObjectAcl も入れない（ブロックパブリックアクセスが 4 つとも有効で ACL は使わない）。
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListSiteBucket',
        actions: ['s3:ListBucket'],
        // ListBucket は **バケット ARN** に付ける。オブジェクト ARN に付けると永久に一致しない。
        resources: [props.siteBucket.bucketArn],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncSiteObjects',
        // s3:AbortMultipartUpload は、既定で 8MB 超のファイルがマルチパートに
        // なるため。失敗時に Abort できないと課金対象の未完了パートが残る。
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: [props.siteBucket.arnForObjects('*')],
      }),
    );

    // **メディアバケットには一切触れない。** バケットを分けても CI にメディアへの権限を
    // 渡したら意味が無い。test/cicd-deploy-permissions.test.ts がテンプレート全文を走査している。

    // CloudFront は grant を使う。実測で
    // arn:<partition>:cloudfront::<account>:distribution/<id> にスコープされた
    // 1 アクションだけを吐き、手書きより正確で短い（Resource: '*' にならない）。
    props.distribution.grantCreateInvalidation(deployRole);
    props.distribution.grant(deployRole, 'cloudfront:GetInvalidation');

    // GitHub Actions の変数は secret ではなく variable でよい（ARN は秘密ではない）。
    new CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'GitHub Actions の変数に入れるデプロイロールの ARN',
    });
  }
}
