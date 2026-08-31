import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_DOMAIN_PREFIX, SITE_ORIGIN, SiteStack } from '../lib/site-stack.ts';

interface CfnResource {
  Type?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, unknown>;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const one = (type: string): CfnResource => {
  const found = template.findResources(type) as Record<string, CfnResource>;
  // 件数アサーションが非空ガードを兼ねる（infra/README.md の型 2）。
  expect(Object.keys(found), `${type} はちょうど 1 個`).toHaveLength(1);
  return Object.values(found)[0] as CfnResource;
};

const props = (type: string): Record<string, unknown> => one(type).Properties ?? {};

describe('ユーザプール', () => {
  it('AWS::Cognito::UserPool がちょうど 1 個', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('**UserPoolTier が ESSENTIALS**（Lite では Managed Login が使えない）', () => {
    // AWS 開発者ガイド:「Managed login is available in the Essentials and Plus tiers.
    // The classic hosted UI is available in all feature tiers.」
    // 無料枠は Lite も Essentials も 10,000 MAU/月なので、MAU 1 では請求額はどちらも 0 円。
    // **安いほうを選ぶ動機が存在しない。** Plus は無料枠が無いので採らない。
    expect(props('AWS::Cognito::UserPool')['UserPoolTier']).toBe('ESSENTIALS');
  });

  it('**AllowAdminCreateUserOnly が true**（単一著者プールで一番効いている 1 行）', () => {
    // false だと誰でもサインアップでき、cognito:username の固定だけでは守れなくなる。
    expect(props('AWS::Cognito::UserPool')['AdminCreateUserConfig']).toEqual({
      AllowAdminCreateUserOnly: true,
    });
  });

  it('DeletionProtection が ACTIVE で、Deletion/UpdateReplace が Retain', () => {
    const pool = one('AWS::Cognito::UserPool');
    expect(pool.Properties?.['DeletionProtection']).toBe('ACTIVE');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  it('UsernameConfiguration.CaseSensitive が true（API 側の完全一致と厳しさを揃える）', () => {
    // API 側で正規化するとプールより緩くなる。両側で同じ厳しさに揃えることに意味がある。
    expect(props('AWS::Cognito::UserPool')['UsernameConfiguration']).toEqual({
      CaseSensitive: true,
    });
  });

  it('パスワードポリシーが 16 文字以上で 4 種の Require* がすべて true', () => {
    const policy = (props('AWS::Cognito::UserPool')['Policies'] as Record<string, unknown>)[
      'PasswordPolicy'
    ] as Record<string, unknown>;
    expect(policy['MinimumLength'] as number).toBeGreaterThanOrEqual(16);
    expect(policy['RequireLowercase']).toBe(true);
    expect(policy['RequireUppercase']).toBe(true);
    expect(policy['RequireNumbers']).toBe(true);
    expect(policy['RequireSymbols']).toBe(true);
  });

  it('**EnabledMfas が SOFTWARE_TOKEN_MFA ちょうど 1 つ**（SMS を含まない）', () => {
    // SMS を有効にすると aws-cdk-lib が smsRole を自動生成する（IAM ロールが 1 個増える）。
    // TOTP なら追加のロールもコストも発生しない。
    expect(props('AWS::Cognito::UserPool')['EnabledMfas']).toEqual(['SOFTWARE_TOKEN_MFA']);
    expect(props('AWS::Cognito::UserPool')['MfaConfiguration']).toBe('OPTIONAL');
  });

  it('**AliasAttributes も UsernameAttributes も設定されていない**', () => {
    // usernameAttributes: ['email'] にすると Cognito は cognito:username に UUID を
    // 入れるため、**username を固定する設計が成立しなくなる**。
    // ここを固定するテストが無いと後から静かに壊れる。
    const pool = props('AWS::Cognito::UserPool');
    expect(pool['AliasAttributes']).toBeUndefined();
    expect(pool['UsernameAttributes']).toBeUndefined();
  });

  it('メールアドレスなど個人情報がテンプレートに書かれていない', () => {
    // このリポジトリは public。ユーザ作成は帯域外（aws cognito-idp admin-create-user）。
    expect(JSON.stringify(props('AWS::Cognito::UserPool'))).not.toContain('@');
  });
});

describe('Managed Login のドメイン', () => {
  it('AWS::Cognito::UserPoolDomain がちょうど 1 個', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('**ManagedLoginVersion が 2**（1 は classic hosted UI）', () => {
    expect(props('AWS::Cognito::UserPoolDomain')['ManagedLoginVersion']).toBe(2);
  });

  it('ドメイン接頭辞が定数と一致し、AWS アカウント ID を含まない', () => {
    // hosted UI の URL は利用者のブラウザに出るので、そこに AWS アカウント ID を載せない。
    expect(props('AWS::Cognito::UserPoolDomain')['Domain']).toBe(ADMIN_LOGIN_DOMAIN_PREFIX);
    expect(ADMIN_LOGIN_DOMAIN_PREFIX).not.toMatch(/\d{12}/);
    expect(ADMIN_LOGIN_DOMAIN_PREFIX).toMatch(/^[a-z0-9-]+$/);
  });

  it('カスタムドメイン（CustomDomainConfig）を使っていない', () => {
    expect(props('AWS::Cognito::UserPoolDomain')['CustomDomainConfig']).toBeUndefined();
  });
});

describe('アプリクライアント', () => {
  const client = (): Record<string, unknown> => props('AWS::Cognito::UserPoolClient');

  it('AWS::Cognito::UserPoolClient がちょうど 1 個', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  it('**GenerateSecret が false**（public client。SPA にシークレットは置けない）', () => {
    expect(client()['GenerateSecret']).toBe(false);
  });

  it('**AllowedOAuthFlows が ["code"] ちょうど**（implicit を含まない）', () => {
    // implicit はトークンを URL フラグメントに載せる古い方式。
    expect(client()['AllowedOAuthFlows']).toEqual(['code']);
    expect(client()['AllowedOAuthFlows']).not.toContain('implicit');
  });

  it('**AllowedOAuthScopes が ["openid"] ちょうど**', () => {
    // aws.cognito.signin.user.admin を含めると、アクセストークンで
    // ユーザ属性を書き換えられるようになる。
    expect(client()['AllowedOAuthScopes']).toEqual(['openid']);
    expect(client()['AllowedOAuthScopes']).not.toContain('aws.cognito.signin.user.admin');
  });

  it('**ExplicitAuthFlows が ["ALLOW_REFRESH_TOKEN_AUTH"] ちょうど**', () => {
    // **実測の罠**: aws-cdk-lib 2.267.0 の configureAuthFlows は
    //   if (!props.authFlows || Object.keys(props.authFlows).length === 0) return;
    // と書かれており、**authFlows: {} を渡すとプロパティ自体が描画されず、
    // Cognito の寛容な既定（SRP / custom を含む）が効いてしまう。**
    // キーを 1 つ以上持たせると ALLOW_REFRESH_TOKEN_AUTH だけが描画される。
    expect(client()['ExplicitAuthFlows']).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']);
  });

  it('ExplicitAuthFlows が描画されている（プロパティごと消えていない）', () => {
    // 上のテストだけだと undefined を toEqual で比べたときに気付きにくいので分ける。
    expect(client()['ExplicitAuthFlows']).toBeDefined();
    expect(Array.isArray(client()['ExplicitAuthFlows'])).toBe(true);
  });

  it('PreventUserExistenceErrors が ENABLED で EnableTokenRevocation が true', () => {
    expect(client()['PreventUserExistenceErrors']).toBe('ENABLED');
    expect(client()['EnableTokenRevocation']).toBe(true);
  });

  it('**RefreshTokenRotation を設定していない**（設定すると ExplicitAuthFlows から消える）', () => {
    // 実測: configureAuthFlows は
    //   props.refreshTokenRotationGracePeriod || authFlows.push('ALLOW_REFRESH_TOKEN_AUTH')
    // なので、rotation を有効にすると ALLOW_REFRESH_TOKEN_AUTH が **消える**。
    // この相互作用を検証する余裕は本フェーズに無いので rotation は入れない。
    expect(client()['RefreshTokenRotation']).toBeUndefined();
  });

  it('トークンの有効期間が id/access 60 分・refresh 1 日である', () => {
    expect(client()['IdTokenValidity']).toBe(60);
    expect(client()['AccessTokenValidity']).toBe(60);
    expect(client()['RefreshTokenValidity']).toBe(1440);
    expect(client()['TokenValidityUnits']).toEqual({
      IdToken: 'minutes',
      AccessToken: 'minutes',
      RefreshToken: 'minutes',
    });
  });

  it('**CallbackURLs が CloudFront の https オリジンで始まる**（http でも * でもない）', () => {
    const callbacks = client()['CallbackURLs'] as string[];
    expect(callbacks).toHaveLength(1);
    for (const url of callbacks) {
      expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
      expect(url.startsWith('https://')).toBe(true);
      expect(url).not.toContain('*');
      expect(url).not.toContain('http://');
    }
  });

  it('LogoutURLs も同じオリジンで、http でも * でもない', () => {
    const logouts = client()['LogoutURLs'] as string[];
    expect(logouts.length).toBeGreaterThan(0);
    for (const url of logouts) {
      expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
      expect(url).not.toContain('*');
      expect(url).not.toContain('http://');
    }
  });

  it('SupportedIdentityProviders が COGNITO だけ（外部 IdP を足していない）', () => {
    expect(client()['SupportedIdentityProviders']).toEqual(['COGNITO']);
  });
});

/**
 * **Cognito を足しても増えてはいけないものの数。**
 *
 * この 3 つはリポジトリが大事にしている約束（マネージドポリシー 0 /
 * カスタムリソース 0 / Resource:"*" 0）と直結している。
 */
describe('Cognito を足しても増えていないもの', () => {
  it('**AWS::IAM::Role が 1 個のまま**（SMS を有効にすると smsRole が増える）', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  it('**AWS::Lambda::Function が 1 個のまま**（Cognito のトリガ Lambda を足していない）', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('**Custom:: で始まるリソースが 0 個のまま**', () => {
    // UserPoolDomain.cloudFrontDomainName（**deprecated な getter**）を呼ぶと
    // AwsCustomResource が生まれ、Lambda + ManagedPolicyArns 付きロール +
    // Resource: "*" のポリシーが 3 つまとめて入る。**呼ばないこと。**
    // 必要なら cloudFrontEndpoint（単なる GetAtt）を使う。
    const all = template.toJSON()['Resources'] as Record<string, CfnResource>;
    const custom = Object.entries(all).filter(([, r]) => (r.Type ?? '').startsWith('Custom::'));
    expect(custom.map(([id]) => id)).toEqual([]);
  });

  it('ManagedPolicyArns を持つ Role が 0 個のまま', () => {
    const roles = template.findResources('AWS::IAM::Role') as Record<string, CfnResource>;
    expect(Object.keys(roles)).toHaveLength(1);
    for (const [id, role] of Object.entries(roles)) {
      expect(role.Properties?.['ManagedPolicyArns'], `${id} にマネージドポリシー`).toBeUndefined();
    }
  });
});

describe('CfnOutput（admin と運用者がここから拾う）', () => {
  const outputs = (): Record<string, { Value?: unknown; Description?: string }> =>
    (template.toJSON()['Outputs'] ?? {}) as Record<string, { Value?: unknown; Description?: string }>;

  /**
   * Construct 内で作った CfnOutput は論理 ID が
   * `<構築子パス><名前><ハッシュ>` になる（既存の PostingApiGitHubAppSecretName7D1D32A0
   * と同じ）。運用手順も `?ends_with(OutputKey, ...)` で引くので、部分一致で名指しする。
   */
  const outputNamed = (name: string): { Value?: unknown; Description?: string } => {
    const matches = Object.entries(outputs()).filter(([id]) => id.includes(name));
    // 件数アサーションが非空ガードを兼ねる。
    expect(matches.map(([id]) => id), `Output ${name} がちょうど 1 本`).toHaveLength(1);
    return matches[0]?.[1] as { Value?: unknown; Description?: string };
  };

  it.each([
    'AdminUserPoolId',
    'AdminUserPoolClientId',
    'AdminLoginDomain',
    'AdminUserPoolIssuerUrl',
  ])('Output %s がちょうど 1 本ある', (name) => {
    expect(outputNamed(name)).toBeDefined();
  });

  it('Phase 4 で Output が 4 本増えている（既存 6 本 + 4 本）', () => {
    expect(Object.keys(outputs())).toHaveLength(10);
  });

  it('ユーザプール ID の Output が Ref である（物理値をハードコードしていない）', () => {
    const value = outputNamed('AdminUserPoolId').Value as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['Ref']);
    expect(typeof value['Ref']).toBe('string');
  });

  it('アプリクライアント ID の Output も Ref である', () => {
    const value = outputNamed('AdminUserPoolClientId').Value as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['Ref']);
    expect(typeof value['Ref']).toBe('string');
  });

  it('issuer URL が userPoolProviderUrl（GetAtt ProviderURL）である', () => {
    // region は env 非指定なので {"Ref":"AWS::Region"} に解決される。**それで正しい。**
    const value = outputNamed('AdminUserPoolIssuerUrl').Value as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['Fn::GetAtt']);
    expect(value['Fn::GetAtt'] as string[]).toContain('ProviderURL');
  });

  it('Managed Login のドメインが <prefix>.auth.<region>.amazoncognito.com の形である', () => {
    const value = JSON.stringify(outputNamed('AdminLoginDomain').Value);
    expect(value).toContain(ADMIN_LOGIN_DOMAIN_PREFIX);
    expect(value).toContain('.auth.');
    expect(value).toContain('.amazoncognito.com');
    expect(value).toContain('https://');
  });
});
