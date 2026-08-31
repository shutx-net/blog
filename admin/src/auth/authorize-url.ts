import { AUTHORIZE_PATH, LOGOUT_PATH } from './config.ts';
import type { AuthConfig } from './config.ts';

/**
 * 認可要求 URL とサインアウト URL の組み立て。
 *
 * **`URLSearchParams` で組む。手で `&` を連結しない** — エスケープの取りこぼしが起きる。
 *
 * # ここが `state` と PKCE の最後の砦である
 *
 * 実測で認可サーバは `state` の無い authorize も、`code_challenge` の無い authorize も
 * **302 する**。つまり片方を落としても**サーバは何も言わずに動き続ける。**
 * だから空の値に対して**投げる**。サーバが許すことを、こちら側で禁じている。
 *
 * # S256 以外を生成しない
 *
 * `code_challenge_method` は `'S256'` のリテラル 1 つだけで、分岐が無い。
 * `test/unit/auth-authorize-url.test.ts` が「このファイルに `plain` の綴りが現れない」
 * ことまで見ている。
 */

/** 空・空白だけを拒否する。**黙って落とさない。** */
const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`authorize-url: ${name} は必須（空のまま認可要求を飛ばさない）`);
  }
  return value;
};

export interface BuildAuthorizeUrlArgs {
  config: AuthConfig;
  /** CSRF トークン。`pending-login.ts` が作って保存したもの。 */
  state: string;
  /** PKCE の code_challenge（S256）。 */
  challenge: string;
  /** `resolveRedirectUri(origin)` の値。 */
  redirectUri: string;
}

export const buildAuthorizeUrl = (args: BuildAuthorizeUrlArgs): string => {
  const state = required(args.state, 'state');
  const challenge = required(args.challenge, 'challenge');
  const redirectUri = required(args.redirectUri, 'redirectUri');

  const url = new URL(`${args.config.loginDomain}${AUTHORIZE_PATH}`);
  url.search = new URLSearchParams({
    client_id: args.config.clientId,
    // 実測でこのクライアントの implicit は unauthorized_client になる。
    response_type: 'code',
    scope: args.config.scope,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  return url.href;
};

export interface BuildLogoutUrlArgs {
  config: AuthConfig;
  /** `LogoutURLs` に登録された値。`resolveRedirectUri(origin)` と同じもの。 */
  logoutUri: string;
}

/**
 * サインアウトの遷移先。
 *
 * 実測でこの形は **302 でそのまま `/admin/` に返る**。`logout_uri` が許可外だと
 * `/login` に落ちるだけで、**攻撃者の URL には飛ばない。**
 */
export const buildLogoutUrl = (args: BuildLogoutUrlArgs): string => {
  const logoutUri = required(args.logoutUri, 'logoutUri');
  const url = new URL(`${args.config.loginDomain}${LOGOUT_PATH}`);
  url.search = new URLSearchParams({
    client_id: args.config.clientId,
    logout_uri: logoutUri,
  }).toString();
  return url.href;
};
