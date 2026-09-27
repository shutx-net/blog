/**
 * Cognito の定数。**このファイルには値しか無い。**
 *
 * どれも秘密ではない。public client の ID は authorize URL に載って利用者のアドレスバーに
 * 出るし、Managed Login のドメインと issuer も公開の URL。**このリポジトリは public** なので
 * 秘密が要る設計ならそもそも採らない（AGENTS.md）。`client_secret` は存在しない —
 * `generateSecret: false` の public client で、`test/unit/auth-config.test.ts` が
 * 「secret に相当するキーが無い」ことを型と実行時の両方で固定している。
 *
 * # discovery ドキュメントを実行時に取りに行かない
 *
 * 実測で issuer 側の `/.well-known/openid-configuration` には
 * `code_challenge_methods_supported` が**無く**、`token_endpoint_auth_methods_supported` は
 * `["client_secret_basic","client_secret_post"]` だけで **`none` を載せていない**。
 * **どちらも実際には動く。** discovery で機能の有無を判断すると 2 箇所とも誤り、ログインの
 * たびに 1 往復増える。**エンドポイントは定数で持つ**（ずれたら気づけるように
 * `scripts/auth-smoke.ts` が discovery を読んで突き合わせる）。
 *
 * `redirect_uri` は定数に焼かず `resolveRedirectUri(origin)` で導出する。焼くと独自ドメイン
 * 移行で必ず忘れる。導出なら Cognito 側の許可リスト（`CallbackURLs`）が最終的な番人になる。
 */

export interface AuthConfig {
  /** public client の ID。**秘密ではない。** */
  readonly clientId: string;
  /** Managed Login のドメイン。**末尾スラッシュを付けない。** */
  readonly loginDomain: string;
  /** ID トークンの `iss`。**末尾スラッシュを付けない。** */
  readonly issuer: string;
  /** 要求するスコープ。実測で `openid` ちょうどでなければ `invalid_scope` になる。 */
  readonly scope: string;
  /** 管理画面のパス。`CallbackURLs` / `LogoutURLs` の実測値と揃っている。 */
  readonly adminPath: string;
}

/**
 * **入口は `/oauth2/authorize`。`/login` ではない。**
 * 実測で `/login` の直叩きは 403 を返す（本文はサインイン HTML なので誤読しやすい）。
 */
export const AUTHORIZE_PATH = '/oauth2/authorize';
export const TOKEN_PATH = '/oauth2/token';
/** `EnableTokenRevocation: true` なので使える（実測）。 */
export const REVOKE_PATH = '/oauth2/revoke';
export const LOGOUT_PATH = '/logout';

export const AUTH_CONFIG: AuthConfig = {
  clientId: '6idd147v3chsa6qhv6d02ao3ko',
  loginDomain: 'https://shutx-blog-admin.auth.ap-northeast-1.amazoncognito.com',
  issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_MhH4fmqkb',
  scope: 'openid',
  adminPath: '/admin/',
};

/**
 * `redirect_uri` / `logout_uri` をオリジンから導出する。
 *
 * `CallbackURLs` と `LogoutURLs` は実測で同値なので、導出を共有できる。
 * **1 文字でも違うと `redirect_mismatch` になる**（Cognito 自身の `/error` ページに
 * 飛ぶので、攻撃者の URL には飛ばない）。
 */
export const resolveRedirectUri = (origin: string): string =>
  new URL(AUTH_CONFIG.adminPath, origin).href;
