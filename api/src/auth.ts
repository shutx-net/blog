import { AUTH_MODE_DENY_ALL } from './config.ts';
import type { AuthMode } from './config.ts';
import type { ApiRequest } from './http.ts';

export type AuthResult = { ok: true; subject: string } | { ok: false; reason: string };

export interface Authorizer {
  authorize(request: ApiRequest): Promise<AuthResult>;
}

/** ルータが 503 にマップする唯一の拒否理由。それ以外の拒否は 403 になる。 */
export const AUTH_NOT_CONFIGURED = 'auth-not-configured';

/**
 * 常に拒否する Authorizer。
 *
 * **リクエストを一切見ない。** ヘッダや Cookie を見て「それらしければ通す」抜け道を
 * 作らないため、引数を参照しないことに意味がある。
 */
export const denyAllAuthorizer: Authorizer = {
  authorize: async (): Promise<AuthResult> => ({ ok: false, reason: AUTH_NOT_CONFIGURED }),
};

export const createAuthorizer = (mode: AuthMode): Authorizer => {
  if (mode === AUTH_MODE_DENY_ALL) return denyAllAuthorizer;
  // loadConfig が先に弾くので通常ここには来ないが、Authorizer を増やしたときに
  // 対応を書き忘れたまま「既定で通す」ことにならないよう、ここでも閉じる。
  throw new Error('AUTH_MODE has no authorizer implementation');
};
