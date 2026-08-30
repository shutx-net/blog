import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * 管理画面のログイン用 Cognito ユーザプール（単一著者）。
 *
 * **Stack ではなく Construct にしている**（CloudFront に紐づくものを別 Stack にすると
 * DependencyCycle になる、という Phase 2・3 の実測に揃える）。厳密には Cognito は
 * CloudFront を参照しないが、**CallbackURLs が配信ドメインに依存する**ので
 * MediaBucket / PostingApi と同じ構成にそろえるのが自然である。
 *
 * ## 入れていないもの（意図的）
 *
 * - **UserPoolGroup も IdentityPool も作らない。** 単一著者なので
 *   `cognito:username` の完全一致で足りる。ブラウザに AWS 資格情報を渡す設計は採らない
 *   （S3 への書き込みは API が発行する presigned PUT だけ）。
 * - **カスタムドメインと ACM を入れない。** Managed Login は
 *   `<prefix>.auth.<region>.amazoncognito.com` のまま使う。
 * - **refresh token rotation を入れない。** aws-cdk-lib 2.267.0 の `configureAuthFlows` は
 *   `props.refreshTokenRotationGracePeriod || authFlows.push('ALLOW_REFRESH_TOKEN_AUTH')`
 *   と書かれており、**rotation を有効にすると ExplicitAuthFlows から
 *   ALLOW_REFRESH_TOKEN_AUTH が消える**（実測）。この相互作用を検証する余裕が無い。
 * - **Plus tier / threat protection を入れない。** MAU 1 の個人ブログに月額を払う理由が無く、
 *   Plus には無料枠が無い（AWS 料金ページ:「There is no free tier for the Plus tier.」）。
 * - **`advancedSecurityMode` は 1 文字も書かない。** `undefined` を明示的に渡しても
 *   deprecation 警告が出る（実測）。キーごと存在させない。
 */
export interface AdminAuthProps {
  /**
   * Managed Login のドメイン接頭辞。**グローバルに一意でなければならない。**
   *
   * CDK に自動生成させられないので「物理名をハードコードしない」方針の
   * **意図的な例外**になる。秘密ではないし、取られていたら deploy が大きな音を立てて
   * 落ちるだけなので安全側に転ぶ。
   */
  readonly domainPrefix: string;

  /** ログイン後の戻り先のオリジン（CloudFront の配信ドメイン）。 */
  readonly siteOrigin: string;
}

export class AdminAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AdminAuthProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      // **ESSENTIALS。Lite ではない。** Managed Login は Essentials 以上でしか使えない
      // （AWS 開発者ガイド:「Managed login is available in the Essentials and Plus tiers.
      // The classic hosted UI is available in all feature tiers.」）。
      // 無料枠は Lite も Essentials も 10,000 MAU/月なので、MAU 1 では請求額はどちらも 0 円。
      featurePlan: cognito.FeaturePlan.ESSENTIALS,

      // **単一著者プールで一番効いている 1 行。** false（= AllowAdminCreateUserOnly: true）
      // でないと誰でもサインアップでき、cognito:username の固定だけでは守れなくなる。
      selfSignUpEnabled: false,

      // username のみ。**email を別名にしない**（後述の signInCaseSensitive と合わせて、
      // cognito:username が UUID にならないことを保証する）。
      signInAliases: { username: true, email: false, phone: false, preferredUsername: false },

      // API 側は cognito:username を完全一致・大文字小文字を区別して比較する。
      // ここを false にすると **プールのほうが緩くなる**ので揃える。
      signInCaseSensitive: true,

      // TOTP のみ。**SMS は使わない** — 有効にすると aws-cdk-lib が smsRole を
      // 自動生成し、IAM ロールが 1 個増える。
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true, email: false },

      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // 単一著者のプールを消すと、admin から入る手段がまるごと消える。
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.domain = this.userPool.addDomain('LoginDomain', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
      // 2 = 新しい Managed Login。1 は classic hosted UI。
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    this.userPoolClient = this.userPool.addClient('AdminClient', {
      // **public client。** SPA にクライアントシークレットは置けない。
      generateSecret: false,

      // **キーを 5 つ明示的に並べる。空オブジェクトにしてはいけない。**
      // 実測: aws-cdk-lib 2.267.0 の configureAuthFlows は
      //   if (!props.authFlows || Object.keys(props.authFlows).length === 0) return;
      // なので、`authFlows: {}` だと ExplicitAuthFlows が **描画されず**、
      // Cognito の寛容な既定（SRP / custom を含む）が効いてしまう。
      // キーが 1 つ以上あれば ALLOW_REFRESH_TOKEN_AUTH だけが描画される。
      authFlows: {
        userSrp: false,
        userPassword: false,
        adminUserPassword: false,
        custom: false,
        user: false,
      },

      oAuth: {
        // authorization code grant のみ。**implicit を明示的に false にする**
        // （既定は両方 true。implicit はトークンを URL フラグメントに載せる古い方式）。
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        // **openid だけ。** aws.cognito.signin.user.admin を含めると、
        // アクセストークンでユーザ属性を書き換えられるようになる。
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`${props.siteOrigin}/admin/`],
        logoutUrls: [`${props.siteOrigin}/admin/`],
      },

      // ユーザ名の存在有無を応答から推測させない。
      preventUserExistenceErrors: true,
      // サインアウト時にリフレッシュトークンを無効化できるようにする。
      enableTokenRevocation: true,

      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],

      idTokenValidity: Duration.minutes(60),
      accessTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(1),
    });

    // ---- 運用者と admin がここから値を拾う（物理値をコードに埋めない） ----

    new CfnOutput(this, 'AdminUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'aws cognito-idp admin-create-user --user-pool-id に渡す ID',
    });

    new CfnOutput(this, 'AdminUserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'admin の OAuth client_id',
    });

    new CfnOutput(this, 'AdminLoginDomain', {
      // **cloudFrontDomainName（deprecated）を呼ばないこと。** 呼ぶと AwsCustomResource が
      // 生まれ、Lambda・ManagedPolicyArns 付きロール・Resource:"*" のポリシーが
      // 3 つまとめて増える。Managed Login の URL はこの形で組める。
      value: Fn.join('', [
        'https://',
        props.domainPrefix,
        '.auth.',
        Stack.of(this).region,
        '.amazoncognito.com',
      ]),
      description: 'Managed Login のドメイン（admin のログイン先）',
    });

    new CfnOutput(this, 'AdminUserPoolIssuerUrl', {
      value: this.userPool.userPoolProviderUrl,
      description: 'ID トークンの iss。JWKS は <issuer>/.well-known/jwks.json',
    });
  }
}
