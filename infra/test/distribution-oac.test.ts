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
  CustomOriginConfig?: Record<string, unknown>;
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

/**
 * オリジンを S3 と非 S3 に分解する。
 *
 * **非 S3 を黙って除外しない。** 総数 = S3 の数 + Lambda の数 という内訳を
 * 明示的に主張することで、分類漏れ（新種のオリジンが増えたのに誰も見ていない）が落ちる。
 */
const originsByKind = (): { all: CfnOrigin[]; s3: CfnOrigin[]; nonS3: CfnOrigin[] } => {
  const all = distributionOrigins();
  const s3 = all.filter((origin) => origin.S3OriginConfig !== undefined);
  const nonS3 = all.filter((origin) => origin.S3OriginConfig === undefined);
  return { all, s3, nonS3 };
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

  it('オリジンの内訳が S3 2 本 + 非 S3 1 本である', () => {
    // Phase 3 で Function URL オリジンが増えた。**総数と内訳の両方を主張する**ことで、
    // 「S3 だけ見て非 S3 を無視する」形にせず、分類漏れが出たら落ちるようにする。
    const { all, s3, nonS3 } = originsByKind();
    expect(all).toHaveLength(3);
    expect(s3).toHaveLength(2);
    expect(nonS3).toHaveLength(1);
  });

  it('非 S3 オリジンは Function URL（CustomOriginConfig を持ち https-only）である', () => {
    const { nonS3 } = originsByKind();
    const custom = nonS3[0]?.CustomOriginConfig as { OriginProtocolPolicy?: string } | undefined;
    expect(custom, '非 S3 オリジンは CustomOriginConfig を持つこと').toBeDefined();
    expect(custom?.OriginProtocolPolicy).toBe('https-only');
    expect(JSON.stringify(nonS3[0]?.DomainName)).toContain('Fn::Select');
  });

  it('すべての **S3** オリジンがバケットの RegionalDomainName（WebsiteURL ではない）を向いている', () => {
    // [0] だけを見ると 2 本目のオリジンが S3 ウェブサイトエンドポイントを向いていても
    // 検出できない。全件ループにしておくと同種が足された日も自動的にカバーされる。
    const bucketIds = logicalIdsOf('AWS::S3::Bucket', 2);
    const origins = originsByKind().s3;
    expect(origins).toHaveLength(2);
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
    // **S3 オリジン 1 本につき 1 本の Allow が要る。** バケットポリシーの Allow は
    // S3 オリジンにしか対応しない（Lambda オリジンの対応物は AWS::Lambda::Permission で、
    // 下の別ケースが主張している）。件数を結線数に縛ることで、S3 オリジンを足したのに
    // バケットポリシーを付け忘れた状態を落とす。
    expect(allows.length, 'CloudFront 向け Allow は S3 オリジンと同数であること').toBe(
      originsByKind().s3.length,
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

  it('OAC がちょうど 3 個で、すべて always / sigv4 である', () => {
    // hasResourceProperties は 1 件一致で通るので、2 本目が sigv4 でなくても
    // 検出できない。件数ガード + allResourcesProperties で全件を縛る。
    //
    // **OriginType は型ごとに分けて主張する（下のケース）。** ここで 's3' を
    // 一括で要求すると Function URL 用の OAC が作れず、逆に型を見ないと
    // lambda 用 OAC が s3 と書かれていても通ってしまう。
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 3);
    template.allResourcesProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  it('OAC の OriginAccessControlOriginType の内訳が s3 2 個・lambda 1 個である', () => {
    const types = Object.values(
      template.findResources('AWS::CloudFront::OriginAccessControl'),
    ).map((oac) => {
      const typed = oac as {
        Properties?: { OriginAccessControlConfig?: { OriginAccessControlOriginType?: string } };
      };
      return typed.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType;
    });
    expect(types.filter((type) => type === 's3')).toHaveLength(2);
    expect(types.filter((type) => type === 'lambda')).toHaveLength(1);
    expect(types.filter((type) => type !== 's3' && type !== 'lambda')).toEqual([]);
  });

  it('**OAC の論理 ID 集合が固定されている**（宣言順という見えない依存を縛る）', () => {
    // 実測: additionalBehaviors に /api/* を /media/* より **前** に書くと、
    // メディア用 OAC の論理 ID が SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA から
    // SiteDistributionOrigin3S3OriginAccessControl4BE73D82 に変わり、デプロイ時に
    // OAC の置換とバケットポリシーの書き換えが起きる。
    // 既存 2 本が Phase 2 から 1 文字も変わっていないこと自体が「置換なし」の証拠になる。
    expect(Object.keys(template.findResources('AWS::CloudFront::OriginAccessControl')).sort()).toEqual([
      'SiteDistributionOrigin1S3OriginAccessControl7D960FE6',
      'SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA',
      'SiteDistributionOrigin3FunctionUrlOriginAccessControl1ACDDE31',
    ]);
  });

  it('Lambda オリジンの対応物は AWS::Lambda::Permission である', () => {
    // S3 のバケットポリシーに相当するもの。**既存テストはバケットポリシーしか
    // 走査していなかったので、これを一切見ていなかった。**
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as Array<{
      Properties?: { Principal?: string; Action?: string; SourceArn?: unknown };
    }>;
    // **2 本必要。** InvokeFunctionUrl だけでは Function URL の IAM 認可が 403 を返し、
    // 関数が起動しないのでログも残らない（2026-08-30 の初回デプロイで実際に踏んだ）。
    // CloudFront 開発者ガイドは add-permission を 2 回実行するよう明示している。
    expect(permissions).toHaveLength(2);
    const actions = permissions.map((p) => p.Properties?.Action).sort();
    expect(actions).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    for (const permission of permissions) {
      expect(permission.Properties?.Principal).toBe('cloudfront.amazonaws.com');
      // confused deputy 対策。バケットポリシーの AWS:SourceArn と同じ役割。
      expect(JSON.stringify(permission.Properties?.SourceArn)).toContain(
        logicalIdOf('AWS::CloudFront::Distribution'),
      );
    }
  });

  it('3 つのオリジンがそれぞれ別の OAC を参照している（共有していない）', () => {
    const oacIds = logicalIdsOf('AWS::CloudFront::OriginAccessControl', 3);
    const origins = distributionOrigins();
    expect(origins).toHaveLength(3);
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
    expect(new Set(referenced).size, '3 本のオリジンが同じ OAC を共有していないこと').toBe(3);
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
