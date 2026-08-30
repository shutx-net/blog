import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { MediaBucket } from './media-bucket.ts';

// cdk synth がどこから実行されるか分からないので、cwd 基準の相対パスにしない。
// "type": "module" なので __dirname は存在しない。
const REWRITE_URI_PATH = fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url));

/**
 * メディアバケットに振り分けるパス。
 *
 * '/404.html' はこれに一致しないので、エラーページはデフォルトビヘイビア
 * （配信用バケット）から正しく返る。
 */
export const MEDIA_PATH_PATTERN = '/media/*';

/**
 * 静的サイト配信スタック。
 *
 * env は意図的に指定しない（env-agnostic）。本フェーズは AWS 認証情報を
 * 一切必要とせず cdk synth が通ることを要件にしているため。
 */
export class SiteStack extends Stack {
  /** `aws s3 sync` の宛先。CicdStack がデプロイロールの権限をここに絞る。 */
  readonly siteBucket: s3.Bucket;

  /** 記事の画像。CI からは一切触らせない（設計判断5）。 */
  readonly mediaBucket: s3.Bucket;

  /** CicdStack がキャッシュ無効化の権限をここに絞る。 */
  readonly distribution: cloudfront.Distribution;

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
    this.siteBucket = siteBucket;

    // メディアは配信用と別バケットにする。同居させると sync --delete が巻き込んで消す。
    // 別 Stack ではなく Construct なのは、別 Stack だと synth が DependencyCycle で
    // 落ちるため（media-bucket.ts のコメントと README を参照）。
    const media = new MediaBucket(this, 'MediaBucket');
    this.mediaBucket = media.bucket;

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
      // メディアは 2 本目の OAC オリジンから返す。
      //
      // functionAssociations は付けない。URI 書き換え Function は拡張子の無いパスに
      // /index.html を足すので、メディアのキーに適用してはいけない。
      //
      // originAccessLevels も指定しない。既定は [READ] でバケットポリシーには
      // s3:GetObject だけが入る。**LIST を足してはいけない** — CDK が
      // '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk' の警告を出すうえ、
      // メディアの一覧が CloudFront 経由で晒される。書き込みは管理画面が presigned PUT で
      // S3 に直接行うので、CloudFront 側には読み取りだけあればよい。
      //
      // cachePolicy も既定（CACHING_OPTIMIZED）のままでよい。メディアは不変な静的ファイル。
      additionalBehaviors: {
        [MEDIA_PATH_PATTERN]: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      // 403 も入れるのが本質。OAC + S3 REST オリジンではバケットポリシーに
      // s3:ListBucket が無く、S3 が「存在しない」と「権限が無い」を区別しないため、
      // 存在しないキーは 404 ではなく 403 (AccessDenied) で返る。404 だけマップしても
      // 閲覧者には 403 が見えたままになる。
      //
      // ttl は既定と同じ 10 秒だが、明示するとテンプレートに ErrorCachingMinTTL が
      // 描画されてテストで固定できる。デプロイ直後に一時的に 404 になったオブジェクトを
      // 長時間キャッシュされると困るので、短い値であること自体に意味がある。
      //
      // CustomErrorResponses は DistributionConfig 直下にあり、ビヘイビア単位ではなく
      // ディストリビューション全体に効く。存在しない /media/* の画像を要求すると
      // HTML の 404 ページが画像として返るが、壊れた画像に見えるだけで害は無い。
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.seconds(10),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.seconds(10),
        },
      ],
    });

    this.distribution = distribution;

    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'aws s3 sync の宛先バケット',
    });

    new CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: '管理画面が presigned PUT で画像を上げる先のバケット',
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
