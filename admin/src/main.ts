import './styles.css';

import type { AutoSignInDecision } from './auth/auto-sign-in.ts';
import type { CallbackResult } from './auth/callback.ts';
// **識別子を import 行で受け直している。** 走査規則 3（`test/unit/auth-seam.test.ts`）は
// 認可サーバの名前が `src/auth/` の外に出ることを禁じており、main.ts では import 行だけを
// 許している。別名にすることで「main.ts は認証輸送を繋ぐだけで、どの認可サーバかは
// auth/ が決める」という継ぎ目の意味がそのまま形になる。
import { beginSignIn, completeCallback, createCognitoAuthTransport as createAuthTransport, signOut, startAutoSignIn } from './auth/session.ts';
import { createApp, requireRoot } from './editor/app.ts';
import { renderPreview } from './preview/pipeline.ts';
import { createSessionStore } from './storage/session-store.ts';

/**
 * Vite のエントリ。**実物を組み立てて createApp に渡すだけ。**
 *
 * `api/src/index.ts` と同じ思想で、ここに条件分岐を書かない。書いた瞬間にそこがテスト
 * できない領域になる（ブラウザが無いので main.ts 自体は実行して確かめられない）。判断は
 * すべて app.ts / bind.ts / auth/ の側にあり、あちらは依存を引数で受け取るので駆動できる。
 * **`test/unit/auth-seam.test.ts` が「if / ? / && が現れない」ことを機械的に見ている。**
 *
 * 下の `redirect` と `replaceSearch` の 2 つが**ブラウザ非依存性の全部**であり、
 * **jsdom で検証できない唯一の部分**でもある（jsdom の `location.assign()` は
 * 「Not implemented: navigation to another Document」を出して**何もしない** — 例外も投げず
 * URL も変わらないので、テストに書くと緑になるが何も検証しない）。よって遷移は必ず注入した
 * 関数で観測し、ここは人間の手動確認に送る
 * （`docs/aws-ops.md` の「ブラウザでしか確かめられないこと」）。
 *
 * **`completeCallback` を `createApp` より先に `await` する。** 先に UI を立ち上げると
 * `?code=` の処理中に未認証の画面が一瞬出る。ただし **`await` が失敗しても `createApp` は
 * 必ず走らせる**（callback が壊れてもエディタは開けなければならない）ので、`catch` で
 * `no_callback` に潰している。
 *
 * **自動サインインの driver も `createApp` より先に `await` する。** ただし
 * **これは「未認証の画面を描かずに遷移する」ことではない。** `location.assign()` は遷移を
 * *予約するだけ*でスクリプトを止めないので `createApp` はこのあと必ず走り、エディタの外殻
 * （静的な `index.html` なので JS より先に描かれている）は遷移が成立するまで数百ミリ秒
 * 見えている。先に `await` するのは、未認証向けの文を出してから捨てる順序を避け、
 * **判定結果を `createApp` に渡して「ログイン画面に移動する…」と言わせる**ため —
 * どちらも**実際に見える文**の話である。判断は `auth/auto-sign-in.ts` にあり、
 * **ここは結果を運ぶだけ。**
 *
 * **`startAutoSignIn` の `catch` は到達しない**（driver 側が「reject しない」契約。
 * `completeCallback` の前例に合わせて二重に守っているだけ）。
 */
const now = (): number => Date.now();

/** 32 バイトの乱数。`pkce.ts` が長さを検査する。 */
const random = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/** 画面遷移。**jsdom では観測できないので、テストは常に偽物を注入する。** */
const redirect = (url: string): void => {
  location.assign(url);
};

/** 認可のパラメータを取り除いたクエリで現在の URL を置き換える。 */
const replaceSearch = (search: string): void => {
  history.replaceState({}, '', `${location.pathname}${search}${location.hash}`);
};

const root = requireRoot(document);
const store = createSessionStore();
const origin = location.origin;

const callback = await completeCallback({
  search: location.search,
  store,
  now,
  origin,
  replaceSearch,
}).catch((): CallbackResult => ({ kind: 'no_callback' }));

/**
 * ログインを開始する。**「ログイン」ボタンと起動時の自動サインインで同じ closure を使う。**
 *
 * `returnTo` は呼ばれた時点で評価される。**ただし「`?code=` は既に掃除されている」とは
 * 言えない** — 上の `catch` は「掃除まで終わった」と「掃除する前に落ちた」を同じ
 * `no_callback` に潰すので、`replaceSearch` が落ちた読み込みでは認可パラメータが付いた
 * まま `returnTo` に入って store に書かれる（実測。出口の再正規化はクエリを保つので
 * 消えない）。**害にならない理由は、`returnTo` を遷移に使う経路が 1 つも無いこと**
 * （`CallbackResult.signed_in.returnTo` を読むコードは `admin/src` に存在しない）。
 * 残った code も、同じ `beginPendingLogin` が verifier を上書きするので交換できない。
 * **`returnTo` を実際に遷移へ使うようにするなら、まずここを `location.pathname` だけに
 * 絞ること。**
 */
const signIn = (): Promise<void> =>
  beginSignIn({
    store,
    now,
    random,
    origin,
    redirect,
    returnTo: `${location.pathname}${location.search}`,
  });

const autoSignIn = await startAutoSignIn({ store, origin, callback, signIn }).catch(
  (): AutoSignInDecision => ({ kind: 'skip', reason: 'sign_in_failed' }),
);

createApp({
  root,
  auth: createAuthTransport({ store, now }),
  store,
  renderPreview,
  now,
  origin,
  callback,
  autoSignIn,
  onSignIn: signIn,
  onSignOut: () => signOut({ store, origin, redirect }),
});
