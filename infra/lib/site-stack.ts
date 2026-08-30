import { fileURLToPath } from 'node:url';
import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

// cdk synth がどこから実行されるか分からないので、cwd 基準の相対パスにしない。
// "type": "module" なので __dirname は存在しない。
const REWRITE_URI_PATH = fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url));

/**
 * 静的サイト配信スタック。
 *
 * env は意図的に指定しない（env-agnostic）。本フェーズは AWS 認証情報を
 * 一切必要とせず cdk synth が通ることを要件にしているため。
 */
export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 配信対象は CloudFront の OAC 経由でのみ読ませる。バケット自体は完全に非公開。
    // bucketName は指定しない（物理名をハードコードしない）。実名は CfnOutput で出す。
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // runtime を省略すると既定は JS_1_0。1.0 は const / let / endsWith を保証しないので
    // 必ず 2.0 を明示する。ここが消えるとテンプレートは通るのにデプロイ後に壊れる。
    const rewriteUriFunction = new cloudfront.Function(this, 'RewriteUriFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: REWRITE_URI_PATH }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'viewer-request: /about -> /about/index.html',
    });

    // withOriginAccessControl は OAC リソースの作成とバケットポリシーの更新を
    // まとめて行う。手で addToResourcePolicy すると文が重複するので書かない。
    // 既定の originAccessLevels は [READ] なので読み取り専用。
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      // defaultRootObject はルート '/' にしか効かない。/about は Function 側が担当する。
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: rewriteUriFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'aws s3 sync の宛先バケット',
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront の配信ドメイン',
    });

    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'キャッシュ無効化に使うディストリビューション ID',
    });
  }
}
