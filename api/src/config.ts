/**
 * **本フェーズで唯一許容する AUTH_MODE。**
 *
 * AWS_IAM + OAC はエンドユーザ認証ではない。OAC の SigningBehavior が always である以上、
 * CloudFront は到達したすべてのリクエストに SigV4 署名を付けて Lambda に渡す。
 * つまり誰が /api/posts に POST しても Lambda は起動する。AWS_IAM が防ぐのは
 * Function URL への直接アクセスだけ。したがってエンドユーザ認証（Cognito）が入るまでは
 * 書き込み経路を **到達不能**にしておく必要がある。
 *
 * Cognito フェーズがやることは Authorizer を 1 つ足して許容値を増やすことだけで、
 * その変更と Cognito の実装は **同一 PR でなければならない**。
 */
export const AUTH_MODE_DENY_ALL = 'deny-all';

export type AuthMode = typeof AUTH_MODE_DENY_ALL;

const ALLOWED_AUTH_MODES: readonly string[] = [AUTH_MODE_DENY_ALL];

export interface Config {
  authMode: AuthMode;
  /** JWT の iss。**秘密ではない**（秘密鍵が無ければ何もできない）。 */
  githubAppClientId: string;
  githubOwner: string;
  githubRepo: string;
  /** Secrets Manager の ARN か名前。CDK の CfnOutput から運用者が拾う。 */
  githubAppSecretId: string;
  mediaBucket: string;
  region: string;
}

const REQUIRED = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_APP_SECRET_ID',
  'MEDIA_BUCKET',
  'AWS_REGION',
] as const;

type Env = Record<string, string | undefined>;

const require = (env: Env, name: (typeof REQUIRED)[number]): string => {
  const value = env[name];
  // 値そのものを例外に載せない。設定値がログに出る書き癖を作らないため。
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
};

/**
 * 環境変数から設定を組み立てる。**不正なら投げる。**
 *
 * 投げるとコールドスタートで Lambda が落ち、CloudFront には 502 が返る。
 * 環境変数の打ち間違いが「黙って全許可」になるより、目に見えて壊れるほうが良い。
 */
export const loadConfig = (env: Env): Config => {
  const authMode = env['AUTH_MODE'];
  if (authMode === undefined) throw new Error('AUTH_MODE is not set');
  // 大文字小文字も前後の空白も正規化しない。許容値は 1 つだけなので完全一致で足りる。
  // 寛容にすると「意図した値」と「たまたま通った値」の区別が消える。
  if (!ALLOWED_AUTH_MODES.includes(authMode)) {
    throw new Error(`AUTH_MODE must be one of: ${ALLOWED_AUTH_MODES.join(', ')}`);
  }

  return {
    authMode: authMode as AuthMode,
    githubAppClientId: require(env, 'GITHUB_APP_CLIENT_ID'),
    githubOwner: require(env, 'GITHUB_OWNER'),
    githubRepo: require(env, 'GITHUB_REPO'),
    githubAppSecretId: require(env, 'GITHUB_APP_SECRET_ID'),
    mediaBucket: require(env, 'MEDIA_BUCKET'),
    region: require(env, 'AWS_REGION'),
  };
};
