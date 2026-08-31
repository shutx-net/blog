import type { SessionStore } from '../storage/session-store.ts';
import { buildLogoutUrl } from './authorize-url.ts';
import { AUTH_CONFIG, resolveRedirectUri } from './config.ts';
import type { AuthConfig } from './config.ts';
import { clearPendingLogin } from './pending-login.ts';
import { clearSession, loadSession } from './session-state.ts';
import { revokeRefreshToken } from './token-endpoint.ts';

/**
 * サインアウト。**順序がそのまま要件である。**
 *
 *   (1) refresh トークンを読む
 *   (2) `revoke` を **await**（失敗は握り潰して続行）
 *   (3) セッションと pending login を store から**削除**
 *   (4) `redirect` で認可サーバの `/logout` へ
 *
 * # (2) を待つ理由
 *
 * 待たずにリダイレクトすると、遷移でページが破棄されて revoke の通信が中断されうる。
 * **待って失敗しても続行する**ので、待つことの代償は数百ミリ秒だけである。
 *
 * # (3) を (4) より先に置く理由
 *
 * **逆順にすると遷移後に (3) が走らない。** ブラウザは遷移を始めた時点で
 * このページのスクリプトを止めるので、「リダイレクトしてから消す」実装は必ず取りこぼす。
 * `test/unit/auth-signout.test.ts` は偽 `redirect` の中から store を覗くことで、
 * **順序ではなく観測で**これを固定している。
 *
 * # ID トークンではなく refresh トークンを失効させる
 *
 * ID トークンは 60 分で自然に切れるが、**refresh トークンは 24 時間生き残る。**
 * 止めるべきは長いほうである。
 *
 * # 成否からセッションの状態を推測しない
 *
 * 実測で `/oauth2/revoke` は**存在しないトークンにも 200 を返す**（RFC 7009 どおり、
 * トークンの有無を漏らさない）。したがって revoke の結果は何も教えてくれない。
 *
 * # 下書きを消さない
 *
 * **サインアウトは「書きかけを捨てる」操作ではない。** 消すのはセッションと
 * 進行中のログインだけで、`store` を丸ごとクリアしてはいけない。
 */
export interface SignOutDeps {
  store: SessionStore;
  /** ブラウザの現在のオリジン。`logout_uri` をここから導出する。 */
  origin: string;
  /** 画面遷移。**本物を渡すのは main.ts だけ。** */
  redirect(url: string): void;
  fetchImpl?: typeof fetch;
  config?: AuthConfig;
}

export const signOut = async (deps: SignOutDeps): Promise<void> => {
  const config = deps.config ?? AUTH_CONFIG;

  // (1)
  const refreshToken = loadSession(deps.store)?.refreshToken;

  // (2) revokeRefreshToken は投げない契約だが、**ここは (3) を必ず走らせたい場所**なので
  //     二重に守る。ここで投げると「サインアウトしたのにセッションが残る」という
  //     いちばん悪い失敗になる。
  if (refreshToken !== undefined) {
    try {
      await revokeRefreshToken({ refreshToken, config }, deps.fetchImpl);
    } catch {
      // 認可サーバ側の都合でローカルのログアウトを止めない。
    }
  }

  // (3) **遷移より先に消す。**
  clearSession(deps.store);
  clearPendingLogin(deps.store);

  // (4)
  deps.redirect(buildLogoutUrl({ config, logoutUri: resolveRedirectUri(deps.origin) }));
};
