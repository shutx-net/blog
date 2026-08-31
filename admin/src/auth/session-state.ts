import type { SessionStore } from '../storage/session-store.ts';
import { isAcceptable, readIdTokenClaims } from './claims.ts';
import type { ExpectedIssuer } from './claims.ts';
import type { TokenSuccess } from './token-endpoint.ts';

/**
 * 保存するセッションの形と、その読み書き。
 *
 * **保存先の選択の根拠は `THREAT-MODEL.md`。** ここは「何を保存するか」だけを決める。
 * どこに保存するかは `storage/session-store.ts` が持っており、Web Storage の綴りは
 * あちら 1 本にしか現れない（`test/unit/auth-seam.test.ts` の走査規則 1）。
 */

/** store の中でのキー。 */
export const SESSION_KEY = 'session';

export interface StoredSession {
  /** api に送る ID トークン。**access トークンは保存しない**（送る先が無い）。 */
  idToken: string;
  /**
   * refresh トークン。
   *
   * **寿命はクライアントから観測できない。** 不透明文字列で `exp` を持たないので、
   * 24 時間という設定値はトークン自体からは読めない。**失効は `invalid_grant` を
   * 受け取って初めて分かる。**
   */
  refreshToken: string | undefined;
  /**
   * ID トークンの期限（ミリ秒）。
   *
   * **応答の `expires_in` からではなく、ID トークンの `exp` から作る。**
   * `expires_in` は「発行からの秒数」なので、応答を受け取るまでの往復と時計のずれが
   * そのまま誤差になる。`exp` は絶対時刻なのでずれない。
   */
  expiresAtMs: number;
}

const isStoredSession = (value: unknown): value is StoredSession =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as StoredSession).idToken === 'string' &&
  (value as StoredSession).idToken.length > 0 &&
  typeof (value as StoredSession).expiresAtMs === 'number' &&
  Number.isFinite((value as StoredSession).expiresAtMs);

/**
 * トークン応答をセッションとして保存する。
 *
 * **`isAcceptable` を通らないトークンは保存しない**（`aud` / `iss` / `token_use` 違い、
 * `exp` が読めないもの）。保存しなかったときは `undefined` を返す。
 *
 * @param previous 直前のセッション。**応答に `refresh_token` が無ければここから引き継ぐ。**
 *   Cognito は既定でローテートしないのでリフレッシュの応答には含まれず、
 *   `undefined` で上書きすると**次のリフレッシュができなくなる。**
 */
export const saveSession = (
  store: SessionStore,
  tokens: TokenSuccess,
  expected: ExpectedIssuer,
  previous?: StoredSession,
): StoredSession | undefined => {
  const claims = readIdTokenClaims(tokens.idToken);
  if (claims === undefined || !isAcceptable(claims, expected)) return undefined;

  const session: StoredSession = {
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken ?? previous?.refreshToken,
    expiresAtMs: claims.expiresAtMs,
  };

  store.set(SESSION_KEY, session);
  return session;
};

/**
 * 保存済みのセッションを読む。
 *
 * **投げない。** 壊れたレコード・版違い・空 store はすべて `undefined`
 * （版の吸収は `storage/session-store.ts` が行っている）。
 */
export const loadSession = (store: SessionStore): StoredSession | undefined => {
  const record = store.get<unknown>(SESSION_KEY);
  return isStoredSession(record) ? record : undefined;
};

/** セッションを消す。サインアウトと、失効を検知したときに呼ぶ。 */
export const clearSession = (store: SessionStore): void => {
  store.remove(SESSION_KEY);
};
