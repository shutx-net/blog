import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { API_PATH_PATTERN, MEDIA_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

interface CacheBehavior {
  PathPattern?: string;
  TargetOriginId?: string;
  ViewerProtocolPolicy?: string;
  FunctionAssociations?: unknown;
}

interface DistributionConfig {
  Origins?: Array<Record<string, unknown>>;
  CacheBehaviors?: CacheBehavior[];
  DefaultCacheBehavior?: { TargetOriginId?: string };
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

const cacheBehaviors = (): CacheBehavior[] => distributionConfig().CacheBehaviors ?? [];

/**
 * PathPattern で **名指しして** 取る。
 *
 * Phase 2 までは「追加ビヘイビアはちょうど 1 件」で取っていたが、Phase 3 で /api/* が
 * 増えて 6 件が赤くなった。件数で位置を特定する形は、ビヘイビアが増えるたびに壊れる。
 * **名指しにすると、以後ビヘイビアが何本増えてもこのファイルは正しく効き続ける。**
 * 総数は下の describe で別に固定しているので、緩めたことにはならない。
 */
const mediaBehavior = (): CacheBehavior => {
  const found = cacheBehaviors().filter((behavior) => behavior.PathPattern === MEDIA_PATH_PATTERN);
  expect(found, `${MEDIA_PATH_PATTERN} のビヘイビアがちょうど 1 件であること`).toHaveLength(1);
  return found[0] as CacheBehavior;
};

describe('/media/* の追加ビヘイビア', () => {
  it('PathPattern が定数と一致する', () => {
    expect(mediaBehavior().PathPattern).toBe(MEDIA_PATH_PATTERN);
  });

  it('PathPattern がリテラル "/media/*" である', () => {
    // 定数だけで比較するとパスを変えたときテストが一緒に動いてしまい固定にならない。
    // リテラルとの一致を別ケースで主張して、実際の URL 空間を固定する。
    expect(mediaBehavior().PathPattern).toBe('/media/*');
  });

  it('メディアビヘイビアがデフォルトと別のオリジンを向いている', () => {
    // 同じオリジンを向いていたらバケットを分けた意味が無い。
    const target = mediaBehavior().TargetOriginId;
    expect(target).toBeDefined();
    expect(target).not.toBe(distributionConfig().DefaultCacheBehavior?.TargetOriginId);
  });

  it('Origins がちょうど 3 件ある（配信用 S3 / メディア S3 / Function URL）', () => {
    expect(distributionConfig().Origins).toHaveLength(3);
  });

  it('CacheBehaviors がちょうど 2 件で、順序が /media/* -> /api/* である', () => {
    // **順序に意味がある。** CDK はキーの挿入順でオリジンに番号を振り、
    // OAC の論理 ID がその番号から作られる。/api/* を先に書くとメディア用 OAC が
    // 置換される（distribution-oac.test.ts が論理 ID 集合を固定している）。
    expect(cacheBehaviors().map((behavior) => behavior.PathPattern)).toEqual([
      MEDIA_PATH_PATTERN,
      API_PATH_PATTERN,
    ]);
  });

  it('メディアビヘイビアの ViewerProtocolPolicy が redirect-to-https', () => {
    expect(mediaBehavior().ViewerProtocolPolicy).toBe('redirect-to-https');
  });

  it('メディアビヘイビアに FunctionAssociations が無い', () => {
    // URI 書き換え Function は拡張子の無いパスに /index.html を足す。
    // メディアのキーに適用してはいけない。
    expect(mediaBehavior().FunctionAssociations).toBeUndefined();
  });
});
