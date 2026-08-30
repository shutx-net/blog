import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

/**
 * Template.fromStack ではなく、cdk synth がディスクに書いた実ファイルを検査する。
 * アサーションが実際の synth 出力と乖離していないことを確かめるのが目的。
 */
const TEMPLATE_PATH = fileURLToPath(
  new URL('../cdk.out/BlogSiteStack.template.json', import.meta.url),
);

interface CfnTemplate {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
  [key: string]: unknown;
}

const readTemplate = (): CfnTemplate => {
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `${TEMPLATE_PATH} が無い。先に npx -w infra cdk synth BlogSiteStack を実行すること`,
    );
  }
  return JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as CfnTemplate;
};

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

describe('cdk synth が出力した実テンプレート', () => {
  it('BlogSiteStack.template.json が存在し、Resources を持つ', () => {
    const template = readTemplate();
    expect(template.Resources).toBeDefined();
    expect(Object.keys(template.Resources ?? {}).length).toBeGreaterThan(0);
  });

  it('実ファイル上でもブロックパブリックアクセスが 4 つとも true', () => {
    const template = Template.fromJSON(readTemplate() as { [key: string]: unknown });
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toHaveLength(1);
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
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    const template = Template.fromJSON(readTemplate() as { [key: string]: unknown });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    expect(raw).not.toContain('CloudFrontOriginAccessIdentity');
    expect(raw).not.toContain('origin-access-identity');
  });

  it('平文の秘密らしき値がテンプレートに無い', () => {
    const strings: Array<[string, string]> = [];
    collectStrings(readTemplate(), '$root', strings);
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
});
