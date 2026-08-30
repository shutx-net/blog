import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { MEDIA_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

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

/** 件数を先に主張して非空ガードにしてから、唯一のビヘイビアを取る。 */
const mediaBehavior = (): CacheBehavior => {
  const behaviors = cacheBehaviors();
  expect(behaviors, '追加ビヘイビアがちょうど 1 件であること').toHaveLength(1);
  return behaviors[0] as CacheBehavior;
};

describe('/media/* の追加ビヘイビア', () => {
  it('CacheBehaviors がちょうど 1 件で、PathPattern が定数と一致する', () => {
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

  it('Origins がちょうど 2 件ある', () => {
    expect(distributionConfig().Origins).toHaveLength(2);
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
