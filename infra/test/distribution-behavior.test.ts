import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

interface FunctionAssociation {
  EventType?: string;
  FunctionARN?: unknown;
}

interface DistributionConfig {
  DefaultRootObject?: string;
  Enabled?: boolean;
  DefaultCacheBehavior?: {
    ViewerProtocolPolicy?: string;
    FunctionAssociations?: FunctionAssociation[];
    LambdaFunctionAssociations?: unknown;
  };
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const functionSource = readFileSync(
  fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url)),
  'utf8',
);

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

const functionAssociations = (): FunctionAssociation[] =>
  distributionConfig().DefaultCacheBehavior?.FunctionAssociations ?? [];

describe('CloudFront Function の結線とビヘイビア', () => {
  it('AWS::CloudFront::Function がちょうど 1 個', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 1);
  });

  it('ランタイムが cloudfront-js-2.0（既定の 1.0 に落ちていない）', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
  });

  it('FunctionCode が rewrite-uri.js の中身と完全一致する', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: functionSource,
    });
  });

  it('viewer-request に Function がちょうど 1 つ結線されている', () => {
    const functionId = Object.keys(template.findResources('AWS::CloudFront::Function'))[0];
    expect(functionId).toBeDefined();

    const associations = functionAssociations();
    expect(associations).toHaveLength(1);
    expect(associations[0]?.EventType).toBe('viewer-request');
    expect(JSON.stringify(associations[0]?.FunctionARN)).toContain(functionId as string);
  });

  it('ViewerProtocolPolicy が redirect-to-https', () => {
    expect(distributionConfig().DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
      'redirect-to-https',
    );
  });

  it('DefaultRootObject が index.html', () => {
    expect(distributionConfig().DefaultRootObject).toBe('index.html');
  });

  it('Lambda@Edge を使っていない（CloudFront Functions で代替している）', () => {
    // 「そもそも何も結線していないから通った」を防ぐため、Function 結線を先に主張する。
    expect(functionAssociations()).toHaveLength(1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          LambdaFunctionAssociations: Match.absent(),
        }),
      }),
    });
  });

  it('Distribution が有効', () => {
    expect(distributionConfig().Enabled).toBe(true);
  });
});
