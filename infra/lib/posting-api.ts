import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// cdk synth がどこから実行されるか分からないので cwd 基準の相対パスにしない。
// "type": "module" なので __dirname は存在しない（site-stack.ts と同じ理由）。
//
// **ここは api ワークスペースのビルド成果物である。** infra/package.json の pretest が
// `npm run build -w ../api` を先に走らせる。ビルドせずに synth すると、テンプレートは
// 通るのに古いアセットが使われる（test/synth-artifact.test.ts が assets.json と突き合わせている）。
const API_BUNDLE_PATH = fileURLToPath(new URL('../../api/dist', import.meta.url));

/**
 * メディアのキー接頭辞。
 *
 * site-stack.ts の MEDIA_PATH_PATTERN（'/media/*'）と、api の MEDIA_KEY_PREFIX と、
 * この IAM リソース ARN の 3 つが揃っていないと presigned PUT は動かない。
 */
const MEDIA_KEY_PREFIX = 'media/';

/**
 * 予約同時実行数。
 *
 * **本フェーズ唯一の流量防御。** /api/* は CloudFront 経由で匿名でも到達でき、
 * AUTH_MODE=deny-all で 503 を返す場合でも Lambda 自体は起動する（＝課金される）。
 *
 * 実測でこのアカウントの ConcurrentExecutions クォータは 400（既定の 1000 ではない）、
 * UnreservedConcurrentExecutions も 400。2 を予約しても未予約分は 398 残り、
 * AWS が要求する下限 100 を割らない。個人ブログの実利用には十分で、暴走時の上限として働く。
 * WAF とレート制限は運用フェーズに送る。
 */
const RESERVED_CONCURRENCY = 2;

/** ログの保持期間。無期限にしない（溜め続ける理由が無い）。 */
const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

export interface PostingApiProps {
  /** presigned PUT の宛先。**この 1 本の参照が ApiStack を別スタックにできない理由**（README）。 */
  mediaBucket: s3.Bucket;
  githubOwner: string;
  githubRepo: string;
  /**
   * GitHub App の client ID。**秘密ではない**（秘密鍵が無ければ何もできない）。
   *
   * App はまだ存在しないので既定はプレースホルダ。AUTH_MODE=deny-all の間は
   * GitHub を呼ぶ経路に到達しないので、この値が使われることはない。
   */
  githubAppClientId: string;
}

/**
 * 投稿 API。
 *
 * **Stack ではなく Construct にしている。**
 * Distribution が Function URL を参照し（SiteStack -> Api）、Lambda がメディアバケットの
 * 名前と ARN を参照する（Api -> SiteStack）ため、別スタックにすると
 * クロススタック参照が循環して synth が落ちる。詳細は infra/README.md に実測エラー付きで書いた。
 * **「OAC だから循環する」ではない** — 循環させているのは presigned URL 側の要件である。
 */
export class PostingApi extends Construct {
  readonly handler: lambda.Function;
  readonly functionUrl: lambda.FunctionUrl;
  readonly secret: secretsmanager.Secret;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: PostingApiProps) {
    super(scope, id);

    // ---- 空のシークレット（設計判断8） ----
    const secret = new secretsmanager.Secret(this, 'GitHubAppPrivateKey', {
      description: 'GitHub App private key (PEM). Populated out of band; never written by CDK.',
      // **RETAIN。** GitHub App の秘密鍵は Web UI で生成した瞬間に 1 度しか表示されず
      // 再ダウンロードできない。スタックを消して鍵を失うと作り直す以外に復旧手段がない。
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // **この 1 行を消してはいけない。**
    //
    // CDK の Secret は値を渡さないと GenerateSecretString: {} を描画する
    // （aws-secretsmanager/lib/secret.js の
    //  `generateSecretString: props.generateSecretString ?? (secretString ? void 0 : {})`）。
    // その状態でデプロイすると **32 文字のランダムパスワードが AWSCURRENT に入り**、
    // 設計判断8 の「空のシークレットを作り、値は後から CLI で入れる」が満たされなくなる。
    // 運用者が put-secret-value する前に「鍵が入っている」ように見えるのが特に悪い。
    //
    // CloudFormation のドキュメント: "If you omit both GenerateSecretString and
    // SecretString, you create an empty secret." — 削除が正規の方法である。
    //
    // **実測: この override を外しても Phase 2 までの既存テストは 1 つも赤くならなかった。**
    // test/posting-api.test.ts の『Properties のキー集合が ["Description"] ちょうど』だけが
    // 検出できる。CDK の既定に戻すリファクタが最も起きやすい場所なので、
    // 触る前に必ずそのテストを読むこと。
    (secret.node.defaultChild as CfnSecret).addPropertyDeletionOverride('GenerateSecretString');
    this.secret = secret;

    // ---- ロググループ（Lambda に作らせない） ----
    //
    // 先に作っておくと実行ロールに logs:CreateLogGroup が要らなくなり、
    // CreateLogStream / PutLogEvents をこの ARN にスコープするだけで済む。
    //
    // 旧来の logRetention プロパティは使わない。あれは LogRetention のカスタムリソース
    // （＝追加の Lambda と広い IAM 権限）を引き込む。logGroup プロパティならそれが無い。
    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      retention: LOG_RETENTION,
      // ログはいつでも作り直せるので、スタック削除時に残す理由が無い。
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.logGroup = logGroup;

    // ---- 実行ロール（マネージドポリシーを 1 つも付けない） ----
    //
    // **CDK 既定に任せてはいけない。** 既定は AWSLambdaBasicExecutionRole を付け、
    // それは logs:CreateLogGroup / CreateLogStream / PutLogEvents を
    // **Resource: "*"** に対して許可する（IAM API で内容を確認済み）。
    //
    // しかも **マネージドポリシーは ARN 参照なのでポリシー文がテンプレートに現れない**。
    // synth-artifact.test.ts の『Resource が "*" の Allow が 1 つも無い』は緑のまま通る
    // （実測）。test/posting-api.test.ts の『ManagedPolicyArns を持つ Role が 0 個』が
    // 唯一の検出手段になっている。
    //
    // grant メソッドも使わない。secret.grantRead() は DescribeSecret を、
    // mediaBucket.grantPut() は s3:Abort* を含む 6 アクションを足す（実測）。
    // どちらも要らない。Phase 2 の cicd-stack.ts が S3 の grant を避けたのと同じ判断。
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Posting API Lambda execution role (no managed policies by design)',
    });

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        // Fn::GetAtt の Arn は末尾に :* が付くのでログストリームまで含む。
        resources: [logGroup.logGroupArn],
      }),
    );

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // 署名するだけなので PutObject 1 つでよい。Get も Delete も List も要らない。
        actions: ['s3:PutObject'],
        resources: [props.mediaBucket.arnForObjects(`${MEDIA_KEY_PREFIX}*`)],
      }),
    );

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // DescribeSecret は使わない（grantRead が付けてしまうもう 1 つ）。
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secret.secretArn],
      }),
    );

    // ---- Lambda ----
    const handler = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_24_X,
      // esbuild の出力は dist/index.mjs。**.js にすると node が CommonJS として読み、
      // 起動時に SyntaxError で落ちる**（api/package.json の build を参照）。
      handler: 'index.handler',
      code: lambda.Code.fromAsset(API_BUNDLE_PATH),
      role,
      logGroup,
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrentExecutions: RESERVED_CONCURRENCY,
      environment: {
        // **この 1 行が「認証なしの書き込みエンドポイントをデプロイしない」の担保。**
        // 緩めるときは Cognito の実装と同じ PR でなければならない
        // （test/posting-api.test.ts が値を固定している）。
        AUTH_MODE: 'deny-all',
        GITHUB_OWNER: props.githubOwner,
        GITHUB_REPO: props.githubRepo,
        GITHUB_APP_CLIENT_ID: props.githubAppClientId,
        // 値ではなく ARN を渡す。鍵そのものは実行時に Secrets Manager から読む。
        GITHUB_APP_SECRET_ID: secret.secretArn,
        MEDIA_BUCKET: props.mediaBucket.bucketName,
        // AWS_REGION は Lambda が自動で入れる予約変数なので、こちらでは設定しない。
      },
    });
    this.handler = handler;

    // authType は **必ず AWS_IAM**。NONE にすると Function URL が完全公開になり、
    // CloudFront を迂回して直接叩ける。
    //
    // **ただしこれはエンドユーザ認証ではない。** OAC の SigningBehavior が always なので、
    // CloudFront は到達した全リクエストに署名して渡す。匿名の POST でも Lambda は起動する。
    // 書き込みを止めているのは AUTH_MODE=deny-all のほうである。
    this.functionUrl = handler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // **物理名をハードコードしない方針なので、運用者はここから名前を取る。**
    // DEVELOPERS.md の put-secret-value 手順がこの出力を参照している。
    new CfnOutput(this, 'GitHubAppSecretName', {
      value: secret.secretName,
      description: 'aws secretsmanager put-secret-value --secret-id に渡す名前',
    });

    new CfnOutput(this, 'PostingApiFunctionName', {
      value: handler.functionName,
      description: '投稿 API の Lambda 関数名',
    });
  }
}
