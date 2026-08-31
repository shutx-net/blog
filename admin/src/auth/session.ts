import { AUTH_HEADER, AUTH_SCHEME } from '@blog/api/src/auth/transport.ts';
import type { SessionStore } from '../storage/session-store.ts';
import { buildAuthorizeUrl } from './authorize-url.ts';
import { handleCallback } from './callback.ts';
import type { CallbackResult } from './callback.ts';
import { AUTH_CONFIG, resolveRedirectUri } from './config.ts';
import type { AuthConfig } from './config.ts';
import { beginPendingLogin } from './pending-login.ts';
import { challengeFor } from './pkce.ts';
import type { RandomBytes } from './pkce.ts';
import { createTokenSource } from './refresh.ts';
import { exchangeCode } from './token-endpoint.ts';

/**
 * **認証の継ぎ目。組み立て役であって、実装ではない。**
 *
 * 暗号もパースも URL の組み立てもここには書かない。それぞれ
 * `pkce.ts` / `claims.ts` / `authorize-url.ts` / `token-endpoint.ts` /
 * `pending-login.ts` / `session-state.ts` / `refresh.ts` にある。
 * このファイルの仕事は**それらを束ねて `AuthTransport` を作ること**だけである。
 *
 * ## 置いている仮定
 *
 * a) admin と `/api/*` は**同一オリジン**（同じ CloudFront ディストリビューション
 *    配下）なので、API 呼び出しに CORS は要らない。
 * b) 輸送方式は「リクエストヘッダの集合」か「`credentials` モード（Cookie）」の
 *    どちらかに落ちる。`AuthTransport` の 3 メンバはその両方を表現できる。
 * c) **`Authorization` は使えない。** CloudFront は OAC の SigV4
 *    （`SigningBehavior: always`）で閲覧者の `Authorization` を上書きするので、
 *    ここに書いても届かない。カスタムヘッダ（`x-blog-authorization`）を使う。
 * d) トークン取得の手順は全部 `src/auth/` の内側で完結する。
 *
 * ## 依存はすべて注入する
 *
 * `store` / `fetchImpl` / `now` / `random` / `redirect` / `replaceSearch` / `origin` の
 * 7 つで、**本物を渡すのは `src/main.ts` だけ。** テストは全部偽物を刺す。
 */
export interface AuthTransport {
  /**
   * 各リクエストに足すヘッダ。
   *
   * **`authorization` を返してはいけない**（上の仮定 c）。返した場合、
   * api/client.ts が黙って無視するのではなく **例外を投げる** —
   * CloudFront に上書きされて「認証が通らない理由が分からない」状態になるより、
   * その場で落ちるほうが直せる。
   *
   * **`Promise` を返す設計がリフレッシュを可能にしている。** 呼ばれた瞬間に
   * 期限を見て、必要なら先に更新してから返す（`refresh.ts`）。
   */
  authHeaders(): Promise<Record<string, string>>;

  /** Cookie 方式に差し替えたときに `'include'` を効かせるための口。 */
  credentials: RequestCredentials;

  /** 画面の出し分け用。**認可の判断には使わない**（判断は必ずサーバ側）。 */
  isAuthenticated(): boolean;
}

/**
 * 実装が無いときのスタブ。**消さないこと。**
 *
 * `scripts/smoke.ts` と既存の 2 テストが import している。本物と同じ 3 メンバを持ち、
 * 何も足さないので api は認証エラーを返す（トークンが無いのだから、それが正しい）。
 */
export const createStubAuthTransport = (): AuthTransport => ({
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => false,
});

export interface AuthTransportDeps {
  store: SessionStore;
  /** 注入するクロック。 */
  now(): number;
  fetchImpl?: typeof fetch;
  config?: AuthConfig;
  skewMs?: number;
}

/**
 * 本物の `AuthTransport`。**3 メンバのまま。**
 *
 * 4 つ目のメンバを生やさない。増やすと `api/client.ts` と全 DOM テストに波及する。
 * `test/unit/auth-transport.test.ts` が `Object.keys()` で機械的に固定している。
 *
 * ## リアクティブな再送を持たない
 *
 * `AuthTransport` は応答を見られないので「期限切れ -> 拒否 -> 更新して再送」という
 * 一般的な形が採れない。**それで足りる。** `refresh.ts` の just-in-time 更新
 * （skew 120 秒）により期限切れ由来の拒否は原理的にほぼ起きず、残る拒否の原因は
 * refresh トークンの失効・トークンの失効・別ユーザで、**どれも再送では直らない。**
 * つまり拒否は終端であり、`app.ts` は再ログインを促せばよい。
 * **再送を持たないことが、無限ループが構造的に起こり得ないことの証明になっている。**
 */
export const createCognitoAuthTransport = (deps: AuthTransportDeps): AuthTransport => {
  const source = createTokenSource({
    store: deps.store,
    now: deps.now,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.config === undefined ? {} : { config: deps.config }),
    ...(deps.skewMs === undefined ? {} : { skewMs: deps.skewMs }),
  });

  return {
    authHeaders: async (): Promise<Record<string, string>> => {
      const idToken = await source.currentIdToken();
      // **古いトークンを送り続けない。** 無ければ何も足さず、api に拒否させる。
      if (idToken === undefined) return {};
      return { [AUTH_HEADER]: `${AUTH_SCHEME} ${idToken}` };
    },
    credentials: 'same-origin',
    isAuthenticated: (): boolean => source.isAuthenticated(),
  };
};

export interface BeginSignInDeps {
  store: SessionStore;
  now(): number;
  random: RandomBytes;
  /** ブラウザの現在のオリジン。`redirect_uri` をここから導出する。 */
  origin: string;
  /** 画面遷移。**本物を渡すのは main.ts だけ**（jsdom では観測できない）。 */
  redirect(url: string): void;
  /** ログイン後に戻る場所。`/admin/` 配下に正規化される。 */
  returnTo?: string;
  config?: AuthConfig;
}

/**
 * ログインを開始する。
 *
 * **pending レコードの保存が遷移より先**であることが要件（そうでないと戻ってきたときに
 * verifier が無い）。`beginPendingLogin` -> `challengeFor` -> `redirect` の順に書いてあり、
 * `test/unit/auth-transport.test.ts` が偽 `redirect` の中から store を覗いて
 * **順序ではなく観測で**固定している。
 */
export const beginSignIn = async (deps: BeginSignInDeps): Promise<void> => {
  const config = deps.config ?? AUTH_CONFIG;
  const pending = beginPendingLogin({
    store: deps.store,
    random: deps.random,
    now: deps.now,
    ...(deps.returnTo === undefined ? {} : { returnTo: deps.returnTo }),
  });

  const url = buildAuthorizeUrl({
    config,
    state: pending.state,
    challenge: await challengeFor(pending.verifier),
    redirectUri: resolveRedirectUri(deps.origin),
  });

  deps.redirect(url);
};

export interface CompleteCallbackDeps {
  /** ブラウザのアドレス欄のクエリ文字列。 */
  search: string;
  store: SessionStore;
  now(): number;
  origin: string;
  replaceSearch(search: string): void;
  fetchImpl?: typeof fetch;
  config?: AuthConfig;
}

/**
 * `?code=` で戻ってきたときの処理を駆動する。
 *
 * **遷移しない。** 判定と保存だけを行い、画面の出し分けは `app.ts` の仕事。
 */
export const completeCallback = async (deps: CompleteCallbackDeps): Promise<CallbackResult> => {
  const config = deps.config ?? AUTH_CONFIG;
  return handleCallback({
    search: deps.search,
    store: deps.store,
    now: deps.now,
    redirectUri: resolveRedirectUri(deps.origin),
    replaceSearch: deps.replaceSearch,
    exchange: (args) => exchangeCode({ ...args, config }, deps.fetchImpl),
    expected: { clientId: config.clientId, issuer: config.issuer },
  });
};

/**
 * サインアウト。実装は `sign-out.ts`（revoke -> 消去 -> 遷移の順序がそこで固定されている）。
 */
export { signOut } from './sign-out.ts';
export type { SignOutDeps } from './sign-out.ts';

/**
 * 輸送の契約。**api/src/auth/transport.ts が唯一の出所。**
 * ここで再 export しておくと、綴りを書き写す経路が構造的に無くなる。
 */
export { AUTH_HEADER, AUTH_SCHEME } from '@blog/api/src/auth/transport.ts';
