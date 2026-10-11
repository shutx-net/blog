import { describe, expect, it } from 'vitest';

import {
  AUTO_SIGN_IN_SUPPRESSED_KEY,
  clearAutoSignInSuppression,
  decideAutoSignIn,
  isAutoSignInSuppressed,
  startAutoSignIn,
  suppressAutoSignIn,
} from '../../src/auth/auto-sign-in.ts';
import type {
  AutoSignInDecision,
  AutoSignInInput,
  AutoSignInSkipReason,
} from '../../src/auth/auto-sign-in.ts';
import type { CallbackResult } from '../../src/auth/callback.ts';
import { SESSION_KEY } from '../../src/auth/session-state.ts';
import type { StoredSession } from '../../src/auth/session-state.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

/**
 * **自動サインインの判定と駆動。**
 *
 * 守りたい不変条件は 1 つだけ:
 *
 *   自動遷移は `セッション無し ∧ 印無し ∧ callback が no_callback ∧ origin が https`
 *   のときだけ起きる。印は遷移の直前に必ず書かれ、**セッションを持った読み込みでしか
 *   消えない。** 系: 連続する 2 回の自動遷移の間には必ずセッションを持った読み込みがある。
 *
 * **遷移は注入した偽 `signIn` でだけ観測する。** jsdom でも本物の全画面遷移は観測できない
 * （`main.ts` の JSDoc が実測を書いている）ので、ここは node 環境で駆動する。
 */

/** 本番のオリジン。`infra/test/cognito.test.ts` の `CallbackURLs` と同じ綴り。 */
const ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';

/** vite の dev server。**http なので送らない。** */
const INSECURE_ORIGIN = 'http://localhost:5173';

const NO_CALLBACK: CallbackResult = { kind: 'no_callback' };

/** `isStoredSession` を通る最小のレコード。**`expiresAtMs` は判定に使われない。** */
const SESSION: StoredSession = {
  idToken: 'header.payload.signature',
  refreshToken: 'R',
  expiresAtMs: 1_800_000_000_000,
};

/** 実キーを覗ける偽ストレージ。 */
const backing = (): WebStorageLike & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

/** 書き込みが黙って捨てられるストレージ。**投げないので呼び出し側は気づけない。** */
const readOnly = (storage: WebStorageLike): WebStorageLike => ({
  getItem: (key) => storage.getItem(key),
  setItem: () => undefined,
  removeItem: (key) => storage.removeItem(key),
});

const newStore = (): SessionStore => createSessionStore(backing());

describe('decideAutoSignIn — **優先順がそのまま要件**', () => {
  /** 自動遷移が起きるべき唯一の形。 */
  const FRESH: AutoSignInInput = {
    hasSession: false,
    callbackKind: 'no_callback',
    suppressed: false,
    origin: ORIGIN,
  };

  it('セッション無し・no_callback・印無し・https なら sign_in', () => {
    expect(decideAutoSignIn(FRESH)).toEqual({ kind: 'sign_in' });
  });

  it.each<boolean>([false, true])(
    'セッションがあれば skip:session（印の有無に関わらず: 印 %s）',
    (suppressed) => {
      expect(decideAutoSignIn({ ...FRESH, hasSession: true, suppressed })).toEqual({
        kind: 'skip',
        reason: 'session',
      });
    },
  );

  it.each<CallbackResult['kind']>(['provider_error', 'failed', 'signed_in'])(
    '**callback が %s なら skip:callback**（エラー表示を読む機会を奪わない）',
    (callbackKind) => {
      expect(decideAutoSignIn({ ...FRESH, callbackKind })).toEqual({
        kind: 'skip',
        reason: 'callback',
      });
    },
  );

  it('**抑止印があれば skip:suppressed**（サインアウト直後がこれ）', () => {
    expect(decideAutoSignIn({ ...FRESH, suppressed: true })).toEqual({
      kind: 'skip',
      reason: 'suppressed',
    });
  });

  it.each<string>([INSECURE_ORIGIN, 'http://127.0.0.1:5173'])(
    '**%s では skip:insecure_origin**（CallbackURLs は https の 2 本だけ）',
    (origin) => {
      expect(decideAutoSignIn({ ...FRESH, origin })).toEqual({
        kind: 'skip',
        reason: 'insecure_origin',
      });
    },
  );

  /**
   * **優先順 session > callback > suppressed > insecure_origin。**
   *
   * 全条件が成立している入力から 1 つずつ外していく。どれかの段を消すと、
   * その段を期待している行が別の reason を返して赤くなる。
   */
  const ALL_BLOCKED: AutoSignInInput = {
    hasSession: true,
    callbackKind: 'provider_error',
    suppressed: true,
    origin: INSECURE_ORIGIN,
  };

  const PRIORITY: ReadonlyArray<{
    label: string;
    patch: Partial<AutoSignInInput>;
    reason: AutoSignInSkipReason;
  }> = [
    { label: '全条件が成立していれば session', patch: {}, reason: 'session' },
    { label: 'セッションだけ外すと callback', patch: { hasSession: false }, reason: 'callback' },
    {
      label: 'セッションと callback を外すと suppressed',
      patch: { hasSession: false, callbackKind: 'no_callback' },
      reason: 'suppressed',
    },
    {
      label: 'セッションと callback と印を外すと insecure_origin',
      patch: { hasSession: false, callbackKind: 'no_callback', suppressed: false },
      reason: 'insecure_origin',
    },
  ];

  it.each(PRIORITY)('$label', ({ patch, reason }) => {
    expect(decideAutoSignIn({ ...ALL_BLOCKED, ...patch })).toEqual({ kind: 'skip', reason });
  });
});

describe('抑止印', () => {
  it('suppress で立ち、clear で消える', () => {
    const store = newStore();
    expect(isAutoSignInSuppressed(store)).toBe(false);
    suppressAutoSignIn(store);
    expect(isAutoSignInSuppressed(store)).toBe(true);
    clearAutoSignInSuppression(store);
    expect(isAutoSignInSuppressed(store)).toBe(false);
  });

  it('**false が入っていても抑止と読む**（真偽ではなく有無を見る）', () => {
    const store = newStore();
    store.set(AUTO_SIGN_IN_SUPPRESSED_KEY, false);
    expect(isAutoSignInSuppressed(store)).toBe(true);
  });

  it('実キーが blog.admin.auto-sign-in-suppressed である', () => {
    // Web Storage の綴りは storage/session-store.ts 1 本のままで、
    // 新しいキーも同じ名前空間に入る。
    const storage = backing();
    suppressAutoSignIn(createSessionStore(storage));
    expect([...storage.entries.keys()]).toEqual(['blog.admin.auto-sign-in-suppressed']);
  });
});

interface Scene {
  store: SessionStore;
  /**
   * `signIn` が呼ばれた瞬間の store の中身。**1 要素 = 1 回の呼び出し**なので、
   * 長さが呼び出し回数でもある。順序ではなく観測で固定するための窓。
   */
  seenAtSignIn: Array<{ suppressed: boolean; draft: unknown }>;
  /** 1 回のページ読み込みに相当。 */
  load(options?: { callback?: CallbackResult; origin?: string }): Promise<AutoSignInDecision>;
}

const scene = (options: { failSignIn?: boolean; writable?: boolean } = {}): Scene => {
  const storage = backing();
  const store = createSessionStore(options.writable === false ? readOnly(storage) : storage);
  const seenAtSignIn: Array<{ suppressed: boolean; draft: unknown }> = [];

  const signIn = (): Promise<void> => {
    seenAtSignIn.push({ suppressed: isAutoSignInSuppressed(store), draft: store.get('draft') });
    return options.failSignIn === true
      ? Promise.reject(new Error('遷移を開始できなかった'))
      : Promise.resolve();
  };

  return {
    store,
    seenAtSignIn,
    load: (o = {}) =>
      startAutoSignIn({
        store,
        origin: o.origin ?? ORIGIN,
        callback: o.callback ?? NO_CALLBACK,
        signIn,
      }),
  };
};

describe('startAutoSignIn', () => {
  it('初回訪問で signIn がちょうど 1 回呼ばれる', async () => {
    const s = scene();
    await expect(s.load()).resolves.toEqual({ kind: 'sign_in' });
    expect(s.seenAtSignIn).toHaveLength(1);
  });

  it('**signIn が呼ばれた時点で抑止印が既に store に入っている**', async () => {
    // 印を await の後ろ（= 別の task）に置くと取りこぼす（理由は src/auth/auto-sign-in.ts）。
    // 順序ではなく観測で固定する（sign-out.ts の (3) -> (4) と同じ手法）。
    const s = scene();
    await s.load();
    expect(s.seenAtSignIn[0]?.suppressed).toBe(true);
  });

  it('**signIn が呼ばれた時点で下書きは残っている**（開いただけで書きかけが飛ばない）', async () => {
    const s = scene();
    s.store.set('draft', { title: '書きかけ', body: '本文' });
    await s.load();
    expect(s.seenAtSignIn[0]?.draft).toEqual({ title: '書きかけ', body: '本文' });
  });

  it('**セッションを持った読み込みで抑止印が消える**', async () => {
    const s = scene();
    suppressAutoSignIn(s.store);
    s.store.set(SESSION_KEY, SESSION);

    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'session' });
    expect(isAutoSignInSuppressed(s.store)).toBe(false);
    expect(s.seenAtSignIn).toHaveLength(0);
  });

  it('**サインアウト相当（印あり・セッション無し・no_callback）では signIn を呼ばない**', async () => {
    // これが無いと「押した瞬間にログイン画面へ戻る」= サインアウトできない。
    const s = scene();
    suppressAutoSignIn(s.store);

    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'suppressed' });
    expect(s.seenAtSignIn).toHaveLength(0);
    // **印は残す。** セッションを持った読み込みでしか消えない。
    expect(isAutoSignInSuppressed(s.store)).toBe(true);
  });

  it.each<CallbackResult>([
    { kind: 'provider_error', error: 'access_denied', description: undefined },
    { kind: 'failed', reason: 'no_pending_login' },
  ])('callback が $kind なら signIn を呼ばない', async (callback) => {
    const s = scene();
    await expect(s.load({ callback })).resolves.toEqual({ kind: 'skip', reason: 'callback' });
    expect(s.seenAtSignIn).toHaveLength(0);
  });

  it('**signIn が reject しても resolve して skip:sign_in_failed を返す**', async () => {
    // **reject しないのが契約**（理由は src/auth/auto-sign-in.ts。main.ts 側の .catch は
    // この契約ゆえに到達しない）。
    const s = scene({ failSignIn: true });

    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'sign_in_failed' });
    expect(s.seenAtSignIn).toHaveLength(1);
    // 失敗したからといってもう一度送らない。**印はそのタブの寿命まで立ったまま**なので、
    // そのタブは二度と自動では送らない（「1 回だけ失敗する」ではない）。
    expect(isAutoSignInSuppressed(s.store)).toBe(true);
  });

  it('**連続 2 回の読み込みで自動遷移は 1 回だけ**', async () => {
    const s = scene();
    await expect(s.load()).resolves.toEqual({ kind: 'sign_in' });
    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'suppressed' });
    expect(s.seenAtSignIn).toHaveLength(1);
  });

  it('**ストレージが死んでいても往復 1 回で止まる**', async () => {
    // 印が保存できないので 2 回目も「印無し」に見える。**それでもループしない** —
    // pending レコードも保存できていないので戻りは no_pending_login の callback になり、
    // そこで止まる（src/auth/auto-sign-in.ts の経路 5）。
    const s = scene({ writable: false });

    await expect(s.load()).resolves.toEqual({ kind: 'sign_in' });
    expect(isAutoSignInSuppressed(s.store)).toBe(false);
    await expect(
      s.load({ callback: { kind: 'failed', reason: 'no_pending_login' } }),
    ).resolves.toEqual({ kind: 'skip', reason: 'callback' });
    expect(s.seenAtSignIn).toHaveLength(1);
  });

  it('**セッションを持った読み込みを挟まないと 2 回目の自動遷移は起きない**', async () => {
    // 不変条件の系そのもの。連続する 2 回の自動遷移の間には必ず
    // セッションを持った読み込みがある。
    const s = scene();

    await expect(s.load()).resolves.toEqual({ kind: 'sign_in' });
    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'suppressed' });

    s.store.set(SESSION_KEY, SESSION);
    await expect(s.load()).resolves.toEqual({ kind: 'skip', reason: 'session' });

    s.store.remove(SESSION_KEY);
    await expect(s.load()).resolves.toEqual({ kind: 'sign_in' });
    expect(s.seenAtSignIn).toHaveLength(2);
  });
});

/**
 * **import の循環を機械で防ぐ。**
 *
 * いまの向きは一方向である: `session.ts` -> `sign-out.ts` -> `auto-sign-in.ts`
 * （`session.ts` は両方を再 export する継ぎ目で、`auto-sign-in.ts` はどちらも知らない）。
 * `auto-sign-in.ts` が `session.ts` を import した瞬間に**循環**ができる。
 *
 * **循環の何が悪いか。** ESM はエラーにしないので、壊れ方が静かで遅い。この 3 ファイルの
 * export はすべて `const` の矢印関数なので、評価順が入れ替わった側から見ると TDZ に落ちて
 * **実行時に「Cannot access ... before initialization」**になる。どの入口から読み込まれたかで
 * 評価順が決まるため、**テストでは緑のままブラウザでだけ落ちる**形になりうる。
 * 必要なものは `session-state.ts` から取れば足りるので、この向きを崩す理由は無い。
 *
 * 走査は指定子の位置だけを見るので、**コメントで `sign-out.ts` の話をしても赤くならない。**
 */
describe('**循環 import を作らない**', () => {
  /** `import` / `export ... from` / 動的 `import()` が指している指定子。 */
  const specifiersOf = (source: string): string[] =>
    [...source.matchAll(/\b(?:from|import)\s*\(?\s*'([^']*)'/g)].map(([, found]) => found ?? '');

  const ownSpecifiers = async (): Promise<string[]> => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return specifiersOf(
      readFileSync(
        fileURLToPath(new URL('../../src/auth/auto-sign-in.ts', import.meta.url)),
        'utf8',
      ),
    );
  };

  it('検出規則そのものが機能する', () => {
    expect(specifiersOf("import { signOut } from './session.ts';")).toEqual(['./session.ts']);
    expect(specifiersOf("export { suppressAutoSignIn } from './sign-out.ts';")).toEqual([
      './sign-out.ts',
    ]);
    expect(specifiersOf("const m = await import('./session.ts');")).toEqual(['./session.ts']);
    // コメントの中の綴りは拾わない。
    expect(specifiersOf('// session.ts と sign-out.ts の話をしているだけ')).toEqual([]);
  });

  it('走査が空振りしていない（実際の import を拾えている）', async () => {
    // **セッションの有無は `session-state.ts` から取る。** これが拾えなくなったら、
    // 下の 2 本は「指定子が 1 つも見えないので違反も無い」で緑になる。
    await expect(ownSpecifiers()).resolves.toContain('./session-state.ts');
  });

  it.each(['./session.ts', './sign-out.ts'])(
    '**auto-sign-in.ts は %s を import しない**',
    async (forbidden) => {
      await expect(ownSpecifiers()).resolves.not.toContain(forbidden);
    },
  );
});
