import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** 非現行バージョンを保持する日数。旧版が無限に溜まるのを防ぐ。 */
const NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/** preflight の結果をブラウザにキャッシュさせる秒数。毎回 OPTIONS を飛ばさない。 */
const CORS_MAX_AGE_SECONDS = 3600;

export interface MediaBucketProps {
  /**
   * CORS で許可するオリジン。**移行中は 2 本**（`*.cloudfront.net` とカスタムドメイン）。
   *
   * **`distribution.distributionDomainName` を渡してはいけない。**
   * `CorsConfiguration` は `AWS::S3::Bucket` **本体**のプロパティなので、
   * Distribution の GetAtt を入れると
   *   Media.CorsConfiguration -> GetAtt[Dist] と Dist.Origins -> GetAtt[Media]
   * の循環参照になる。**`cdk synth` はこれを検出せず成功し**、cfn-lint の E3004 だけが
   * 捕まえる。呼び出し側は site-stack.ts の `SITE_ORIGINS` 定数を渡すこと
   * （Cognito の `CallbackURLs` と**同じ配列**を参照させる。別々に書くと
   * 「ログインはできるが画像が上がらない」という壊れ方をする）。
   */
  readonly siteOrigins: readonly string[];
}

/**
 * 記事に貼る画像などのメディア用バケット。
 *
 * 配信用バケットと分けるのは `aws s3 sync dist/ s3://... --delete` がメディアを巻き込んで
 * 消すため（AGENTS.md「画像を Git に入れない」）。
 *
 * Stack ではなく Construct なのは、別 Stack にすると cdk synth が DependencyCycle で落ちるから
 * （依存が双方向になる機構と実際のエラーは infra/docs/cdk-structure.md の
 * 「メディアバケットを別 Stack にできない」）。
 *
 * **構築子 ID `MediaBucket` を動かさないこと。** 論理 ID が変わるとバケットが作り直される。
 * メディアは「画像を Git に入れない」方針により、このシステムで唯一 Git から再生成できない
 * 資産である。`test/media-bucket.test.ts` が機械的に固定している。
 */
export class MediaBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MediaBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // 配信用バケットと違ってバージョニングを有効にする。配信用で見送った理由
      // （sync --delete のたびに削除マーカーと旧版が溜まる）はメディアには当てはまらない
      // — presigned PUT で上がってきて sync --delete の対象にならず、Git から再生成もできない。
      // この非対称は意図的で、test/media-bucket.test.ts が両方向を固定している。
      versioned: true,
      lifecycleRules: [
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(NONCURRENT_VERSION_EXPIRATION_DAYS),
        },
      ],
      // CORS はメディアバケットにだけ入れる。ブラウザから presigned PUT で画像を上げるために
      // 要る。読み取り用の GET は入れない — 画像は CloudFront 経由で読むので関与しない。
      // AllowedOrigins は許可リスト（移行中は 2 本）をそのまま並べる。**`*` にすると、
      // 任意のサイトの JavaScript が（presigned URL さえ手に入れば）このバケットに書ける。**
      cors: [
        {
          allowedOrigins: [...props.siteOrigins],
          allowedMethods: [s3.HttpMethods.PUT],
          // presigned PUT は content-type と content-length を署名済みヘッダとして送る
          // （api/src/media/presign.ts の requiredHeaders）。ブラウザに送らせるには
          // preflight で許可されている必要がある。
          allowedHeaders: ['content-type', 'content-length'],
          maxAge: CORS_MAX_AGE_SECONDS,
        },
      ],
      // bucketName は指定しない（物理名をハードコードしない）。実名は CfnOutput で出す。
    });
  }
}
