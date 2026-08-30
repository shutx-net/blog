import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

/**
 * ステートフル資源の論理 ID は固定する。変わると置換になるため。
 * **メディアの中身は Git から再生成できないので、配信用バケットより重い意味を持つ。**
 * MediaBucket という構築子 ID を今後絶対に動かさないことを、この集合一致で機械的に縛る。
 * （CDK の makeUniqueId は直前の要素で終わる要素を除去するので MediaBucket + Bucket → MediaBucket）
 */
const SITE_BUCKET_LOGICAL_ID = 'SiteBucket397A1860';
const MEDIA_BUCKET_LOGICAL_ID = 'MediaBucketE52FC6E4';

interface CfnResource {
  Type?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, unknown>;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const buckets = (): Record<string, CfnResource> =>
  template.findResources('AWS::S3::Bucket') as Record<string, CfnResource>;

/**
 * allResourcesProperties() は対象リソースが 0 個のとき素通しする。
 * バケットが 2 個であることを先に主張して非空ガードにする。
 */
const expectBothBuckets = (): void => {
  expect(Object.keys(buckets())).toHaveLength(2);
};

describe('S3 バケットの構成（配信用とメディア用の 2 個）', () => {
  it('AWS::S3::Bucket がちょうど 2 個（配信用とメディア用）', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  it('バケットの論理 ID の集合が固定されている（変わると置換が起きる）', () => {
    expect(Object.keys(buckets()).sort()).toEqual(
      [SITE_BUCKET_LOGICAL_ID, MEDIA_BUCKET_LOGICAL_ID].sort(),
    );
  });

  it('どのバケットもブロックパブリックアクセス 4 つとも true', () => {
    expectBothBuckets();
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('どのバケットも SSE-S3（AES256）で暗号化されている', () => {
    expectBothBuckets();
    template.allResourcesProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('どのバケットにも WebsiteConfiguration も AccessControl も無い', () => {
    expectBothBuckets();
    template.allResourcesProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: Match.absent(),
      AccessControl: Match.absent(),
    });
  });

  it('どのバケットも DeletionPolicy と UpdateReplacePolicy が Retain', () => {
    // hasResource は「1 件でも一致すれば通る」ので使わない。
    // findResources の戻り値を全件ループして、片方だけ Retain な状態を落とす。
    const found = buckets();
    expect(Object.keys(found)).toHaveLength(2);
    for (const [logicalId, resource] of Object.entries(found)) {
      expect(resource.DeletionPolicy, `${logicalId} の DeletionPolicy`).toBe('Retain');
      expect(resource.UpdateReplacePolicy, `${logicalId} の UpdateReplacePolicy`).toBe('Retain');
    }
  });
});

describe('メディア用バケット固有の主張（論理 ID で名指しする）', () => {
  const mediaBucket = (): CfnResource => {
    const found = buckets()[MEDIA_BUCKET_LOGICAL_ID];
    expect(found, `${MEDIA_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
    return found as CfnResource;
  };

  it('バージョニングが有効（Git から再生成できない唯一の資産だから）', () => {
    // Phase 1 が配信用バケットで versioning を見送った理由（sync --delete のたびに
    // 削除マーカーが溜まる）はメディアには当てはまらない。メディアは管理画面からの
    // presigned PUT で上がってきて sync --delete の対象にならない。
    expect(mediaBucket().Properties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });

  it('非現行バージョンを 90 日で失効させる（旧版の無限増加を防ぐ）', () => {
    expect(mediaBucket().Properties?.['LifecycleConfiguration']).toEqual({
      Rules: [
        {
          Id: 'expire-noncurrent-versions',
          NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          Status: 'Enabled',
        },
      ],
    });
  });

  it('物理名をハードコードしていない（BucketName が無い）', () => {
    expect(mediaBucket().Properties?.['BucketName']).toBeUndefined();
  });
});

describe('配信用バケット固有の主張（メディアとの非対称が意図的であること）', () => {
  it('配信用バケットには VersioningConfiguration が無い', () => {
    // sync --delete のたびに削除マーカーと旧版が溜まるだけで、中身は Git から
    // 完全に再生成できる。この非対称は意図的である。
    const found = buckets()[SITE_BUCKET_LOGICAL_ID];
    expect(found, `${SITE_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
    expect(found?.Properties?.['VersioningConfiguration']).toBeUndefined();
  });
});

describe('バケットポリシー（enforceSSL は両方のバケットに生える）', () => {
  it('AWS::S3::BucketPolicy が 2 本ある', () => {
    template.resourceCountIs('AWS::S3::BucketPolicy', 2);
  });

  it('どちらのバケットポリシーにも SecureTransport=false の Deny がある', () => {
    expect(Object.keys(template.findResources('AWS::S3::BucketPolicy'))).toHaveLength(2);
    template.allResourcesProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });
});
