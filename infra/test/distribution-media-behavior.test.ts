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

/**
 * CloudFront が Lambda を **実際に呼べる**ための permission。
 *
 * `FunctionUrlOrigin.withOriginAccessControl` が出すのは `lambda:InvokeFunctionUrl`
 * の 1 文だけだが、それだけでは Function URL の IAM 認可が 403 を返し、
 * **関数が起動しないのでログすら残らない。**
 *
 * 初回デプロイで実際に踏んだ（2026-08-30）。症状は `POST /api/posts` が
 * `404` と `server: AmazonS3` を返すというもので、403 が
 * `CustomErrorResponses(403 -> /404.html)` によって 404 に化けるため、
 * 「ルーティングが効いていない」と誤読しやすい。**ロググループが空であることが
 * 唯一の手がかりだった。**
 *
 * CloudFront 開発者ガイド "Restrict access to an AWS Lambda function URL origin" は
 * `add-permission` を 2 回実行するよう明示している。AWS のブログ記事は 1 つしか
 * 示しておらずドキュメント間で食い違うが、実環境は開発者ガイドと一致する。
 */
describe('CloudFront から Lambda への invoke permission', () => {
  const permissions = (): Array<Record<string, unknown>> =>
    Object.values(template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)
      .filter((r) => r.Type === 'AWS::Lambda::Permission')
      .map((r) => r.Properties);

  it('permission がちょうど 2 本ある（非空を先に確かめる）', () => {
    expect(permissions()).toHaveLength(2);
  });

  it.each(['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'])(
    '%s が cloudfront.amazonaws.com に対して付いている',
    (action) => {
      const hit = permissions().filter(
        (p) => p.Action === action && p.Principal === 'cloudfront.amazonaws.com',
      );
      expect(
        hit,
        `${action} が無い。InvokeFunctionUrl だけだと Function URL が 403 を返し、` +
          `関数が起動しないためログも残らない（初回デプロイで実際に踏んだ）`,
      ).toHaveLength(1);
    },
  );

  it('どちらの permission もこのディストリビューションに限定されている', () => {
    for (const p of permissions()) {
      const src = JSON.stringify(p.SourceArn ?? null);
      expect(src, `SourceArn が無いと任意の配信元から invoke できてしまう`).toContain('distribution');
      expect(src).not.toContain('*');
    }
  });
});
