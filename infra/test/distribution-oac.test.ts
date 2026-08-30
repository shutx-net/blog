import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

interface PolicyStatement {
  Effect?: string;
  Action?: string | string[];
  Principal?: unknown;
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

interface CfnOrigin {
  DomainName?: unknown;
  OriginAccessControlId?: unknown;
  S3OriginConfig?: Record<string, unknown>;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));
const templateJson = JSON.stringify(template.toJSON());

const logicalIdOf = (type: string): string => {
  const ids = Object.keys(template.findResources(type));
  expect(ids, `${type} がちょうど 1 個であること`).toHaveLength(1);
  return ids[0] as string;
};

const distributionOrigins = (): CfnOrigin[] => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: { Origins?: CfnOrigin[] } } }
    | undefined;
  return dist?.Properties?.DistributionConfig?.Origins ?? [];
};

const bucketPolicyStatements = (): PolicyStatement[] => {
  const found = template.findResources('AWS::S3::BucketPolicy');
  return Object.values(found).flatMap((policy) => {
    const typed = policy as { Properties?: { PolicyDocument?: { Statement?: PolicyStatement[] } } };
    return typed.Properties?.PolicyDocument?.Statement ?? [];
  });
};

const actionsOf = (statement: PolicyStatement): string[] => {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  return action ?? [];
};

const isCloudFrontServicePrincipal = (statement: PolicyStatement): boolean =>
  JSON.stringify(statement.Principal ?? {}).includes('cloudfront.amazonaws.com');

/** OAI 不在の主張が「そもそも CloudFront が無いから通った」にならないようにする。 */
const expectDistributionExists = (): void => {
  expect(Object.keys(template.findResources('AWS::CloudFront::Distribution')).length).toBe(1);
};

describe('CloudFront Distribution と OAC の結線', () => {
  it('AWS::CloudFront::Distribution がちょうど 1 個', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('OriginAccessControl がちょうど 1 個で、s3 / always / sigv4 である', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
  });

  it('Origins[0] が OAC リソースを参照している', () => {
    const oacId = logicalIdOf('AWS::CloudFront::OriginAccessControl');
    const origins = distributionOrigins();
    expect(origins).toHaveLength(1);
    expect(origins[0]?.OriginAccessControlId).toBeDefined();
    expect(JSON.stringify(origins[0]?.OriginAccessControlId)).toContain(oacId);
  });

  it('Origins[0].DomainName がバケットの RegionalDomainName（WebsiteURL ではない）', () => {
    const bucketId = logicalIdOf('AWS::S3::Bucket');
    const origins = distributionOrigins();
    expect(origins[0]?.DomainName).toEqual({ 'Fn::GetAtt': [bucketId, 'RegionalDomainName'] });
    expect(JSON.stringify(origins[0]?.DomainName)).not.toContain('WebsiteURL');
  });

  it('バケットポリシーが s3:GetObject を cloudfront.amazonaws.com に Allow している', () => {
    const allows = bucketPolicyStatements().filter(
      (s) => s.Effect === 'Allow' && isCloudFrontServicePrincipal(s),
    );
    expect(allows).toHaveLength(1);
    expect(actionsOf(allows[0] as PolicyStatement)).toContain('s3:GetObject');
  });

  it('その Allow に AWS:SourceArn 条件があり、このディストリビューションに限定されている', () => {
    const distId = logicalIdOf('AWS::CloudFront::Distribution');
    const allow = bucketPolicyStatements().find(
      (s) => s.Effect === 'Allow' && isCloudFrontServicePrincipal(s),
    );
    const sourceArn = allow?.Condition?.StringEquals?.['AWS:SourceArn'];
    expect(sourceArn, 'confused deputy 対策の AWS:SourceArn 条件が必要').toBeDefined();
    expect(JSON.stringify(sourceArn)).toContain(distId);
  });

  it('バケットポリシーに Principal * の Allow が 1 つも無い', () => {
    expectDistributionExists();
    const wildcardAllows = bucketPolicyStatements().filter((s) => {
      if (s.Effect !== 'Allow') return false;
      const principal = s.Principal;
      if (principal === '*') return true;
      return (
        typeof principal === 'object' &&
        principal !== null &&
        (principal as { AWS?: unknown }).AWS === '*'
      );
    });
    expect(wildcardAllows).toEqual([]);
  });

  it('CloudFront に許可されているのは読み取りのみ（書き込み権限を与えていない）', () => {
    const allows = bucketPolicyStatements().filter((s) => s.Effect === 'Allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const statement of allows) {
      expect(actionsOf(statement)).toEqual(['s3:GetObject']);
    }
  });

  it('AWS::CloudFront::CloudFrontOriginAccessIdentity が 0 個', () => {
    expectDistributionExists();
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
  });

  it('テンプレート全文のどこにも OAI が紛れ込んでいない', () => {
    expectDistributionExists();
    expect(templateJson).not.toContain('CloudFrontOriginAccessIdentity');
    expect(templateJson).not.toContain('origin-access-identity');
  });
});
