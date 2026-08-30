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

  it('**実ファイル上でも Secret の Properties キーが ["Description"] のみ**', () => {
    // Template.fromStack ではなく cdk CLI が書いたバイト列で確認する。
    // フィーチャーフラグや cdk.json の context が合成結果を変えても検出できる。
    //
    // CDK の既定（GenerateSecretString: {}）に戻ると、デプロイ時に 32 文字の
    // ランダムパスワードが AWSCURRENT に入る。**このアサーションと
    // test/posting-api.test.ts の同等のものだけが検出できる**（実測）。
    const secrets = Object.values(
      asTemplate('BlogSiteStack').findResources('AWS::SecretsManager::Secret'),
    ) as Array<{ Properties?: Record<string, unknown> }>;
    expect(secrets).toHaveLength(1);
    expect(Object.keys(secrets[0]?.Properties ?? {}).sort()).toEqual(['Description']);
  });

  it('**実ファイル上でも ManagedPolicyArns を持つ IAM::Role が 0 個**', () => {
    // 上の『Resource が "*" の Allow 文が 1 つも無い』の穴を塞ぐ。
    // マネージドポリシーは ARN 参照なのでポリシー文がテンプレートに現れず、
    // AWSLambdaBasicExecutionRole（logs:* を Resource "*" に許可）が付いていても
    // あちらは緑のまま通る。**実測で確認済み。**
    const roles = Object.values(
      asTemplate('BlogSiteStack').findResources('AWS::IAM::Role'),
    ) as Array<{ Properties?: Record<string, unknown> }>;
    expect(roles.length, 'ロールが 1 件以上あること').toBeGreaterThan(0);
    expect(roles.filter((role) => role.Properties?.['ManagedPolicyArns'] !== undefined)).toEqual([]);
  });

  it('実ファイル上でも Lambda::Url の AuthType が AWS_IAM', () => {
    const urls = Object.values(
      asTemplate('BlogSiteStack').findResources('AWS::Lambda::Url'),
    ) as Array<{ Properties?: { AuthType?: string } }>;
    expect(urls).toHaveLength(1);
    expect(urls[0]?.Properties?.AuthType).toBe('AWS_IAM');
  });

  it('実ファイル上でも AUTH_MODE が deny-all', () => {
    const functions = Object.values(
      asTemplate('BlogSiteStack').findResources('AWS::Lambda::Function'),
    ) as Array<{ Properties?: { Environment?: { Variables?: Record<string, unknown> } } }>;
    expect(functions).toHaveLength(1);
    expect(functions[0]?.Properties?.Environment?.Variables?.['AUTH_MODE']).toBe('deny-all');
  });

  it('生バイト列にも -----BEGIN が現れない（collectStrings と二重化）', () => {
    // 上の describe.each が collectStrings で走査しているのと同じことを、
    // **文字列としての grep 相当**でもう一度行う。構造化された走査が
    // 見落とす場所（キー名やコメント）に入っても落ちる。
    expect(readRaw('BlogSiteStack')).not.toContain('-----BEGIN');
  });

  it('実ファイル上でも OAC が 3 個・Lambda::Permission が 2 個', () => {
    const template = asTemplate('BlogSiteStack');
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 3);
    template.resourceCountIs('AWS::Lambda::Permission', 2);
  });
});

/**
 * **アセットという新しい乖離源。**
 *
 * Phase 3 でテンプレートは api/dist の内容ハッシュを S3Key に埋めるようになった。
 * つまり **api をビルドせずに synth するとテンプレートは通るのに中身が古い**。
 * assets.json と実ファイルの突き合わせがその防波堤になる。
 */
describe('Lambda のアセットが実在する', () => {
  interface AssetManifest {
    files?: Record<string, { source?: { packaging?: string; path?: string } }>;
  }

  const manifest = (): AssetManifest =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../cdk.out/BlogSiteStack.assets.json', import.meta.url)), 'utf8'),
    ) as AssetManifest;

  it('assets.json に zip のエントリがある', () => {
    const zips = Object.values(manifest().files ?? {}).filter(
      (file) => file.source?.packaging === 'zip',
    );
    expect(zips.length, 'Lambda のアセットが 1 件以上あること').toBeGreaterThan(0);
  });

  it('**Code.S3Key がテンプレートに埋まっており、対応する実体が cdk.out にある**', () => {
    const functions = Object.values(
      asTemplate('BlogSiteStack').findResources('AWS::Lambda::Function'),
    ) as Array<{ Properties?: { Code?: { S3Key?: string } } }>;
    expect(functions).toHaveLength(1);
    const s3Key = functions[0]?.Properties?.Code?.S3Key;
    expect(s3Key, 'Code.S3Key が無い').toBeDefined();

    // S3Key は '<hash>.zip'。assets.json の同じハッシュのエントリを探す。
    const hash = String(s3Key).replace(/\.zip$/, '');
    const entry = (manifest().files ?? {})[hash];
    expect(entry, `assets.json に ${hash} のエントリが無い`).toBeDefined();
    expect(entry?.source?.packaging).toBe('zip');

    const assetPath = fileURLToPath(new URL(`../cdk.out/${entry?.source?.path}`, import.meta.url));
    expect(existsSync(assetPath), `${assetPath} が実在しない`).toBe(true);
  });

  it('**アセットの中身が api/dist/index.mjs である**', () => {
    // ディレクトリのままステージングされるので、中に index.mjs があること自体を見る。
    // 「ビルドし忘れて古いバンドルが入った」は内容ハッシュが変わるので S3Key に出るが、
    // そもそもファイルが無い状態はここで落ちる。
    const zips = Object.entries(manifest().files ?? {}).filter(
      ([, file]) => file.source?.packaging === 'zip',
    );
    expect(zips.length).toBeGreaterThan(0);
    for (const [, file] of zips) {
      const dir = fileURLToPath(new URL(`../cdk.out/${file.source?.path}`, import.meta.url));
      expect(existsSync(`${dir}/index.mjs`), `${dir}/index.mjs が無い`).toBe(true);
    }
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
    // **immutable subject claim 形式**（2026-07-15 以降に作成されたリポジトリの既定）。
    // ここは意図的にリテラルだけで比較する — DEPLOY_SUBJECT を import すると
    // 「定数と合成結果が一致する」ことしか言えず、実ファイルを読む意味が消える。
    expect(condition['StringEquals']?.['token.actions.githubusercontent.com:sub']).toBe(
      'repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/main',
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
