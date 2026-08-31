import type { SessionStore } from '../storage/session-store.ts';
import { base64UrlEncode } from './base64url.ts';
import { VERIFIER_BYTES, createVerifier } from './pkce.ts';
import type { RandomBytes } from './pkce.ts';

/**
 * ログイン開始時に作る 1 レコード。**state と verifier を束ねるのが要件の核心。**
 *
 * 別々のキーに置くと「ログイン A の state とログイン B の verifier」という組み合わせが
 * 作れてしまう。**レコードは 1 つだけ、キーも 1 つだけ。**
 *
 * # なぜ state がこちら側の責任なのか
 *
 * 実測で認可サーバは `state` の無い `/oauth2/authorize` も 302 する。
 * **つまり CSRF 防御は 100% こちら側の責任である。** サーバが許すことを
 * こちら側で禁じている、という構図をそのままコードにしてある。
 *
 * # state の比較を `===` で行う理由
 *
 * タイミング攻撃を気にしないのは、**攻撃者がこの比較に対する反復オラクルを
 * 持たないため**である。比較しているのは攻撃者のブラウザではなく被害者のブラウザの
 * ローカル値で、結果は 1 回しか観測できない。**理由を書かずに定数時間比較を
 * 持ち込むほうが、何を守っているのか分からなくなる。**
 */
export interface PendingLogin {
  /** CSRF トークン。乱数 32 バイト -> base64url 43 文字。 */
  state: string;
  /** PKCE の code_verifier。 */
  verifier: string;
  /** 注入したクロックで打つ。TTL の判定に使う。 */
  createdAt: number;
  /** ログイン後に戻る場所。**必ず `/admin/` 配下の相対パス。** */
  returnTo: string;
}

/** store の中でのキー。**1 つだけ。** */
export const PENDING_LOGIN_KEY = 'pending-login';

/**
 * レコードの寿命。
 *
 * ログインの往復に 10 分もかかることは無い。それを超えたレコードは、
 * タブを開きっぱなしにして忘れられたものなので**古い verifier を残さない**。
 */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

/** 戻り先の既定。`config.ts` の `adminPath` と同じ値だが、依存を作らない。 */
const ADMIN_PATH = '/admin/';

/**
 * 戻り先を `/admin/` 配下の相対パスに正規化する。
 *
 * **オープンリダイレクトを自分で作らないこと。** `new URL` に通して
 * `pathname + search` だけを取り、`/admin/` 配下でなければ `/admin/` に落とす。
 * オリジンは必ず捨てるので、絶対 URL を渡されても外部には飛ばない。
 */
const normalizeReturnTo = (candidate: string | undefined): string => {
  if (candidate === undefined || candidate.length === 0) return ADMIN_PATH;
  try {
    const url = new URL(candidate, 'https://placeholder.invalid/');
    const path = `${url.pathname}${url.search}`;
    return path.startsWith(ADMIN_PATH) ? path : ADMIN_PATH;
  } catch {
    return ADMIN_PATH;
  }
};

export interface BeginPendingLoginDeps {
  store: SessionStore;
  /** 注入する乱数源。**32 バイトを返すこと**（`pkce.ts` が長さを検査する）。 */
  random: RandomBytes;
  /** 注入するクロック。`Date.now()` をこのモジュールで読まない。 */
  now(): number;
  /** ログイン後に戻る場所。正規化される。 */
  returnTo?: string;
}

/**
 * ログインを開始し、レコードを保存して返す。
 *
 * **`random()` を 2 回呼ぶ**（state 用と verifier 用）。同じ乱数から両方を作ると、
 * 片方が漏れたときにもう片方も分かってしまう。
 */
export const beginPendingLogin = (deps: BeginPendingLoginDeps): PendingLogin => {
  const stateBytes = deps.random();
  if (stateBytes.length !== VERIFIER_BYTES) {
    throw new Error(`pending-login: 乱数源は ${VERIFIER_BYTES} バイトを返すこと`);
  }

  const record: PendingLogin = {
    state: base64UrlEncode(stateBytes),
    verifier: createVerifier(deps.random),
    createdAt: deps.now(),
    returnTo: normalizeReturnTo(deps.returnTo),
  };

  // **キーは 1 つ。** 直前のログイン試行は上書きされて消える（= 古い state での
  // callback は state_mismatch になる）。これが「使い回し」に対する防御でもある。
  deps.store.set(PENDING_LOGIN_KEY, record);
  return record;
};

export type ConsumeFailureReason =
  /** callback に state が付いていない。**code があっても交換に進まない。** */
  | 'state_missing'
  /** ログインを開始していない（またはレコードが壊れている）。 */
  | 'no_pending_login'
  /** state が一致しない。**session fixation を防いでいるのはここ。** */
  | 'state_mismatch'
  /** TTL 超過。 */
  | 'expired';

export type ConsumeResult =
  | { ok: true; verifier: string; returnTo: string }
  | { ok: false; reason: ConsumeFailureReason };

const isPendingLogin = (value: unknown): value is PendingLogin =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as PendingLogin).state === 'string' &&
  (value as PendingLogin).state.length > 0 &&
  typeof (value as PendingLogin).verifier === 'string' &&
  (value as PendingLogin).verifier.length > 0 &&
  typeof (value as PendingLogin).createdAt === 'number';

/**
 * レコードを**単回使用**で取り出す。
 *
 * **成功時は必ず先に削除してから返す。** 呼び出し側（`callback.ts`）はその戻り値だけで
 * token 交換に進むので、**この順序が「code の再生」に対する防御そのもの**であり、
 * 認可サーバ側の code 単回使用に依存しない二重化になっている。
 *
 * 判定の順序（上から順に、当たったらそこで終わる）:
 *
 *   1. `state` が無い          -> `state_missing`。**レコードを消さない**
 *   2. レコードが無い / 壊れている -> `no_pending_login`
 *   3. TTL 超過                -> `expired`。**消す**（古い verifier を残さない）
 *   4. `state` 不一致           -> `state_mismatch`。**消さない**
 *   5. 成功                    -> **消してから**返す
 *
 * **4 で消さないのは意図的な非対称である。** 攻撃者が誘導した callback で
 * 正規の利用者の pending レコードを壊せてしまうと、それ自体が妨害になる。
 * 同じタブで正しく戻ってくれば、まだログインを完了できる。
 */
export const consumePendingLogin = (
  store: SessionStore,
  state: string | undefined,
  now: () => number,
): ConsumeResult => {
  if (state === undefined || state.length === 0) return { ok: false, reason: 'state_missing' };

  const record = store.get<unknown>(PENDING_LOGIN_KEY);
  if (!isPendingLogin(record)) return { ok: false, reason: 'no_pending_login' };

  if (now() - record.createdAt > PENDING_LOGIN_TTL_MS) {
    store.remove(PENDING_LOGIN_KEY);
    return { ok: false, reason: 'expired' };
  }

  if (record.state !== state) return { ok: false, reason: 'state_mismatch' };

  // **先に消す。** 消してから返すので、同じ code を 2 回処理しても
  // 2 回目はここに到達しない。
  store.remove(PENDING_LOGIN_KEY);
  return { ok: true, verifier: record.verifier, returnTo: normalizeReturnTo(record.returnTo) };
};

/** サインアウトなどで、進行中のログインを捨てる。 */
export const clearPendingLogin = (store: SessionStore): void => {
  store.remove(PENDING_LOGIN_KEY);
};
