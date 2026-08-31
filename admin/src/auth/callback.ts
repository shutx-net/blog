import type { SessionStore } from '../storage/session-store.ts';
import type { ExpectedIssuer } from './claims.ts';
import { AUTH_CONFIG } from './config.ts';
import { clearPendingLogin, consumePendingLogin } from './pending-login.ts';
import type { ConsumeFailureReason } from './pending-login.ts';
import { saveSession } from './session-state.ts';
import type { TokenResult } from './token-endpoint.ts';

/**
 * `/admin/?code=...` で戻ってきたときの処理。**攻撃 6 種をここで全部落とす。**
 *
 * # 判定の順序（上から順に、1 つでも当たったらそこで終わる）
 *
 *   1. `code` も `error` も無い      -> `no_callback`。**副作用ゼロ**（URL も触らない）
 *   2. **URL から認可のパラメータを消す**（交換の前。理由は下）
 *   3. `error` がある                -> pending を削除して終了。**`code` を見ない**
 *   4. `state` が無い / 空            -> `state_missing`。**`code` があっても交換しない**
 *   5. `consumePendingLogin` が失敗   -> その理由で終了
 *   6. ここで初めて `exchange` を呼ぶ
 *   7. 応答の ID トークンを健全性チェックに通す。落ちたら保存しない
 *   8. 成功時のみセッションを保存
 *
 * # なぜ URL の掃除が「交換の前」なのか
 *
 * 交換はネットワーク往復なので、その間にユーザがリロードすると `?code=` が再送される。
 * **先に URL から消しておくと、リロードは「code 無しの通常訪問」になって二重交換が
 * 起きない。** 成功時も失敗時も消すのは、ブラウザ履歴と `Referer` に `code` を
 * 残さないため。
 *
 * # 現在 URL を直接読み書きしない
 *
 * クエリ文字列は引数で受け取り、掃除後のクエリ文字列は関数で返す。理由は 2 つ。
 *   (a) jsdom でブラウザのアドレスオブジェクトを差し替えられるかは環境依存である。
 *       vitest の jsdom では `configurable: true` だが、**素の jsdom 30.0.1 では
 *       `configurable: false` で `defineProperty` も `delete` も TypeError になる**（実測）。
 *       **環境の実装差に依存したテストは書かない。**
 *   (b) 引数で受ければ node 環境の unit テストでも大半を検証できる。
 *
 * **遷移する手段をそもそも持たない。** 処理は同一ページ内で完結し、
 * `test/unit/auth-callback.test.ts` が綴りの走査でそれを固定している。
 */

/** 認可の往復で URL に載るパラメータ。**すべて消す。** */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri'];

export type CallbackFailureReason =
  | ConsumeFailureReason
  /** 交換そのものが失敗した（`error` に token エンドポイントのコードが入る）。 */
  | 'exchange_failed'
  /** 交換は成功したが、返ってきた ID トークンが想定と違う。 */
  | 'unacceptable_token';

export type CallbackResult =
  /** `/admin/` を普通に開いただけ。**何も起きない。** */
  | { kind: 'no_callback' }
  | { kind: 'signed_in'; returnTo: string }
  /**
   * 認可サーバがエラーを返した。
   *
   * **`description` は認可サーバが返す任意文字列である。** DOM に入れるときは必ず
   * `textContent`（`innerHTML` に入れると、生 HTML を通すこのアプリではそのまま XSS）。
   */
  | { kind: 'provider_error'; error: string; description: string | undefined }
  | { kind: 'failed'; reason: CallbackFailureReason; error?: string };

export interface HandleCallbackDeps {
  /** ブラウザのアドレス欄のクエリ文字列。**現在 URL をこのモジュールで読まない。** */
  search: string;
  store: SessionStore;
  now(): number;
  /** authorize に渡したものと同じ値。 */
  redirectUri: string;
  /**
   * 認可のパラメータを取り除いた**クエリ文字列**を受け取る（`''` か `'?a=1'`）。
   *
   * パス名を知らないのでフル URL は作れない。組み立ては `main.ts` の仕事で、
   * **ブラウザのアドレス情報と履歴 API に触るのはそこだけ**である。
   */
  replaceSearch(search: string): void;
  /** トークン交換。`token-endpoint.ts` の `exchangeCode` を刺す。 */
  exchange(args: { code: string; verifier: string; redirectUri: string }): Promise<TokenResult>;
  expected?: ExpectedIssuer;
}

/** 認可のパラメータだけを落としたクエリ文字列を作る。他のクエリは残す。 */
const withoutCallbackParams = (params: URLSearchParams): string => {
  const remaining = new URLSearchParams(params);
  for (const name of CALLBACK_PARAMS) remaining.delete(name);
  const text = remaining.toString();
  return text.length === 0 ? '' : `?${text}`;
};

export const handleCallback = async (deps: HandleCallbackDeps): Promise<CallbackResult> => {
  const params = new URLSearchParams(deps.search);
  const error = params.get('error');
  const code = params.get('code');
  const state = params.get('state');

  // **普通に開いただけでは何も起きない。** URL も pending レコードも触らない。
  if (error === null && code === null) return { kind: 'no_callback' };

  // **交換の前に消す。** リロードによる二重交換と、履歴 / Referer への残留を同時に防ぐ。
  deps.replaceSearch(withoutCallbackParams(params));

  if (error !== null) {
    // **`code` を見ない。** エラーが返っているのだから、そこにある code は信用しない。
    clearPendingLogin(deps.store);
    return { kind: 'provider_error', error, description: params.get('error_description') ?? undefined };
  }

  if (state === null || state.length === 0) {
    // **code があっても交換しない。** state 無しの callback は検証できない。
    return { kind: 'failed', reason: 'state_missing' };
  }

  const pending = consumePendingLogin(deps.store, state, deps.now);
  if (!pending.ok) return { kind: 'failed', reason: pending.reason };

  // ここまで来て初めてネットワークに出る。攻撃 2〜4・6 はすべてこの手前で終わる。
  const tokens = await deps.exchange({
    code: code as string,
    verifier: pending.verifier,
    redirectUri: deps.redirectUri,
  });
  if (!tokens.ok) return { kind: 'failed', reason: 'exchange_failed', error: tokens.error };

  const expected: ExpectedIssuer = deps.expected ?? {
    clientId: AUTH_CONFIG.clientId,
    issuer: AUTH_CONFIG.issuer,
  };
  if (saveSession(deps.store, tokens, expected) === undefined) {
    return { kind: 'failed', reason: 'unacceptable_token' };
  }

  return { kind: 'signed_in', returnTo: pending.returnTo };
};
