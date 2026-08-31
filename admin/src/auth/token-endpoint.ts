import { AUTH_CONFIG, REVOKE_PATH, TOKEN_PATH } from './config.ts';
import type { AuthConfig } from './config.ts';

/**
 * 認可サーバのトークンエンドポイント。**素の fetch の 3 本目。**
 *
 * # 3 本の規則はそれぞれ違う（取り違えないこと）
 *
 *   api/client.ts        … 同一オリジンの `/api/*`。**api 用のハッシュヘッダを必ず付ける。** JSON。
 *   api/upload.ts        … S3 への presigned PUT。**逆に絶対に付けない。**
 *   このファイル          … **別オリジン**の認可サーバ。**どちらのヘッダも付けない。**
 *                          `content-type: application/x-www-form-urlencoded` 1 個だけ、
 *                          `credentials: 'omit'`。
 *
 * `test/unit/no-raw-fetch.test.ts` がこの 3 本目の規則を綴りの走査で固定している。
 *
 * # 例外を投げない設計にする理由
 *
 * この層の失敗は 3 種類しかなく、呼び出し側は必ず分岐する。
 *
 *   `invalid_grant` … **再ログインしかない**（refresh トークンの失効・code の再使用）
 *   `network`       … 一時的。**あとでまた試せる**。セッションを捨ててはいけない
 *   それ以外        … 設定ミス
 *
 * 例外にすると、この分岐が `error.message` の文字列一致になる。
 * **`aws-jwt-verify` の `this.name` で踏んだのと同じ轍**（テストでは通り本番でだけ壊れる）
 * を繰り返さないため、結果を値で返す。
 *
 * # ログを持たない
 *
 * `api/src/auth/transport.ts` がログ出力を受け取らない設計にした理由と同じで、
 * このモジュールもログ出力を引数に取らず、標準出力にも触らない。
 * **トークンをログに出す経路が構造的に存在しない。**
 * `test/unit/auth-token-endpoint.test.ts` が綴りの走査で固定している。
 *
 * # CORS は防御ではない
 *
 * 実測で認可サーバは preflight の `Origin` を検証せず、任意のオリジンをそのまま
 * `access-control-allow-origin` に反映する（`allow-credentials: true` 付き）。
 * **守っているのは PKCE と `state` だけである。**
 * 「CORS があるから安全」という推論をこのファイルに書かないこと。
 */

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** JSON として読めない応答（HTML のエラーページなど）。`api/client.ts` と同じ思想。 */
export const NON_JSON_RESPONSE = 'non_json_response';
/** fetch そのものが失敗した。**セッションを捨てる理由にはならない。** */
export const NETWORK_ERROR = 'network';
/** 2xx だが ID トークンが入っていない。**成功として扱わない。** */
export const MISSING_ID_TOKEN = 'missing_id_token';

export interface TokenSuccess {
  ok: true;
  idToken: string;
  /**
   * 応答に含まれていれば。
   *
   * **リフレッシュの応答には含まれない**（Cognito は既定でローテートしない）ので、
   * 呼び出し側は `undefined` を既存の値で上書き保存しないこと。
   */
  refreshToken: string | undefined;
}

export interface TokenFailure {
  ok: false;
  /** 認可サーバが返した `error`、または上の 3 定数のいずれか。 */
  error: string;
}

export type TokenResult = TokenSuccess | TokenFailure;

const defaultFetch = (): typeof fetch => globalThis.fetch.bind(globalThis);

interface RawResponse {
  ok: boolean;
  payload: Record<string, unknown> | undefined;
  parsed: boolean;
}

/**
 * form encoded の POST を 1 本。**この関数だけが fetch に触る。**
 *
 * ネットワーク例外は `undefined` に潰す（呼び出し側が `network` に写す）。
 */
const postForm = async (
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<RawResponse | undefined> => {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      // **ちょうど 1 個。** 実測で preflight の allow-headers は content-type。
      headers: { 'content-type': FORM_CONTENT_TYPE },
      // 実測で応答は Set-Cookie: XSRF-TOKEN=... を返す。送る必要も受け取る必要も無い。
      credentials: 'omit',
      body,
    });

    const text = await response.text();
    if (text.length === 0) return { ok: response.ok, payload: undefined, parsed: true };

    try {
      const parsed: unknown = JSON.parse(text);
      const payload =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      return { ok: response.ok, payload, parsed: payload !== undefined };
    } catch {
      return { ok: response.ok, payload: undefined, parsed: false };
    }
  } catch {
    return undefined;
  }
};

/** 生の応答を `TokenResult` に写す。 */
const toTokenResult = (raw: RawResponse | undefined): TokenResult => {
  if (raw === undefined) return { ok: false, error: NETWORK_ERROR };
  if (!raw.parsed || raw.payload === undefined) return { ok: false, error: NON_JSON_RESPONSE };

  if (!raw.ok) {
    const error = raw.payload['error'];
    return { ok: false, error: typeof error === 'string' ? error : NON_JSON_RESPONSE };
  }

  const idToken = raw.payload['id_token'];
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { ok: false, error: MISSING_ID_TOKEN };
  }

  const refreshToken = raw.payload['refresh_token'];
  return {
    ok: true,
    idToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : undefined,
  };
};

export interface ExchangeCodeArgs {
  code: string;
  /** PKCE の code_verifier。`pending-login.ts` が単回使用で取り出したもの。 */
  verifier: string;
  /** authorize に渡したものと**同じ値**でなければならない。 */
  redirectUri: string;
  config?: AuthConfig;
}

/**
 * 認可コードをトークンに交換する。
 *
 * **`client_secret` を送らない。** public client であり、実測で secret 無しでも
 * `invalid_client` にはならない（不正な code に対して `invalid_grant` が返る）。
 */
export const exchangeCode = async (
  args: ExchangeCodeArgs,
  fetchImpl: typeof fetch = defaultFetch(),
): Promise<TokenResult> => {
  const config = args.config ?? AUTH_CONFIG;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri,
  });
  return toTokenResult(await postForm(`${config.loginDomain}${TOKEN_PATH}`, body, fetchImpl));
};

export interface RefreshTokensArgs {
  refreshToken: string;
  config?: AuthConfig;
}

/**
 * refresh トークンで ID トークンを取り直す。
 *
 * **`redirect_uri` も `code_verifier` も送らない**（この grant では不要）。
 * 失効の合図は `invalid_grant` ただ 1 つで、それ以外の失敗と扱いを変えるのは
 * 呼び出し側（`refresh.ts`）の責任。
 */
export const refreshTokens = async (
  args: RefreshTokensArgs,
  fetchImpl: typeof fetch = defaultFetch(),
): Promise<TokenResult> => {
  const config = args.config ?? AUTH_CONFIG;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: args.refreshToken,
  });
  return toTokenResult(await postForm(`${config.loginDomain}${TOKEN_PATH}`, body, fetchImpl));
};

export interface RevokeArgs {
  refreshToken: string;
  config?: AuthConfig;
}

/**
 * refresh トークンを失効させる（RFC 7009）。
 *
 * **戻り値を持たない。** 実測で存在しないトークンにも 200 が返る（トークンの有無を
 * 漏らさないための正しい挙動）ので、**成否からセッションの状態を推測できない。**
 * 呼び出し側が分岐できる値を返すと、必ず誰かが分岐する。
 *
 * **失敗しても投げない。** ローカルのサインアウトが認可サーバの都合で止まってはいけない。
 */
export const revokeRefreshToken = async (
  args: RevokeArgs,
  fetchImpl: typeof fetch = defaultFetch(),
): Promise<void> => {
  const config = args.config ?? AUTH_CONFIG;
  const body = new URLSearchParams({
    client_id: config.clientId,
    token: args.refreshToken,
  });
  await postForm(`${config.loginDomain}${REVOKE_PATH}`, body, fetchImpl);
};
