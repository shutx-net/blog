import { App, Token } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  CicdStack,
  DEPLOY_SUBJECT,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_URL,
  GITHUB_REPOSITORY,
} from '../lib/cicd-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';

interface CfnResource {
  Type?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, unknown>;
}

/** SiteStack を作ってから、その出力を CicdStack に渡す（参照は一方向）。 */
const buildStacks = (): { site: SiteStack; cicd: CicdStack } => {
  const app = new App();
  const site = new SiteStack(app, 'TestSiteStack');
  const cicd = new CicdStack(app, 'TestCicdStack', {
    siteBucket: site.siteBucket,
    distribution: site.distribution,
  });
  return { site, cicd };
};

const cicdTemplate = (): Template => Template.fromStack(buildStacks().cicd);

const template = cicdTemplate();

const oidcProvider = (): CfnResource => {
  const found = template.findResources('AWS::IAM::OIDCProvider');
  const ids = Object.keys(found);
  expect(ids, 'AWS::IAM::OIDCProvider がちょうど 1 個であること').toHaveLength(1);
  return found[ids[0] as string] as CfnResource;
};

describe('CicdStack の合成', () => {
  it('Template.fromStack() に渡して例外なく合成できる', () => {
    expect(() => cicdTemplate()).not.toThrow();
  });

  it('env を指定していない（SiteStack と同じく env-agnostic）', () => {
    const { cicd } = buildStacks();
    expect(Token.isUnresolved(cicd.region)).toBe(true);
    expect(Token.isUnresolved(cicd.account)).toBe(true);
    expect(cicd.environment).toBe('aws://unknown-account/unknown-region');
  });
});

describe('GitHub の OIDC プロバイダ（ネイティブリソース）', () => {
  it('AWS::IAM::OIDCProvider がちょうど 1 個', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  });

  it('Lambda もカスタムリソースも 0 個（レガシーの OpenIdConnectProvider を使っていない）', () => {
    // レガシー版は Custom::AWSCDKOpenIdConnectProvider と、iam:CreateOpenIDConnectProvider 等を
    // Resource:"*" で持つ Lambda 実行ロールを生やす。IAM の ID プロバイダを丸ごと操作できる
    // Lambda がアカウントに常駐することになり、「public リポジトリの CI に最小権限を与える」
    // という本スタックの主題と真っ向から衝突する。機械的に禁止する。
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    expect(JSON.stringify(template.toJSON())).not.toContain('AWSCDKOpenIdConnectProvider');
  });

  it('Url が GitHub の OIDC エンドポイントである', () => {
    expect(oidcProvider().Properties?.['Url']).toBe(GITHUB_OIDC_URL);
    expect(oidcProvider().Properties?.['Url']).toBe('https://token.actions.githubusercontent.com');
  });

  it('ClientIdList が sts.amazonaws.com ちょうど 1 件（audience を増やさない）', () => {
    expect(oidcProvider().Properties?.['ClientIdList']).toEqual([GITHUB_OIDC_AUDIENCE]);
    expect(oidcProvider().Properties?.['ClientIdList']).toEqual(['sts.amazonaws.com']);
  });

  it('ThumbprintList が無い（古い固定サムプリントをコピーしていない）', () => {
    // AWS は信頼された root CA で JWKS エンドポイントの TLS 証明書を検証するため
    // サムプリントは使われない。6938fd4d... のような固定値を書くと、GitHub が
    // 証明書を切り替えた日に assume が全部落ちる時限爆弾になる。
    expect(oidcProvider().Properties?.['ThumbprintList']).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toContain('6938fd4d98bab03faadb97b34396831e3780aea1');
  });

  it('DeletionPolicy と UpdateReplacePolicy が Retain（CDK の既定は DESTROY）', () => {
    // OIDC プロバイダは URL ごとにアカウントに 1 つしか作れない共有資源。
    // CicdStack を消すと、同じプロバイダを信頼する他のロールが全部壊れる。
    const provider = oidcProvider();
    expect(provider.DeletionPolicy).toBe('Retain');
    expect(provider.UpdateReplacePolicy).toBe('Retain');
  });
});

/**
 * 信頼ポリシーの検査。**本スタックで最も重要な成果物。**
 *
 * リポジトリが public なので、ロール ARN は漏れる前提で考える必要がある。
 * IAM 自身は sub が単独のワイルドカードでないことしか検査しないため、
 * テストは IAM より厳しくなければならない。以下は 6 方向から囲う:
 *   (1) 文がちょうど 1 つ  (2) Principal が Federated のみ
 *   (3) Condition の演算子が StringEquals ただ 1 つ
 *   (4) StringEquals のキーが aud と sub ちょうど 2 つ
 *   (5) それぞれの値が完全一致  (6) 全文にワイルドカード文字が 0 個
 */
const OIDC_CLAIM_AUD = 'token.actions.githubusercontent.com:aud';
const OIDC_CLAIM_SUB = 'token.actions.githubusercontent.com:sub';

interface TrustStatement {
  Effect?: string;
  Action?: unknown;
  Principal?: Record<string, unknown>;
  Condition?: Record<string, Record<string, unknown>>;
}

const deployRole = (): CfnResource => {
  const found = template.findResources('AWS::IAM::Role');
  const ids = Object.keys(found);
  // 【非空ガード】ロールが 1 個であることを先に主張しないと、以降の「文の中身」の
  // アサーションは 0 件で素通りしうる。
  expect(ids, 'AWS::IAM::Role がちょうど 1 個であること').toHaveLength(1);
  return found[ids[0] as string] as CfnResource;
};

const trustStatements = (): TrustStatement[] => {
  const doc = deployRole().Properties?.['AssumeRolePolicyDocument'] as
    | { Statement?: TrustStatement[] }
    | undefined;
  return doc?.Statement ?? [];
};

/** 唯一の信頼文。「文がちょうど 1 つ」は、正しい文の隣にゆるい第 2 の文を足す裏口を禁止する。 */
const trustStatement = (): TrustStatement => {
  const statements = trustStatements();
  expect(statements, 'AssumeRolePolicyDocument.Statement がちょうど 1 文であること').toHaveLength(1);
  return statements[0] as TrustStatement;
};

const stringEquals = (): Record<string, unknown> =>
  (trustStatement().Condition?.['StringEquals'] ?? {}) as Record<string, unknown>;

describe('デプロイロールの信頼ポリシー', () => {
  it('【非空ガード】ロールが 1 個で、信頼ポリシーの文がちょうど 1 つ', () => {
    expect(Object.keys(template.findResources('AWS::IAM::Role'))).toHaveLength(1);
    expect(trustStatements()).toHaveLength(1);
  });

  it('【誤り(f)】Action が sts:AssumeRoleWithWebIdentity 完全一致で、Effect が Allow', () => {
    const statement = trustStatement();
    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(Array.isArray(statement.Action), 'Action を配列にして増やしていないこと').toBe(false);
    expect(statement.Effect).toBe('Allow');
  });

  it('【誤り(g)】Principal のキー集合が ["Federated"] ちょうどで、このスタックの OIDCProvider を指す', () => {
    const providerIds = Object.keys(template.findResources('AWS::IAM::OIDCProvider'));
    expect(providerIds).toHaveLength(1);
    const principal = trustStatement().Principal ?? {};
    expect(Object.keys(principal)).toEqual(['Federated']);
    expect(principal['Federated']).toEqual({ Ref: providerIds[0] as string });
  });

  it('【誤り(g)】Principal に AWS / Service / CanonicalUser が無い', () => {
    const principal = trustStatement().Principal ?? {};
    expect(principal['AWS']).toBeUndefined();
    expect(principal['Service']).toBeUndefined();
    expect(principal['CanonicalUser']).toBeUndefined();
  });

  it('【誤り(b)】Condition の演算子キー集合が ["StringEquals"] とちょうど一致する', () => {
    // StringLike / ForAnyValue:StringLike / StringEqualsIgnoreCase などが
    // 1 つでも増えた時点で落ちる。
    expect(Object.keys(trustStatement().Condition ?? {})).toEqual(['StringEquals']);
  });

  it('【誤り(a)(c)】StringEquals のキー集合が aud と sub ちょうど 2 つと一致する', () => {
    // sub 条件が丸ごと無い誤りも、:subject のような綴り違いも、
    // :repository / :repository_owner / :actor への差し替えもここで落ちる。
    // **特に repository_owner だけに条件を付けるのは「org 内のどのリポジトリからでも
    // assume できる」という典型的な事故で、キー集合の完全一致がこれを落とす。**
    expect(Object.keys(stringEquals()).sort()).toEqual([OIDC_CLAIM_AUD, OIDC_CLAIM_SUB].sort());
  });

  it('【誤り(d)】aud が sts.amazonaws.com と完全一致する', () => {
    expect(stringEquals()[OIDC_CLAIM_AUD]).toBe(GITHUB_OIDC_AUDIENCE);
    expect(stringEquals()[OIDC_CLAIM_AUD]).toBe('sts.amazonaws.com');
  });

  it('【誤り(e)】sub が repo:shutx-net/blog:ref:refs/heads/main と完全一致する', () => {
    // 定数だけで比較すると、定数を緩めたときテストが一緒に動いてしまう。
    // リテラルとの一致も主張して、実際に信頼するブランチを固定する。
    expect(stringEquals()[OIDC_CLAIM_SUB]).toBe(DEPLOY_SUBJECT);
    expect(stringEquals()[OIDC_CLAIM_SUB]).toBe('repo:shutx-net/blog:ref:refs/heads/main');
  });

  it('【誤り(e)】sub がこのリポジトリで始まる（別リポジトリに差し替わっていない）', () => {
    expect(String(stringEquals()[OIDC_CLAIM_SUB]).startsWith(`repo:${GITHUB_REPOSITORY}:`)).toBe(
      true,
    );
  });

  it('【誤り(b) 二重の網】信頼ポリシー全文にワイルドカード文字が 1 つも無い', () => {
    // 演算子が StringEquals でも、値にワイルドカードを入れれば無意味になる。
    // 値の側からも塞ぐ。
    const raw = JSON.stringify(deployRole().Properties?.['AssumeRolePolicyDocument']);
    expect(raw.includes('*'), `信頼ポリシーに * がある: ${raw}`).toBe(false);
    expect(raw.includes('?'), `信頼ポリシーに ? がある: ${raw}`).toBe(false);
  });
});
