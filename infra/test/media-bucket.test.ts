import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SITE_ORIGIN, SiteStack } from '../lib/site-stack.ts';

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

  /**
   * **修復 6（finding 3）。**
   *
   * このファイルにはメディアバケットの Properties に対する **キー集合の等価
   * アサーションが無かった**。実測で `CorsConfiguration` を足しても 1 件も
   * 赤くならなかった — つまり本フェーズの変更を検出する能力がゼロだった。
   *
   * posting-api.test.ts が Secret に対してやっているのと同じ形（キー集合の等価）で
   * 締める。**プロパティの追加も削除もここで赤くなる。**
   */
  it('**Properties のキー集合が固定されている**（プロパティの増減を検出する）', () => {
    expect(Object.keys(mediaBucket().Properties ?? {}).sort()).toEqual(
      [
        'BucketEncryption',
        'CorsConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'VersioningConfiguration',
      ].sort(),
    );
  });

  it('**配信用バケットの Properties キー集合も固定する**（CORS が紛れ込んだら赤くなる）', () => {
    const site = buckets()[SITE_BUCKET_LOGICAL_ID];
    expect(site, `${SITE_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
    expect(Object.keys(site?.Properties ?? {}).sort()).toEqual(
      ['BucketEncryption', 'PublicAccessBlockConfiguration'].sort(),
    );
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

/**
 * **CORS はメディアバケットにだけ入れる。**
 *
 * ブラウザから presigned PUT で画像を上げるために要る。読み取りは CloudFront 経由なので
 * バケット側の CORS は要らない（だから GET も入れない）。
 */
describe('メディアバケットの CORS（ブラウザからの presigned PUT）', () => {
  const mediaCors = (): Record<string, unknown>[] => {
    const found = buckets()[MEDIA_BUCKET_LOGICAL_ID];
    expect(found, `${MEDIA_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
    const cors = found?.Properties?.['CorsConfiguration'] as
      | { CorsRules?: Record<string, unknown>[] }
      | undefined;
    expect(cors, 'メディアバケットに CorsConfiguration が必要').toBeDefined();
    const rules = cors?.CorsRules ?? [];
    // 件数アサーションが非空ガードを兼ねる。
    expect(rules, 'CorsRules はちょうど 1 本').toHaveLength(1);
    return rules;
  };

  it('CorsRules がちょうど 1 本ある', () => {
    expect(mediaCors()).toHaveLength(1);
  });

  it('**AllowedOrigins がちょうど 1 本で、SITE_ORIGIN 定数と完全一致する**', () => {
    // CORS と Cognito の CallbackURLs が **同じ 1 定数**を指していること。
    // 2 か所に別々の文字列を書くと「ログインはできるが画像が上がらない」という
    // デバッグしにくい壊れ方をする。
    expect(mediaCors()[0]?.['AllowedOrigins']).toEqual([SITE_ORIGIN]);
  });

  it('**AllowedOrigins に "*" が含まれない**', () => {
    // 一番やりがちな緩め方を名指しで禁止する。
    const origins = mediaCors()[0]?.['AllowedOrigins'] as string[];
    expect(origins).not.toContain('*');
    for (const origin of origins) expect(origin).not.toContain('*');
  });

  it('AllowedOrigins の唯一の値が https:// で始まる', () => {
    const origins = mediaCors()[0]?.['AllowedOrigins'] as string[];
    expect(origins).toHaveLength(1);
    expect(origins[0]?.startsWith('https://')).toBe(true);
    expect(origins[0]).not.toContain('http://');
  });

  it('**AllowedMethods が ["PUT"] ちょうど**（POST / GET / DELETE を含まない）', () => {
    // presigned PUT しか使わない。GET は CloudFront 経由で読むのでバケットに CORS は要らない。
    expect(mediaCors()[0]?.['AllowedMethods']).toEqual(['PUT']);
    for (const method of ['GET', 'POST', 'DELETE', 'HEAD']) {
      expect(mediaCors()[0]?.['AllowedMethods'] as string[]).not.toContain(method);
    }
  });

  it('MaxAge が設定されている（preflight を毎回飛ばさない）', () => {
    expect(mediaCors()[0]?.['MaxAge'] as number).toBeGreaterThan(0);
  });

  it('**CORS を持つバケットはちょうど 1 個で、それはメディア用である**', () => {
    // hasResourceProperties の「1 件でも一致すれば通る」を避けるため、
    // 両バケットを走査して集合として主張する。
    const found = buckets();
    expect(Object.keys(found)).toHaveLength(2);
    const withCors = Object.entries(found)
      .filter(([, r]) => r.Properties?.['CorsConfiguration'] !== undefined)
      .map(([id]) => id);
    expect(withCors).toEqual([MEDIA_BUCKET_LOGICAL_ID]);
  });

  it('配信用バケットには CorsConfiguration が無い', () => {
    const site = buckets()[SITE_BUCKET_LOGICAL_ID];
    expect(site, `${SITE_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
    expect(site?.Properties?.['CorsConfiguration']).toBeUndefined();
  });
});

/**
 * **本 step で一番価値のあるテスト。**
 *
 * `CorsConfiguration` は `AWS::S3::Bucket` **本体**のプロパティなので、
 * `AllowedOrigins` に `distribution.distributionDomainName` を入れると
 *
 *   Media.Properties.CorsConfiguration...AllowedOrigins = Fn::GetAtt [Dist, DomainName]
 *   Dist.Properties...Origins[0].DomainName            = Fn::GetAtt [Media, RegionalDomainName]
 *
 * という循環参照になる。
 *
 * **実測（本ブランチで実際に循環を作って確認した）:**
 *
 * - `npx cdk synth BlogSiteStack` は **exit 0 で成功する。** CLI は同一スタック内の
 *   リソース間循環を検出しない。これだけを回していると `cdk deploy` で初めて分かる。
 * - `Template.fromStack()` は検出して **throw する**:
 *   `Template is undeployable, these resources have a dependency cycle:
 *    SiteBucketPolicy3AC1D0F8 -> SiteDistribution3FF9535D -> MediaBucketE52FC6E4
 *    -> SiteDistribution3FF9535D`
 *   ただし **テストファイルの読み込み時点で落ちる**ので、
 *   「どのアサーションが何を言っているか」は分からない（全 it が消える）。
 * - cfn-lint は **E3004** で 2 件検出する。
 *
 * **だから下の名指しのテストに意味がある。** 落ち方が読めることと、
 * cfn-lint を回していない状況でも原因が 1 行で分かることの 2 つが価値である。
 *
 * バケットポリシー（別リソース）が Distribution を参照するのは問題ない。
 * ここで見るのは **S3::Bucket の Properties の中だけ**である。
 */
describe('循環参照の回帰テスト', () => {
  /** 値の中に現れる Fn::GetAtt の参照先論理 ID を全部集める。 */
  const collectGetAttTargets = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const item of value) collectGetAttTargets(item, out);
      return out;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'Fn::GetAtt' && Array.isArray(child) && typeof child[0] === 'string') {
          out.push(child[0]);
        }
        if (key === 'Ref' && typeof child === 'string') out.push(child);
        collectGetAttTargets(child, out);
      }
    }
    return out;
  };

  const resources = (): Record<string, CfnResource> =>
    template.toJSON()['Resources'] as Record<string, CfnResource>;

  it('Distribution がちょうど 1 個ある（以降のテストの非空ガード）', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('**S3::Bucket の Properties から Distribution を参照している箇所が 1 つも無い**', () => {
    const all = resources();
    const distributionIds = Object.entries(all)
      .filter(([, r]) => r.Type === 'AWS::CloudFront::Distribution')
      .map(([id]) => id);
    expect(distributionIds).toHaveLength(1);

    const bucketIds = Object.entries(all)
      .filter(([, r]) => r.Type === 'AWS::S3::Bucket')
      .map(([id]) => id);
    expect(bucketIds).toHaveLength(2);

    for (const id of bucketIds) {
      const referenced = collectGetAttTargets(all[id]?.Properties ?? {});
      for (const target of distributionIds) {
        expect(
          referenced,
          `${id} の Properties が Distribution ${target} を参照している（循環参照。cfn-lint E3004）`,
        ).not.toContain(target);
      }
    }
  });

  it('Distribution が両方のバケットを参照している（向きが片方向であることの確認）', () => {
    const all = resources();
    const distribution = Object.entries(all).find(
      ([, r]) => r.Type === 'AWS::CloudFront::Distribution',
    );
    expect(distribution).toBeDefined();
    const referenced = collectGetAttTargets(distribution?.[1]?.Properties ?? {});
    expect(referenced).toContain(SITE_BUCKET_LOGICAL_ID);
    expect(referenced).toContain(MEDIA_BUCKET_LOGICAL_ID);
  });
});
