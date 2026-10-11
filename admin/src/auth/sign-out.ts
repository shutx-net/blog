import type { SessionStore } from '../storage/session-store.ts';
import { buildLogoutUrl } from './authorize-url.ts';
import { suppressAutoSignIn } from './auto-sign-in.ts';
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
 *   (4) 自動サインインの**抑止印を立てる**（`auto-sign-in.ts`）
 *   (5) `redirect` で認可サーバの `/logout` へ
 *
 * (2) を待たずにリダイレクトすると、遷移でページが破棄されて revoke の通信が中断されうる。
 * 待って失敗しても続行するので、代償は数百ミリ秒だけ。
 *
 * **(3) を (5) より先に置く。** 全画面遷移は `redirect` を呼んだ時点で**予約されるだけ**で、
 * 同じ task の同期コードは走り続ける（「遷移を始めた時点でスクリプトが止まる」は不正確）。
 * ただし**遷移が成立した時点で以降の task は走らない**ので、`redirect` のあとに置いた処理 —
 * とくに `await` をまたぐもの — は走る保証が無く、「リダイレクトしてから消す」実装はそこで
 * 取りこぼす。`test/unit/auth-signout.test.ts` は偽 `redirect` の中から store を覗くことで、
 * **順序ではなく観測で**これを固定している。
 *
 * **(4) が無いと「サインアウトできない」。** (5) が渡す `logout_uri` は `/admin/` なので、
 * サインアウトすると必ずセッション無しで `/admin/` に戻ってくる。抑止印が無ければ起動判定
 * （`auth/auto-sign-in.ts`）がそれを初回訪問と読んでログイン画面へ送り、**サインアウトした
 * 状態の画面を一度も見られない。** (3) と同じ理由で (5) より先に書き、同じ観測で固定している。
 *
 * 失効させるのは ID トークンではなく refresh トークン。ID は 60 分で自然に切れるが
 * **refresh は 24 時間生き残る。** ただし実測で `/oauth2/revoke` は存在しないトークンにも
 * 200 を返す（RFC 7009 どおりトークンの有無を漏らさない）ので、**成否からセッションの
 * 状態を推測してはいけない。**
 *
 * **サインアウトは「書きかけを捨てる」操作ではない。** 消すのはセッションと進行中の
 * ログインだけで、`store` を丸ごとクリアしてはいけない。
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

  // (4) **遷移より先に印を立てる。** 理由は上の JSDoc の (4)。
  suppressAutoSignIn(deps.store);

  // (5)
  deps.redirect(buildLogoutUrl({ config, logoutUri: resolveRedirectUri(deps.origin) }));
};
