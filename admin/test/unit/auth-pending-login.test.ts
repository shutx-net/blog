import { describe, expect, it } from 'vitest';

import {
  PENDING_LOGIN_KEY,
  PENDING_LOGIN_TTL_MS,
  beginPendingLogin,
  consumePendingLogin,
} from '../../src/auth/pending-login.ts';
import type { PendingLogin } from '../../src/auth/pending-login.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const memoryStorage = (): WebStorageLike => {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const newStore = (): SessionStore => createSessionStore(memoryStorage());

/** 呼ぶたびに違う 32 バイトを返す乱数源。**予測可能だが毎回違う。** */
const countingRandom = (): (() => Uint8Array) => {
  let counter = 0;
  return () => {
    counter += 1;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = (counter * 31 + i * 7) % 256;
    return bytes;
  };
};

const AT = 1_800_000_000_000;
const clock = (value: number) => (): number => value;

const stored = (store: SessionStore): PendingLogin | undefined =>
  store.get<PendingLogin>(PENDING_LOGIN_KEY);

describe('beginPendingLogin', () => {
  it('state と verifier を返し、**同じレコードが store に入る**', () => {
    const store = newStore();
    const begun = beginPendingLogin({ store, random: countingRandom(), now: clock(AT) });

    const record = stored(store);
    expect(record).toBeDefined();
    expect(record?.state).toBe(begun.state);
    expect(record?.verifier).toBe(begun.verifier);
    expect(record?.createdAt).toBe(AT);
  });

  it('state と verifier がどちらも 43 文字以上の base64url', () => {
    const begun = beginPendingLogin({ store: newStore(), random: countingRandom(), now: clock(AT) });
    for (const value of [begun.state, begun.verifier]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    }
  });

  it('state と verifier が互いに異なる（同じ乱数を使い回していない）', () => {
    const begun = beginPendingLogin({ store: newStore(), random: countingRandom(), now: clock(AT) });
    expect(begun.state).not.toBe(begun.verifier);
  });

  it('**攻撃 6「verifier / state の使い回し」: 2 回呼ぶとどちらも異なる**', () => {
    const store = newStore();
    const random = countingRandom();
    const first = beginPendingLogin({ store, random, now: clock(AT) });
    const second = beginPendingLogin({ store, random, now: clock(AT + 1000) });

    expect(first.state).not.toBe(second.state);
    expect(first.verifier).not.toBe(second.verifier);
  });

  it('**store に残るのは 2 回目のレコードだけ**（1 回目の callback は state_mismatch になる）', () => {
    const store = newStore();
    const random = countingRandom();
    const first = beginPendingLogin({ store, random, now: clock(AT) });
    const second = beginPendingLogin({ store, random, now: clock(AT + 1000) });

    expect(stored(store)?.state).toBe(second.state);
    expect(consumePendingLogin(store, first.state, clock(AT + 2000))).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
  });

  it('returnTo を保持できる', () => {
    const store = newStore();
    beginPendingLogin({
      store,
      random: countingRandom(),
      now: clock(AT),
      returnTo: '/admin/?draft=1',
    });
    expect(stored(store)?.returnTo).toBe('/admin/?draft=1');
  });

  it.each([
    ['絶対 URL', 'https://evil.example.com/admin/'],
    ['プロトコル相対', '//evil.example.com/'],
    ['スキーム付き', 'javascript:alert(1)'],
    ['admin の外', '/etc/passwd'],
    ['ルート', '/'],
    ['空文字', ''],
    ['バックスラッシュ', '/\\evil.example.com'],
    ['親を辿る', '/admin/../../secret'],
  ])('**オープンリダイレクトを自作しない**: %s は /admin/ 配下に正規化される', (_label, candidate) => {
    const store = newStore();
    beginPendingLogin({ store, random: countingRandom(), now: clock(AT), returnTo: candidate });
    const returnTo = stored(store)?.returnTo ?? '';
    expect(returnTo.startsWith('/admin/')).toBe(true);
    expect(returnTo).not.toContain('evil.example.com');
  });

  it('returnTo を渡さなければ /admin/ になる', () => {
    const store = newStore();
    beginPendingLogin({ store, random: countingRandom(), now: clock(AT) });
    expect(stored(store)?.returnTo).toBe('/admin/');
  });
});

describe('consumePendingLogin — **単回使用**', () => {
  const begin = (store: SessionStore, at = AT): PendingLogin =>
    beginPendingLogin({ store, random: countingRandom(), now: clock(at) });

  it('正常系: verifier と returnTo を返す', () => {
    const store = newStore();
    const begun = begin(store);
    expect(consumePendingLogin(store, begun.state, clock(AT + 1000))).toEqual({
      ok: true,
      verifier: begun.verifier,
      returnTo: '/admin/',
    });
  });

  it('**攻撃 1「code の再生」: 成功時にレコードを削除してから返す**', () => {
    const store = newStore();
    const begun = begin(store);

    expect(consumePendingLogin(store, begun.state, clock(AT + 1000)).ok).toBe(true);
    // **この 1 件が「同じ code を 2 回投げても 2 回目は token エンドポイントに
    // 到達しない」ことの根拠。** Cognito 側の code 単回使用に依存しない。
    expect(stored(store)).toBeUndefined();
    expect(consumePendingLogin(store, begun.state, clock(AT + 2000))).toEqual({
      ok: false,
      reason: 'no_pending_login',
    });
  });

  it('**攻撃 2「state 不一致（callback への CSRF）」: 失敗し、レコードは消さない**', () => {
    const store = newStore();
    const begun = begin(store);

    expect(consumePendingLogin(store, 'ATTACKER_STATE', clock(AT + 1000))).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
    // **意図的な非対称。** 正規の利用者が同じタブで戻ってきたときに壊さない。
    expect(stored(store)?.state).toBe(begun.state);
    expect(consumePendingLogin(store, begun.state, clock(AT + 2000)).ok).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['空文字', ''],
  ])('**攻撃 3「state の欠落」: %s は state_missing**', (_label, state) => {
    const store = newStore();
    begin(store);
    expect(consumePendingLogin(store, state, clock(AT + 1000))).toEqual({
      ok: false,
      reason: 'state_missing',
    });
    // 欠落でもレコードは消さない（攻撃者が消させられないこと）。
    expect(stored(store)).toBeDefined();
  });

  it('**攻撃 4「ログイン未開始での偽 callback」: 空の store では no_pending_login**', () => {
    // 攻撃者が被害者を /admin/?code=<攻撃者のcode>&state=<任意> に誘導しても、
    // ログインを開始していないので何も起きない。
    expect(consumePendingLogin(newStore(), 'ANYTHING', clock(AT))).toEqual({
      ok: false,
      reason: 'no_pending_login',
    });
  });

  it.each([
    ['プレフィックス（短い）', 'A'],
    ['プレフィックス（長い）', 'AA'],
    ['先頭一致', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ])('**長さ違い・プレフィックス一致では通らない**: %s', (_label, candidate) => {
    const store = newStore();
    const record: PendingLogin = {
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      verifier: 'V'.repeat(43),
      createdAt: AT,
      returnTo: '/admin/',
    };
    store.set(PENDING_LOGIN_KEY, record);
    expect(consumePendingLogin(store, candidate, clock(AT + 1000))).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
  });

  it('参考: 上の固定レコードは正しい state なら通る（テストが空振りしていない）', () => {
    const store = newStore();
    const record: PendingLogin = {
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      verifier: 'V'.repeat(43),
      createdAt: AT,
      returnTo: '/admin/',
    };
    store.set(PENDING_LOGIN_KEY, record);
    expect(consumePendingLogin(store, record.state, clock(AT + 1000)).ok).toBe(true);
  });
});

describe('TTL', () => {
  it('TTL が 10 分である', () => {
    expect(PENDING_LOGIN_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('期限内（ちょうど TTL）は通る', () => {
    const store = newStore();
    const begun = beginPendingLogin({ store, random: countingRandom(), now: clock(AT) });
    expect(consumePendingLogin(store, begun.state, clock(AT + PENDING_LOGIN_TTL_MS)).ok).toBe(true);
  });

  it('**TTL を超えたレコードは expired になり、そのとき削除される**', () => {
    const store = newStore();
    const begun = beginPendingLogin({ store, random: countingRandom(), now: clock(AT) });
    expect(consumePendingLogin(store, begun.state, clock(AT + PENDING_LOGIN_TTL_MS + 1))).toEqual({
      ok: false,
      reason: 'expired',
    });
    // **古い verifier を残さない。**
    expect(stored(store)).toBeUndefined();
  });
});

describe('壊れたレコード', () => {
  it.each([
    ['state が無い', { verifier: 'v'.repeat(43), createdAt: AT, returnTo: '/admin/' }],
    ['verifier が無い', { state: 's'.repeat(43), createdAt: AT, returnTo: '/admin/' }],
    ['createdAt が数値でない', { state: 's', verifier: 'v', createdAt: 'x', returnTo: '/admin/' }],
    ['空オブジェクト', {}],
  ])('%s は no_pending_login（投げない）', (_label, record) => {
    const store = newStore();
    store.set(PENDING_LOGIN_KEY, record);
    expect(() => consumePendingLogin(store, 's'.repeat(43), clock(AT))).not.toThrow();
    expect(consumePendingLogin(store, 's'.repeat(43), clock(AT))).toEqual({
      ok: false,
      reason: 'no_pending_login',
    });
  });
});
