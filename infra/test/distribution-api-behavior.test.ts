import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { API_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

interface CacheBehavior {
  PathPattern?: string;
  TargetOriginId?: string;
  ViewerProtocolPolicy?: string;
  AllowedMethods?: string[];
  CachePolicyId?: string;
  OriginRequestPolicyId?: string;
  FunctionAssociations?: unknown;
  LambdaFunctionAssociations?: unknown;
}

interface DistributionConfig {
  Origins?: Array<Record<string, unknown>>;
  CacheBehaviors?: CacheBehavior[];
  DefaultCacheBehavior?: { TargetOriginId?: string };
}

/** AWS のマネージドポリシー ID（ドキュメント記載の固定値）。 */
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

/** PathPattern で名指しして取る（件数で位置を特定しない）。 */
const apiBehavior = (): CacheBehavior => {
  const found = (distributionConfig().CacheBehaviors ?? []).filter(
    (behavior) => behavior.PathPattern === API_PATH_PATTERN,
  );
  expect(found, `${API_PATH_PATTERN} のビヘイビアがちょうど 1 件であること`).toHaveLength(1);
  return found[0] as CacheBehavior;
};

describe('/api/* の追加ビヘイビア', () => {
  it('PathPattern がリテラル "/api/*" である', () => {
    expect(apiBehavior().PathPattern).toBe('/api/*');
    expect(API_PATH_PATTERN).toBe('/api/*');
  });

  it('デフォルトともメディアとも別のオリジンを向いている', () => {
    const target = apiBehavior().TargetOriginId;
    expect(target).toBeDefined();
    expect(target).not.toBe(distributionConfig().DefaultCacheBehavior?.TargetOriginId);
    const mediaTarget = (distributionConfig().CacheBehaviors ?? []).find(
      (behavior) => behavior.PathPattern === '/media/*',
    )?.TargetOriginId;
    expect(target).not.toBe(mediaTarget);
  });

  it('**ViewerProtocolPolicy が https-only である**（redirect-to-https ではない）', () => {
    // リダイレクトされると POST のボディが失われる。API へのプレーン HTTP は
    // 曖昧に転送せず拒否する。
    expect(apiBehavior().ViewerProtocolPolicy).toBe('https-only');
    expect(apiBehavior().ViewerProtocolPolicy).not.toBe('redirect-to-https');
  });

  it('**AllowedMethods に POST / PUT / DELETE が含まれる**', () => {
    // 既定は GET/HEAD だけ。指定を忘れると POST が 405 になる。
    const methods = apiBehavior().AllowedMethods ?? [];
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE']) {
      expect(methods, `${method} が許可されていない`).toContain(method);
    }
  });

  it('**CachePolicyId が CACHING_DISABLED である**', () => {
    // API の応答を CloudFront にキャッシュさせない。Lambda 側の
    // Cache-Control: no-store と二重化している。
    expect(apiBehavior().CachePolicyId).toBe(CACHING_DISABLED);
  });

  it('**OriginRequestPolicyId が ALL_VIEWER_EXCEPT_HOST_HEADER である**', () => {
    // **Host を転送すると OAC の SigV4 署名が Lambda URL のホストと一致せず必ず失敗する。**
    // ALL_VIEWER にすると Host が行くので落ちる。
    expect(apiBehavior().OriginRequestPolicyId).toBe(ALL_VIEWER_EXCEPT_HOST_HEADER);
  });

  it('**FunctionAssociations が無い**', () => {
    // URI 書き換え Function は拡張子の無いパスに /index.html を足すので、
    // /api/posts が /api/posts/index.html になってしまう。
    expect(apiBehavior().FunctionAssociations).toBeUndefined();
  });

  it('LambdaFunctionAssociations（Lambda@Edge）も無い', () => {
    expect(apiBehavior().LambdaFunctionAssociations).toBeUndefined();
  });

  it('Function URL オリジンが OAC を参照している', () => {
    const origins = distributionConfig().Origins ?? [];
    const apiOrigin = origins.find(
      (origin) => origin['Id'] === apiBehavior().TargetOriginId,
    );
    expect(apiOrigin, '/api/* のオリジンが見つからない').toBeDefined();
    expect(apiOrigin?.['OriginAccessControlId']).toBeDefined();
    expect(apiOrigin?.['S3OriginConfig'], 'Function URL オリジンは S3 ではない').toBeUndefined();
  });

  it('オリジンが Function URL のドメインを指している（バケットではない）', () => {
    const origins = distributionConfig().Origins ?? [];
    const apiOrigin = origins.find((origin) => origin['Id'] === apiBehavior().TargetOriginId);
    const domain = JSON.stringify(apiOrigin?.['DomainName']);
    expect(domain).toContain('FunctionUrl');
    expect(domain).not.toContain('Bucket');
  });
});
