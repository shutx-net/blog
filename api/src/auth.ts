import { AUTH_MODE_DENY_ALL } from './config.ts';
import type { AuthMode } from './config.ts';
import type { ApiRequest } from './http.ts';

/** deny-all のときの唯一の拒否理由。Phase 3 から不変。 */
export const AUTH_NOT_CONFIGURED = 'auth-not-configured';

/**
 * **拒否理由の閉じた集合。**
 *
 * `string` にしない。文字列だと将来足した理由が既定の分岐に落ち、
 * 「知らない理由だからとりあえず通す／とりあえず 403」という事故が起きうる。
 * ここを増やすと `AUTH_FAILURE_RESPONSES` の型が不足を報告する。
 */
export const AUTH_FAILURE_REASONS = [
  AUTH_NOT_CONFIGURED,
  /** トークンが無い／スキームが違う。**検証器を 1 度も呼んでいない。** */
  'unauthenticated',
  /** トークンはあるが検証に落ちた（署名・iss・aud・token_use・exp・改竄）。 */
  'invalid-token',
  /** 検証は通ったが、この著者ではない。**単一著者プールの核心。** */
  'not-authorized',
  /** JWKS が取れないなど **サーバ側**の問題。資格情報の出し直しでは直らない。 */
  'unavailable',
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export type AuthResult =
  | { ok: true; subject: string }
  | { ok: false; reason: AuthFailureReason };

export interface Authorizer {
  authorize(request: ApiRequest): Promise<AuthResult>;
}

export interface AuthFailureResponse {
  /** **401 か 503 だけ。** 型でも 403 / 404 を書けないようにしてある。 */
  statusCode: 401 | 503;
  /** admin が理由を機械的に識別するためのコード。5 つとも相異なる。 */
  error: string;
}

/**
 * 拒否理由を HTTP に写す表。**403 と 404 は絶対に使わない。**
 *
 * ## なぜ 403 が使えないのか（実測に基づく）
 *
 * CloudFront の `CustomErrorResponses` は DistributionConfig 直下にあり、
 * **ビヘイビア単位では外せない**。origin が返した 403 / 404 も /404.html の
 * HTML に差し替えられる。実測（本番ディストリビューション）:
 *
 *     GET /api/nope   -> 404 / content-type: text/html / x-cache: Error from cloudfront
 *     GET /api/health -> 200 / content-type: application/json / x-cache: Miss from cloudfront
 *
 * Lambda のルータは `/api/nope` に `404 {"error":"not_found"}` を返しているのに、
 * 閲覧者には日本語の HTML ページが届く。403 も同じ表に載っているので同様に化ける。
 *
 * したがって認可失敗に 403 を使うと、admin からは「トークンを出し直せ」
 * 「あなたは別のユーザだ」「経路が無い」の 3 つが**全部同じ HTML 404** になる。
 *
 * `CustomErrorResponses` を外すと、OAC + S3 REST オリジンで存在しないキーが 403 の
 * まま閲覧者に見える（Phase 2 の判断）。**よって直すべきは CloudFront ではなく
 * API 側のステータス選択である。**
 *
 * ## なぜ 401 なのか
 *
 * 401 と 503 はどちらも `CustomErrorResponses` の表に無いので**素通しで JSON のまま
 * 届く**（実測で 503 が届くことは確認済み）。Phase 3 の router は「401 は資格情報を
 * 出し直せば通るという意味だが deny-all では通る資格情報が存在しない」という理由で
 * 503 を選んだ。**cognito モードではその前提が変わり、通る資格情報が実在する。**
 * よって 401 が正しくなる。deny-all の 503 はそのまま残す。
 *
 * `not-authorized`（正当なトークンだが別ユーザ）に 401 を使うのは意味論的には妥協で、
 * 本来は 403 である。**妥協する代わりに機械可読な `error` コードで区別できるようにした。**
 * **「素直に 403 にしよう」と直さないこと** — CloudFront に食われる。
 */
export const AUTH_FAILURE_RESPONSES: Readonly<Record<AuthFailureReason, AuthFailureResponse>> = {
  'auth-not-configured': { statusCode: 503, error: 'auth_not_configured' },
  unauthenticated: { statusCode: 401, error: 'unauthenticated' },
  'invalid-token': { statusCode: 401, error: 'invalid_token' },
  'not-authorized': { statusCode: 401, error: 'not_authorized' },
  unavailable: { statusCode: 503, error: 'auth_unavailable' },
};

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
