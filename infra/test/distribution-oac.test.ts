import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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

/** 複数個ありうる型の論理 ID。件数を主張してから返すので非空ガードを兼ねる。 */
const logicalIdsOf = (type: string, expected: number): string[] => {
  const ids = Object.keys(template.findResources(type));
  expect(ids, `${type} がちょうど ${expected} 個であること`).toHaveLength(expected);
  return ids;
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

  it('すべてのオリジンがバケットの RegionalDomainName（WebsiteURL ではない）を向いている', () => {
    // [0] だけを見ると 2 本目のオリジンが S3 ウェブサイトエンドポイントを向いていても
    // 検出できない。全件ループにしておくと 3 本目が足された日も自動的にカバーされる。
    const bucketIds = logicalIdsOf('AWS::S3::Bucket', 2);
    const origins = distributionOrigins();
    expect(origins.length).toBeGreaterThan(0);
    for (const [index, origin] of origins.entries()) {
      const domainName = origin.DomainName as { 'Fn::GetAtt'?: [string, string] } | undefined;
      const getAtt = domainName?.['Fn::GetAtt'];
      expect(getAtt, `Origins[${index}].DomainName が Fn::GetAtt であること`).toBeDefined();
      expect(bucketIds, `Origins[${index}] は S3 バケットを向いていること`).toContain(getAtt?.[0]);
      expect(getAtt?.[1]).toBe('RegionalDomainName');
      expect(JSON.stringify(origin.DomainName)).not.toContain('WebsiteURL');
    }
  });

  it('どちらのバケットポリシーも s3:GetObject を cloudfront.amazonaws.com に Allow している', () => {
    // オリジンが 2 本になったので Allow も 2 文。1 文だけ検査すると
    // メディアバケット側が無検査になる。
    const allows = bucketPolicyStatements().filter(
      (s) => s.Effect === 'Allow' && isCloudFrontServicePrincipal(s),
    );
    expect(allows).toHaveLength(2);
    for (const [index, allow] of allows.entries()) {
      expect(actionsOf(allow), `Allow[${index}] の Action`).toContain('s3:GetObject');
    }
  });

  it('どの CloudFront 向け Allow にも AWS:SourceArn 条件があり、このディストリビューションに限定されている', () => {
    // Array.prototype.find は **最初の** 一致しか見ない。バケットが 2 個になると
    // 2 本目のバケットポリシーの SourceArn が一切検証されない状態に静かに退化する。
    // filter + 件数ガード + 全件ループに置き換える。
    const distId = logicalIdOf('AWS::CloudFront::Distribution');
    const allows = bucketPolicyStatements().filter(
      (s) => s.Effect === 'Allow' && isCloudFrontServicePrincipal(s),
    );
    // オリジン 1 本につき 1 本の Allow が要る。件数を結線数に縛ることで、
    // オリジンを足したのにバケットポリシーを付け忘れた状態を落とす。
    expect(allows.length, 'CloudFront 向け Allow はオリジンと同数であること').toBe(
      distributionOrigins().length,
    );
    expect(allows.length).toBeGreaterThan(0);
    for (const [index, allow] of allows.entries()) {
      const sourceArn = allow.Condition?.StringEquals?.['AWS:SourceArn'];
      expect(sourceArn, `Allow[${index}] に confused deputy 対策の AWS:SourceArn が必要`).toBeDefined();
      expect(JSON.stringify(sourceArn)).toContain(distId);
    }
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

  it('OAC がちょうど 2 個で、すべて s3 / always / sigv4 である', () => {
    // hasResourceProperties は 1 件一致で通るので、2 本目が sigv4 でなくても
    // 検出できない。件数ガード + allResourcesProperties で全件を縛る。
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    template.allResourcesProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  it('2 つのオリジンがそれぞれ別の OAC を参照している（共有していない）', () => {
    const oacIds = logicalIdsOf('AWS::CloudFront::OriginAccessControl', 2);
    const origins = distributionOrigins();
    expect(origins).toHaveLength(2);
    const referenced = origins.map((origin) => {
      const attr = origin.OriginAccessControlId as { 'Fn::GetAtt'?: [string, string] } | undefined;
      const getAtt = attr?.['Fn::GetAtt'];
      expect(getAtt, 'オリジンは OAC を Fn::GetAtt で参照すること').toBeDefined();
      expect(getAtt?.[1]).toBe('Id');
      return getAtt?.[0] as string;
    });
    for (const ref of referenced) {
      expect(oacIds).toContain(ref);
    }
    expect(new Set(referenced).size, '2 本のオリジンが同じ OAC を共有していないこと').toBe(2);
  });

  it('バケットポリシーが 2 本あり、どちらも CloudFront への Allow がちょうど 1 文だけである', () => {
    expect(Object.keys(template.findResources('AWS::S3::BucketPolicy'))).toHaveLength(2);
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy')) as Array<{
      Properties?: { PolicyDocument?: { Statement?: PolicyStatement[] } };
    }>;
    for (const policy of policies) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      const allows = statements.filter(
        (s) => s.Effect === 'Allow' && isCloudFrontServicePrincipal(s),
      );
      expect(allows, 'バケットごとに CloudFront 向け Allow はちょうど 1 文').toHaveLength(1);
      expect(actionsOf(allows[0] as PolicyStatement)).toEqual(['s3:GetObject']);
      expect(allows[0]?.Condition?.StringEquals?.['AWS:SourceArn']).toBeDefined();
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
