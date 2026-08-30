/**
 * **fail-closed の既定値。** エンドユーザ認証が壊れたときに戻す先。
 *
 * AWS_IAM + OAC はエンドユーザ認証ではない。OAC の SigningBehavior が always である以上、
 * CloudFront は到達したすべてのリクエストに SigV4 署名を付けて Lambda に渡す。
 * つまり誰が /api/posts に POST しても Lambda は起動する。AWS_IAM が防ぐのは
 * Function URL への直接アクセスだけ。**したがって書き込み経路を守っているのは
 * Authorizer だけである。**
 *
 * **deny-all を消さないこと。** 消すと「Cognito で問題が起きたときに安全側へ戻す」
 * 手段が無くなる。戻すのは環境変数 1 つの変更で済み、しかも deny-all は COGNITO_* を
 * 1 つも読まないので、**壊れた Cognito 設定を抱えたまま安全側に倒せる。**
 */
export const AUTH_MODE_DENY_ALL = 'deny-all';

/**
 * Cognito の ID トークンを検証するモード。
 *
 * **この文字列は infra 側（PostingApi の環境変数）と一致していなければならない。**
 * ずれると synth もテストも通ったうえでコールドスタートで落ちる。
 * infra/test/posting-api.test.ts がこの定数を import して等価を主張している。
 */
export const AUTH_MODE_COGNITO = 'cognito';

/** 許容値の全集合。テストは反例列挙ではなく**この集合との等価**で主張する。 */
export const ALLOWED_AUTH_MODES = [AUTH_MODE_DENY_ALL, AUTH_MODE_COGNITO] as const;

export type AuthMode = (typeof ALLOWED_AUTH_MODES)[number];

/**
 * **判別可能ユニオン。**
 *
 * `mode: 'cognito'` の値を作るには 3 つのフィールドを揃えるしかない。
 * 「AUTH_MODE=cognito なのに pool id が無い」という値は**型として存在し得ない**。
 * これが「中途半端な状態がデプロイできない」の 1 段目である
 * （2 段目は loadConfig のコールドスタート例外、3 段目は CDK 側の props）。
 */
export type AuthConfig =
  | { mode: typeof AUTH_MODE_DENY_ALL }
  | {
      mode: typeof AUTH_MODE_COGNITO;
      userPoolId: string;
      clientId: string;
      allowedUsername: string;
    };

export interface Config {
  auth: AuthConfig;
  /** JWT の iss。**秘密ではない**（秘密鍵が無ければ何もできない）。 */
  githubAppClientId: string;
  githubOwner: string;
  githubRepo: string;
  /** Secrets Manager の ARN か名前。CDK の CfnOutput から運用者が拾う。 */
  githubAppSecretId: string;
  mediaBucket: string;
  region: string;
}

/** モードによらず必須。 */
const REQUIRED = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_APP_SECRET_ID',
  'MEDIA_BUCKET',
  'AWS_REGION',
] as const;

/** **AUTH_MODE=cognito のときだけ**必須。deny-all では 1 つも読まない。 */
const REQUIRED_FOR_COGNITO = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_ALLOWED_USERNAME',
] as const;

type Env = Record<string, string | undefined>;

const require = (env: Env, name: (typeof REQUIRED)[number] | (typeof REQUIRED_FOR_COGNITO)[number]): string => {
  const value = env[name];
  // 値そのものを例外に載せない。設定値がログに出る書き癖を作らないため。
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
};

/**
 * AUTH_MODE を読む。**未知・空・未設定はすべて例外。**
 *
 * 大文字小文字も前後の空白も正規化しない。寛容にすると
 * 「意図した値」と「たまたま通った値」の区別が消える。
 */
const loadAuth = (env: Env): AuthConfig => {
  const mode = env['AUTH_MODE'];
  if (mode === undefined) throw new Error('AUTH_MODE is not set');
  if (!(ALLOWED_AUTH_MODES as readonly string[]).includes(mode)) {
    throw new Error(`AUTH_MODE must be one of: ${ALLOWED_AUTH_MODES.join(', ')}`);
  }

  if (mode === AUTH_MODE_COGNITO) {
    // **cognito を選んだ瞬間に 3 つが必須になる。** 欠けていればコールドスタートで
    // 落ち、CloudFront には 502 が返る。目に見えて壊れるほうが良い。
    return {
      mode: AUTH_MODE_COGNITO,
      userPoolId: require(env, 'COGNITO_USER_POOL_ID'),
      clientId: require(env, 'COGNITO_CLIENT_ID'),
      allowedUsername: require(env, 'COGNITO_ALLOWED_USERNAME'),
    };
  }

  return { mode: AUTH_MODE_DENY_ALL };
};

/**
 * 環境変数から設定を組み立てる。**不正なら投げる。**
 *
 * 投げるとコールドスタートで Lambda が落ち、CloudFront には 502 が返る。
 * 環境変数の打ち間違いが「黙って全許可」になるより、目に見えて壊れるほうが良い。
 */
export const loadConfig = (env: Env): Config => ({
  auth: loadAuth(env),
  githubAppClientId: require(env, 'GITHUB_APP_CLIENT_ID'),
  githubOwner: require(env, 'GITHUB_OWNER'),
  githubRepo: require(env, 'GITHUB_REPO'),
  githubAppSecretId: require(env, 'GITHUB_APP_SECRET_ID'),
  mediaBucket: require(env, 'MEDIA_BUCKET'),
  region: require(env, 'AWS_REGION'),
});
