import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

/**
 * Template.fromStack ではなく、cdk synth がディスクに書いた実ファイルを検査する。
 * アサーションが実際の synth 出力と乖離していないことを確かめるのが目的。
 *
 * 特に本フェーズは cdk.json の context に
 * `@aws-cdk/core:defaultCrossStackReferences` を足しており、**この context は
 * cdk CLI 経由の合成にしか効かない**（vitest から new App() したときは既定値のまま）。
 * 実ファイルを読むテストがあることで、両者の差が出たときに気づける。
 */
const templatePath = (stackName: string): string =>
  fileURLToPath(new URL(`../cdk.out/${stackName}.template.json`, import.meta.url));

interface CfnTemplate {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
  [key: string]: unknown;
}

const readTemplate = (stackName: string): CfnTemplate => {
  const path = templatePath(stackName);
  if (!existsSync(path)) {
    throw new Error(`${path} が無い。先に npx -w infra cdk synth を実行すること`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CfnTemplate;
};

const readRaw = (stackName: string): string => readFileSync(templatePath(stackName), 'utf8');

const asTemplate = (stackName: string): Template =>
  Template.fromJSON(readTemplate(stackName) as { [key: string]: unknown });

/** テンプレート中のすべての (キー, 文字列値) を再帰的に集める。 */
const collectStrings = (node: unknown, key: string, out: Array<[string, string]>): void => {
  if (typeof node === 'string') {
    out.push([key, node]);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, key, out);
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [childKey, value] of Object.entries(node)) {
      collectStrings(value, childKey, out);
    }
  }
};

interface PolicyStatement {
  Effect?: string;
  Resource?: unknown;
}

/** テンプレート中のあらゆるポリシー文（信頼ポリシー・バケットポリシー・IAM ポリシー）を集める。 */
const collectPolicyStatements = (template: CfnTemplate): PolicyStatement[] => {
  const out: PolicyStatement[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record['Statement'])) {
        out.push(...(record['Statement'] as PolicyStatement[]));
      }
      for (const value of Object.values(record)) walk(value);
    }
  };
  walk(template.Resources);
  return out;
};

const STACKS = ['BlogSiteStack', 'BlogCicdStack'];

describe.each(STACKS)('cdk synth が出力した実テンプレート: %s', (stackName) => {
  it('テンプレートが存在し、JSON としてパースでき、Resources を持つ', () => {
    const template = readTemplate(stackName);
    expect(template.Resources).toBeDefined();
    expect(Object.keys(template.Resources ?? {}).length).toBeGreaterThan(0);
  });

  it('平文の秘密らしき値がテンプレートに無い', () => {
    const strings: Array<[string, string]> = [];
    collectStrings(readTemplate(stackName), '$root', strings);
    expect(strings.length).toBeGreaterThan(0);

    for (const [key, value] of strings) {
      expect(value, `${key} に AWS アクセスキーらしき文字列がある`).not.toMatch(
        /\bAKIA[0-9A-Z]{16}\b/,
      );
      expect(value, `${key} に PEM らしき文字列がある`).not.toContain('-----BEGIN');
      if (/password|secret/i.test(key)) {
        throw new Error(`秘密らしきキー ${key} に文字列リテラルが入っている: ${value}`);
      }
    }
  });

  it('Resource が "*" の Allow 文が 1 つも無い', () => {
    const statements = collectPolicyStatements(readTemplate(stackName));
    expect(statements.length, 'ポリシー文が 1 件以上あること').toBeGreaterThan(0);
    const wildcardAllows = statements.filter((statement) => {
      if (statement.Effect !== 'Allow') return false;
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      return resources.some((resource) => resource === '*');
    });
    expect(wildcardAllows).toEqual([]);
  });
});

describe('cdk synth が出力した実テンプレート: BlogSiteStack 固有', () => {
  it('実ファイル上でもバケットが 2 個で、ブロックパブリックアクセスが 4 つとも true', () => {
    const template = asTemplate('BlogSiteStack');
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toHaveLength(2);
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('実ファイル上でも OAI が 1 文字も出現しない', () => {
    const template = asTemplate('BlogSiteStack');
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    const raw = readRaw('BlogSiteStack');
    expect(raw).not.toContain('CloudFrontOriginAccessIdentity');
    expect(raw).not.toContain('origin-access-identity');
  });
});

describe('cdk synth が出力した実テンプレート: BlogCicdStack 固有', () => {
  it('実ファイル上でも sub が StringEquals で完全一致固定されている', () => {
    // Template.fromStack の結果ではなく、cdk CLI が実際に書き出したバイト列で確認する。
    // CDK のフィーチャーフラグや cdk.json の context が合成結果を変えても検出できる。
    const template = asTemplate('BlogCicdStack');
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as Array<{
      Properties?: {
        AssumeRolePolicyDocument?: {
          Statement?: Array<{ Condition?: Record<string, Record<string, unknown>> }>;
        };
      };
    }>;
    expect(roles).toHaveLength(1);
    const statements = roles[0]?.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
    expect(statements).toHaveLength(1);
    const condition = statements[0]?.Condition ?? {};
    expect(Object.keys(condition)).toEqual(['StringEquals']);
    expect(condition['StringEquals']?.['token.actions.githubusercontent.com:sub']).toBe(
      'repo:shutx-net/blog:ref:refs/heads/main',
    );
  });

  it('実ファイル上でも Lambda が 0 個（レガシーの OIDC プロバイダを使っていない）', () => {
    const template = asTemplate('BlogCicdStack');
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    expect(readRaw('BlogCicdStack')).not.toContain('AWSCDKOpenIdConnectProvider');
  });

  it('実ファイル上でも MediaBucket が 1 度も現れない', () => {
    const template = asTemplate('BlogCicdStack');
    template.resourceCountIs('AWS::IAM::Policy', 1);
    expect(readRaw('BlogCicdStack')).not.toContain('MediaBucket');
  });
});
