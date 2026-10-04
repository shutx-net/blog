import { AUTH_MODE_COGNITO, AUTH_MODE_DENY_ALL } from './config.ts';
import type { AuthConfig } from './config.ts';
import { createCognitoAuthorizer } from './auth/cognito.ts';
import type { TokenVerifier } from './auth/cognito.ts';
import type { Logger } from './deps.ts';
import type { ApiRequest } from './http.ts';

/** deny-all のときの唯一の拒否理由。 */
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
 * CloudFront の `CustomErrorResponses` は DistributionConfig 直下にあり**ビヘイビア単位では
 * 外せない**ので、origin が返した 403 / 404 も /404.html の HTML に差し替えられる。403 を
 * 使うと admin からは「トークンを出し直せ」「あなたは別のユーザだ」「経路が無い」が
 * **全部同じ HTML 404** になる。実測と全文は `infra/docs/api-auth.md` の
 * 「認証の拒否に 403 と 404 を使わない」。
 *
 * 401 と 503 はこの表に無いので**素通しで JSON のまま届く**。deny-all が 503 なのは
 * 「401 は資格情報を出し直せば通るという意味だが、通る資格情報が存在しない」から。
 * **cognito モードではその前提が変わり、通る資格情報が実在する**ので 401 にする。
 *
 * `not-authorized`（正当なトークンだが別ユーザ）に 401 を使うのは意味論的には妥協で本来は
 * 403。代わりに機械可読な `error` コードで区別できるようにした。
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

export interface AuthorizerDeps {
  logger: Logger;
  /** cognito モードで注入する verifier。省略時は cognito.ts が本物を作る。 */
  verifier?: TokenVerifier;
}

/**
 * **網羅性をコンパイラに見張らせるための番人。**
 *
 * `AuthConfig` に新しい mode を足したのに分岐を書き忘れると、default 節に届く型が
 * `never` にならないので **型検査が落ちる**。ランタイムでも throw して二重化する。
 * `erasableSyntaxOnly: true` なので enum は使えず、この形で書く。
 */
const exhaustive = (_auth: never): never => {
  throw new Error('AUTH_MODE has no authorizer implementation');
};

/**
 * 設定から Authorizer を組み立てる。
 *
 * **判別可能ユニオンを受け取るのが要点。** 「cognito なのに pool id が無い」という
 * 引数は型として作れないので、この関数の中で欠損を気にする必要が無い。
 */
export const createAuthorizer = (auth: AuthConfig, deps: AuthorizerDeps): Authorizer => {
  switch (auth.mode) {
    case AUTH_MODE_DENY_ALL:
      return denyAllAuthorizer;
    case AUTH_MODE_COGNITO:
      return createCognitoAuthorizer({
        userPoolId: auth.userPoolId,
        clientId: auth.clientId,
        allowedUsername: auth.allowedUsername,
        ...(deps.verifier === undefined ? {} : { verifier: deps.verifier }),
        logger: deps.logger,
      });
    default:
      return exhaustive(auth);
  }
};
