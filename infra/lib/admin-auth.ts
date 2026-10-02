import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * 管理画面のログイン用 Cognito ユーザプール（単一著者）。
 *
 * Stack ではなく Construct にしているのは、CallbackURLs が配信ドメインに依存するため
 * MediaBucket / PostingApi と構成をそろえるのが自然だから（CloudFront に紐づくものを
 * 別 Stack にすると DependencyCycle になる、という実測に揃える）。
 *
 * ## 入れていないもの（意図的）
 *
 * - **UserPoolGroup も IdentityPool も作らない。** 単一著者なので `cognito:username` の
 *   完全一致で足りる。ブラウザに AWS 資格情報を渡す設計は採らない（S3 への書き込みは
 *   API が発行する presigned PUT だけ）。
 * - カスタムドメインと ACM。Managed Login は `<prefix>.auth.<region>.amazoncognito.com` のまま。
 * - refresh token rotation。aws-cdk-lib 2.267.0 の `configureAuthFlows` は
 *   `props.refreshTokenRotationGracePeriod || authFlows.push('ALLOW_REFRESH_TOKEN_AUTH')` で、
 *   **rotation を有効にすると ExplicitAuthFlows から ALLOW_REFRESH_TOKEN_AUTH が消える**（実測）。
 * - Plus tier / threat protection。MAU 1 に月額を払う理由が無く、Plus には無料枠が無い
 *   （AWS 料金ページ:「There is no free tier for the Plus tier.」）。
 * - `advancedSecurityMode` は 1 文字も書かない。`undefined` を明示的に渡しても deprecation
 *   警告が出る（実測）ので、キーごと存在させない。
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

  /**
   * ログイン後の戻り先として許可するオリジン。**移行中は 2 本**
   * （`*.cloudfront.net` とカスタムドメイン）。
   *
   * `CallbackURLs` / `LogoutURLs` は**許可リストであって 1 値ではない**ので、
   * 証明書が付く前からカスタムドメインを入れておける（入れても
   * `*.cloudfront.net` からのログインは動き続ける）。admin 側は
   * `resolveRedirectUri(location.origin)` でオリジンを導出するので、ここに
   * 載っているオリジンから開けばそのまま通る。**載っていなければ Cognito が
   * `redirect_mismatch` を返す** — つまりここが最終的な番人である。
   *
   * 呼び出し側は site-stack.ts の `SITE_ORIGINS` 定数を渡すこと（メディアの
   * CORS `AllowedOrigins` と**同じ配列**を参照させる。別々に書くと
   * 「ログインはできるが画像が上がらない」という壊れ方をする）。
   */
  readonly siteOrigins: readonly string[];
}

export class AdminAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AdminAuthProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      // **ESSENTIALS。Lite ではない。** Managed Login は Essentials 以上でしか使えない
      // （AWS 開発者ガイド:「Managed login is available in the Essentials and Plus tiers.」）。
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

      // **キーを 5 つ明示的に並べる。空オブジェクトにしてはいけない。** 実測:
      // aws-cdk-lib 2.267.0 の configureAuthFlows は
      //   if (!props.authFlows || Object.keys(props.authFlows).length === 0) return;
      // なので `authFlows: {}` だと ExplicitAuthFlows が描画されず、Cognito の寛容な既定
      // （SRP / custom を含む）が効く。キーが 1 つ以上あれば ALLOW_REFRESH_TOKEN_AUTH だけが出る。
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
        // **許可リストの全件を並べる。** 順序は `SITE_ORIGINS` のまま（先頭が正のオリジン）。
        // hosted-UI ドメイン（`LoginDomain`）はこれに影響されない —
        // Managed Login は `<prefix>.auth.<region>.amazoncognito.com` のままである。
        callbackUrls: props.siteOrigins.map((origin) => `${origin}/admin/`),
        logoutUrls: props.siteOrigins.map((origin) => `${origin}/admin/`),
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

    // **ManagedLoginVersion 2 のドメインは、これが無いとログイン画面が出ない。**
    // 実測（2026-08-31）: ブランディング未作成で /oauth2/authorize を踏むと 403 と
    // "Login pages unavailable. Please contact an administrator." が返る。ユーザも OAuth 設定も
    // 正しいのに画面そのものが存在しない、という原因の見えにくい状態になる。
    //
    // AWS のドキュメントが明記している: 「When you use the console, Amazon Cognito assigns a
    // default branding style automatically. When you use the API or an SDK, you must create a
    // branding style yourself.」**コンソールなら付いていたものが、CDK で作ったので付かなかった。**
    //
    // useCognitoProvidedValues: true は既定スタイルを使う指定。見た目を変えたくなったら
    // settings / assets を足す（2MB 上限あり）。
    new cognito.CfnManagedLoginBranding(this, 'AdminLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
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
