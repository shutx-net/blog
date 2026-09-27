import type { SessionStore } from '../storage/session-store.ts';
import type { ExpectedIssuer } from './claims.ts';
import { AUTH_CONFIG } from './config.ts';
import type { AuthConfig } from './config.ts';
import { clearSession, loadSession, saveSession } from './session-state.ts';
import type { StoredSession } from './session-state.ts';
import { NETWORK_ERROR, refreshTokens } from './token-endpoint.ts';

/**
 * ID トークンの供給。**タイマーを使わず、必要になった瞬間に期限を見る。**
 *
 * タイマーで予約しないのは (a) タブを一晩開くと無意味に発火し続ける (b) スリープ復帰で
 * ずれる (c) テストが時計依存になる（`bind.ts` がデバウンスを避けたのと同じ理由）から。
 * `currentIdToken()` が呼ばれた瞬間に期限を見る。`AuthTransport.authHeaders()` が
 * `Promise` を返す設計は、まさにこれができるように作られている。
 *
 * skew は 120 秒。ID トークンは 60 分なので実質「残り 2 分を切ったら先に更新する」。
 * api 側の検証器も多少の猶予を持つが**それに頼らない** — 401 を受けてから直すのではなく前に直す。
 *
 * refresh トークンは不透明文字列で `exp` を持たず、24 時間はクライアント設定であって
 * トークンからは読めない。**失効は `invalid_grant` を受け取って初めて分かる**ので、
 * 「あと何時間使えるか」を UI に出すことはできない（出すと嘘になる）。
 *
 * # invalid_grant とネットワーク失敗で扱いを変える
 *
 *   `invalid_grant` … 再ログインしかない -> **セッションを捨てる**
 *   ネットワーク    … あとでまた試せる   -> **セッションを保つ**
 *
 * 一緒くたにすると、地下鉄で電波が切れただけでセッションが消える。
 *
 * # 画面遷移を持たない
 *
 * 失効を検知しても自動リダイレクトしない。編集中に飛ばされると書きかけが失われる。
 * 遷移する手段をそもそも持たないことで構造的に保証し、`test/unit/auth-refresh.test.ts`
 * が綴りの走査で固定している。
 */

/** 期限の何ミリ秒前から先回りして更新するか。 */
export const DEFAULT_SKEW_MS = 120_000;

/** 残り時間が skew 以下なら更新する。**境界（ちょうど skew）は更新する側に倒す。** */
export const needsRefresh = (
  session: StoredSession,
  nowMs: number,
  skewMs: number,
): boolean => session.expiresAtMs - nowMs <= skewMs;

export interface TokenSourceDeps {
  store: SessionStore;
  /** 注入するクロック。**このモジュールで現在時刻を直接読まない。** */
  now(): number;
  fetchImpl?: typeof fetch;
  skewMs?: number;
  config?: AuthConfig;
  expected?: ExpectedIssuer;
}

export interface TokenSource {
  /**
   * いま送ってよい ID トークン。無ければ `undefined`。
   *
   * 期限が近ければここでリフレッシュする。**同時に何本呼ばれても
   * リフレッシュは 1 回だけ**（in-flight promise を共有する）。
   */
  currentIdToken(): Promise<string | undefined>;
  /** 画面の出し分け用。**認可の判断には使わない**（判断は必ずサーバ側）。 */
  isAuthenticated(): boolean;
}

export const createTokenSource = (deps: TokenSourceDeps): TokenSource => {
  const config = deps.config ?? AUTH_CONFIG;
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
  const expected: ExpectedIssuer = deps.expected ?? {
    clientId: config.clientId,
    issuer: config.issuer,
  };

  /**
   * **クロージャに持つ。モジュールスコープに置かない。**
   * `finally` で必ず `undefined` に戻す — 戻し忘れると**失敗した 1 回が
   * 永久にキャッシュされる。**
   */
  let inFlight: Promise<string | undefined> | undefined;

  const doRefresh = async (session: StoredSession): Promise<string | undefined> => {
    if (session.refreshToken === undefined) {
      // 更新する手段が無い。持ち続けても 401 になるだけなので捨てる。
      clearSession(deps.store);
      return undefined;
    }

    const result = await refreshTokens(
      { refreshToken: session.refreshToken, config },
      deps.fetchImpl,
    );

    if (!result.ok) {
      // **一時的な障害でセッションを捨てない。** あとでまた試せる。
      if (result.error === NETWORK_ERROR) return undefined;
      clearSession(deps.store);
      return undefined;
    }

    // 応答のトークンも健全性チェックを通す。想定外なら保存せず捨てる。
    const saved = saveSession(deps.store, result, expected, session);
    if (saved === undefined) {
      clearSession(deps.store);
      return undefined;
    }
    return saved.idToken;
  };

  return {
    currentIdToken: async (): Promise<string | undefined> => {
      const session = loadSession(deps.store);
      // セッションが無いなら呼びに行かない。**これが 401 ループの構造的な不成立。**
      if (session === undefined) return undefined;
      if (!needsRefresh(session, deps.now(), skewMs)) return session.idToken;

      inFlight ??= doRefresh(session).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    isAuthenticated: (): boolean => loadSession(deps.store) !== undefined,
  };
};
