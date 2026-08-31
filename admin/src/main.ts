import './styles.css';

import type { CallbackResult } from './auth/callback.ts';
// **識別子を import 行で受け直している。** 走査規則 3（`test/unit/auth-seam.test.ts`）は
// 認可サーバの名前が `src/auth/` の外に出ることを禁じており、main.ts では import 行だけを
// 許している。別名にすることで「main.ts は認証輸送を繋ぐだけで、どの認可サーバかは
// auth/ が決める」という継ぎ目の意味がそのまま形になる。
import { beginSignIn, completeCallback, createCognitoAuthTransport as createAuthTransport, signOut } from './auth/session.ts';
import { createApp, requireRoot } from './editor/app.ts';
import { renderPreview } from './preview/pipeline.ts';
import { createSessionStore } from './storage/session-store.ts';

/**
 * Vite のエントリ。**実物を組み立てて createApp に渡すだけ。**
 *
 * `api/src/index.ts` と同じ思想で、ここに条件分岐を書かない。書いた瞬間に
 * そこがテストできない領域になる（ブラウザが無いので main.ts 自体は実行して
 * 確かめられない）。判断はすべて app.ts / bind.ts / auth/ の側にあり、
 * あちらはすべての依存を引数で受け取るのでテストから駆動できる。
 * **`test/unit/auth-seam.test.ts` が「if / ? / && が現れない」ことを機械的に見ている。**
 *
 * # このファイルだけがブラウザの現在 URL と履歴 API に触る
 *
 * 下の `redirect` と `replaceSearch` の 2 つが**ブラウザ非依存性の全部**であり、
 * **jsdom で検証できない唯一の部分**でもある（jsdom の `location.assign()` は
 * 「Not implemented: navigation to another Document」を出して**何もしない** —
 * 例外も投げず URL も変わらないので、テストに書くと緑になるが何も検証しない）。
 * よって遷移は必ず注入した関数で観測し、ここは人間の手動確認に送る（DEVELOPERS.md）。
 *
 * # 順序
 *
 * **`completeCallback` を `createApp` より先に `await` する。** 先に UI を立ち上げると、
 * `?code=` の処理中に未認証の画面が一瞬出る。ただし **`await` が失敗しても
 * `createApp` は必ず走らせる**（callback が壊れてもエディタは開けなければならない）ので、
 * `catch` で `no_callback` に潰している。
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

createApp({
  root,
  auth: createAuthTransport({ store, now }),
  store,
  renderPreview,
  now,
  origin,
  callback,
  onSignIn: () =>
    beginSignIn({
      store,
      now,
      random,
      origin,
      redirect,
      returnTo: `${location.pathname}${location.search}`,
    }),
  onSignOut: () => signOut({ store, origin, redirect }),
});
