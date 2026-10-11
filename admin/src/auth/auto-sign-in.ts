import type { SessionStore } from '../storage/session-store.ts';
import type { CallbackResult } from './callback.ts';
import { loadSession } from './session-state.ts';

/**
 * 起動時に自動でログイン画面へ送るかどうか。
 *
 * **判定（`decideAutoSignIn`）と駆動（`startAutoSignIn`）を分けてある。** 判定は store も
 * 時計もブラウザも読まない純関数（入力はすべて引数）なので、node 環境で全分岐を駆動できる。
 * 駆動側は store と「ログインを開始する関数」を注入で受け取り、**画面遷移そのものは
 * ここに書かない**（本物を差し込むのは `main.ts` だけ）。
 *
 * # なぜ「抑止印」が要るのか
 *
 * `/admin/` にセッション無しで到達する経路は 1 つではない。
 *
 *   1. 初回訪問                       -> 送る（これが要件）
 *   2. refresh 失効後の再読み込み     -> 送る（`refresh.ts` が `clearSession` 済み）
 *   3. **サインアウト直後**           -> 送ってはいけない。`sign-out.ts` が渡す
 *      `logout_uri` は `/admin/` なので、**サインアウトすると必ずセッション無しで
 *      ここに戻ってくる。** 素朴に実装すると押した瞬間にログイン画面へ戻り、
 *      **サインアウトできない**
 *   4. 認可サーバがエラーを返した直後 -> 送ってはいけない。送るとエラー表示を
 *      読む機会が無いまま往復し続ける
 *   5. 印が保存できない環境           -> 1 往復はする。ただし pending レコードも
 *      保存できていないので戻りは `no_pending_login` の callback になり、
 *      経路 4 として止まる
 *
 * 4 は `CallbackResult` を見れば分かるが、**3 は「直前に自分が送った」ことを
 * 覚えておくしか区別する方法が無い。** それが抑止印である。
 *
 * **不変条件: 印は遷移の直前に必ず書かれ、セッションを持った読み込みでしか消えない。**
 * 系として、連続する 2 回の自動遷移の間には必ずセッションを持った読み込みがあるので、
 * 印が読み書きできる限り無人のループは原理的に起こらない
 * （`test/unit/auth-auto-sign-in.test.ts` がこの系を名指しで固定している）。
 */

/** store の中でのキー。 */
export const AUTO_SIGN_IN_SUPPRESSED_KEY = 'auto-sign-in-suppressed';

/**
 * 抑止印を立てる。**自動遷移を始める直前と、サインアウトの直前に呼ぶ。** どちらも
 * 「この次の読み込みはセッション無しで来るが、それは異常ではない」という意味。
 */
export const suppressAutoSignIn = (store: SessionStore): void => {
  store.set(AUTO_SIGN_IN_SUPPRESSED_KEY, true);
};

/** 抑止印を消す。**セッションを持った読み込みだけが呼ぶ。** */
export const clearAutoSignInSuppression = (store: SessionStore): void => {
  store.remove(AUTO_SIGN_IN_SUPPRESSED_KEY);
};

/**
 * 抑止印があるか。
 *
 * **真偽ではなく有無を見る。** `false` が入っていても抑止として読む — 迷ったら
 * 「送らない」に倒すほうが安全で、ループを増やす方向には倒れない。逆に読めない環境
 * （版違い・壊れた JSON・保存できない store）では `undefined` =「印なし」に倒れ、
 * **1 回は送る**。そこを受けるのは上の経路 5 である。
 */
export const isAutoSignInSuppressed = (store: SessionStore): boolean =>
  store.get<unknown>(AUTO_SIGN_IN_SUPPRESSED_KEY) !== undefined;

export type AutoSignInSkipReason =
  | 'session'
  /** 認可の往復から戻ってきた読み込みである（成功も失敗も含む）。 */
  | 'callback'
  /** 抑止印がある（直前に自分が送った・サインアウト直後）。 */
  | 'suppressed'
  | 'insecure_origin'
  /** ログイン開始が投げた。**`startAutoSignIn` だけが返す。** */
  | 'sign_in_failed';

export type AutoSignInDecision =
  | { kind: 'sign_in' }
  | { kind: 'skip'; reason: AutoSignInSkipReason };

export interface AutoSignInInput {
  /**
   * `loadSession` が値を返したか。**`exp` を見ない** — 期限切れでも refresh トークンで
   * 黙って更新できる状態ならセッションは「ある」。更新できるはずの人を全画面遷移に
   * 送らないための選択で、`refresh.ts` の `isAuthenticated` と同じ基準である。
   */
  hasSession: boolean;
  /** `completeCallback` の結果の種別。 */
  callbackKind: CallbackResult['kind'];
  suppressed: boolean;
  origin: string;
}

/** 送るか送らないかを決める。**優先順が上から順にそのまま要件である。** */
export const decideAutoSignIn = (input: AutoSignInInput): AutoSignInDecision => {
  // (1) **この段が最優先。** 下の 3 段はどれも「セッションが無いときにどう振る舞うか」
  //     の話でしかない。
  if (input.hasSession) return { kind: 'skip', reason: 'session' };

  // (2) 上の経路 4（認可の往復から戻った読み込み）。**エラーの表示を読む機会が要る**のが
  //     主な理由。成功（`signed_in`）がここに落ちてくるのはセッションを保存できなかった
  //     環境だけで、送り直しても同じ。
  if (input.callbackKind !== 'no_callback') return { kind: 'skip', reason: 'callback' };

  // (3) 上の経路 3（サインアウト直後）。**ここが「サインアウトできる」を成立させている段。**
  if (input.suppressed) return { kind: 'skip', reason: 'suppressed' };

  // (4) http から送っても `CallbackURLs`（https のリテラル 2 本。
  //     `infra/test/cognito.test.ts` が完全一致で固定している）に一致せず
  //     `redirect_mismatch` になるだけで、`npm run -w admin dev` が開けなくなる分だけ損。
  if (!input.origin.startsWith('https://')) return { kind: 'skip', reason: 'insecure_origin' };

  return { kind: 'sign_in' };
};

export interface StartAutoSignInDeps {
  store: SessionStore;
  origin: string;
  /** `completeCallback` の結果。**この読み込みが認可の戻りかどうかを持っている。** */
  callback: CallbackResult;
  /**
   * ログインを開始する。**本物（pending レコードの保存と全画面遷移を含む）を渡すのは
   * `main.ts` だけ**で、手動の「ログイン」ボタンと同じ closure が刺される。
   */
  signIn(): Promise<void>;
}

/**
 * 判定して、必要ならログインを 1 回だけ開始する。
 *
 * **この関数は reject しない。** 開始が失敗したら `{kind:'skip', reason:'sign_in_failed'}` を
 * 返して未認証の画面を見せるほうに倒す。`main.ts` は `createApp` の前にこれを await するので、
 * ここで投げる契約にすると「callback は壊れてもエディタは開ける」と揃わない。
 *
 * **`suppressAutoSignIn` は `await` より先。** 印を `await` の後ろ（= 別の task）に置くと、
 * 印が書かれないまま次の読み込みが来て**ループになりうる**（遷移の予約と task の関係は
 * `sign-out.ts` の (3) と同じ）。テストは偽の `signIn` の中から store を覗いて
 * **順序ではなく観測で**これを固定している。
 *
 * **`signIn` が投げた場合、抑止印はそのタブに残り続ける**ので、**そのタブは二度と自動では
 * 送らない**（「1 回だけ失敗する」ではない）。現実的な引き金（`crypto.subtle` が無い等）では
 * 手動の「ログイン」ボタンも同じ関数で落ちるので、残す向きがループ安全側である。
 */
export const startAutoSignIn = async (deps: StartAutoSignInDeps): Promise<AutoSignInDecision> => {
  const decision = decideAutoSignIn({
    hasSession: loadSession(deps.store) !== undefined,
    callbackKind: deps.callback.kind,
    suppressed: isAutoSignInSuppressed(deps.store),
    origin: deps.origin,
  });

  if (decision.kind === 'skip') {
    // **印をたたむのはここだけ。** 他の skip では残す — 残さないと「エラー表示を
    // 読んでいる間に次の読み込みで送られる」「サインアウト後に F5 したら送られる」が戻る。
    if (decision.reason === 'session') clearAutoSignInSuppression(deps.store);
    return decision;
  }

  suppressAutoSignIn(deps.store);

  try {
    await deps.signIn();
  } catch {
    return { kind: 'skip', reason: 'sign_in_failed' };
  }

  return decision;
};
