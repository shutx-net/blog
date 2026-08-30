import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** 非現行バージョンを保持する日数。旧版が無限に溜まるのを防ぐ。 */
const NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/** preflight の結果をブラウザにキャッシュさせる秒数。毎回 OPTIONS を飛ばさない。 */
const CORS_MAX_AGE_SECONDS = 3600;

export interface MediaBucketProps {
  /**
   * CORS で許可する唯一のオリジン。
   *
   * **`distribution.distributionDomainName` を渡してはいけない。**
   * `CorsConfiguration` は `AWS::S3::Bucket` **本体**のプロパティなので、
   * Distribution の GetAtt を入れると
   *   Media.CorsConfiguration -> GetAtt[Dist] と Dist.Origins -> GetAtt[Media]
   * の循環参照になる。**`cdk synth` はこれを検出せず成功し**、cfn-lint の E3004 だけが
   * 捕まえる。呼び出し側は site-stack.ts の `SITE_ORIGIN` 定数を渡すこと。
   */
  readonly siteOrigin: string;
}

/**
 * 記事に貼る画像などのメディア用バケット。
 *
 * **配信用バケットと分けるのは `aws s3 sync dist/ s3://... --delete` が
 * メディアを巻き込んで消すため**（AGENTS.md「画像を Git に入れない」）。
 *
 * **Stack ではなく Construct にしている。** 別 Stack にすると cdk synth が
 * DependencyCycle で落ちるため（README「MediaBucket を別 Stack にできない理由」）。
 * `withOriginAccessControl()` はバケットポリシーに Distribution の Ref を埋め込む一方、
 * Distribution のオリジンはバケットの RegionalDomainName を参照する。バケットと
 * Distribution が別スタックにあると、この 2 本が逆向きのクロススタック参照になって循環する。
 *
 * 構築子 ID `MediaBucket` は **絶対に動かさないこと**。論理 ID が変わるとバケットが
 * 作り直される。メディアは設計判断4（画像を Git に入れない）により、このシステムで
 * 唯一 Git から再生成できない資産である。`test/media-bucket.test.ts` が機械的に固定している。
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
      // 配信用バケットと違ってバージョニングを有効にする。Phase 1 が配信用で
      // 見送った理由（sync --delete のたびに削除マーカーと旧版が溜まる）は
      // メディアには当てはまらない。メディアは管理画面からの presigned PUT で
      // 上がってきて sync --delete の対象にならず、しかも Git から再生成できない。
      // この非対称は意図的で、test/media-bucket.test.ts が両方向を固定している。
      versioned: true,
      lifecycleRules: [
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(NONCURRENT_VERSION_EXPIRATION_DAYS),
        },
      ],
      // **CORS はメディアバケットにだけ入れる。**
      //
      // ブラウザから presigned PUT で画像を上げるために要る。**読み取り用の GET は
      // 入れない** — 画像は CloudFront 経由で読むので、バケット側の CORS は関与しない。
      //
      // AllowedOrigins は CloudFront のドメイン 1 本だけ。`*` にすると、任意のサイトの
      // JavaScript が（presigned URL さえ手に入れば）このバケットに書けるようになる。
      cors: [
        {
          allowedOrigins: [props.siteOrigin],
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
