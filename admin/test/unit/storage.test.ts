import { describe, expect, it } from 'vitest';

import { AUTO_SIGN_IN_SUPPRESSED_KEY } from '../../src/auth/auto-sign-in.ts';
import { PENDING_LOGIN_KEY } from '../../src/auth/pending-login.ts';
import { SESSION_KEY } from '../../src/auth/session-state.ts';
import { DRAFT_KEY } from '../../src/editor/draft-persistence.ts';
import { STORAGE_NAMESPACE, createSessionStore } from '../../src/storage/session-store.ts';
import type { WebStorageLike } from '../../src/storage/session-store.ts';

/** 記録つきの偽ストレージ。**実キー**が見えるようにしてある。 */
const fakeStorage = (): WebStorageLike & { entries: Map<string, string> } => {
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

/** Safari のプライベートモード相当。**書き込みが必ず投げる。** */
const throwingStorage = (): WebStorageLike => ({
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
});

describe('名前空間つきのキー', () => {
  it('名前空間が "blog.admin." である', () => {
    expect(STORAGE_NAMESPACE).toBe('blog.admin.');
  });

  it('実キーが名前空間で始まる', () => {
    const storage = fakeStorage();
    createSessionStore(storage).set('pending-login', { a: 1 });
    expect([...storage.entries.keys()]).toEqual(['blog.admin.pending-login']);
  });

  it('remove が同じ実キーを消す', () => {
    const storage = fakeStorage();
    const store = createSessionStore(storage);
    store.set('draft', { body: 'x' });
    expect(storage.entries.size).toBe(1);
    store.remove('draft');
    expect(storage.entries.size).toBe(0);
    expect(store.get('draft')).toBeUndefined();
  });

  it('別のキーは互いに干渉しない', () => {
    const store = createSessionStore(fakeStorage());
    store.set('a', { v: 'first' });
    store.set('b', { v: 'second' });
    store.remove('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toEqual({ v: 'second' });
  });
});

describe('**用途ごとのキーが互いに衝突しない**', () => {
  /**
   * store に入る 4 つの用途。**この store は名前空間を足すだけで衝突を検出しない**ので、
   * 衝突すると `auth/sign-out.ts` が抑止印を書いた瞬間に、同じ実キーの下書きか
   * セッションを**黙って踏み潰す**。定数は 4 つのモジュールに分かれて住んでいるので、
   * 非衝突を主張できる場所は実キーを知っているこの層しかない。
   */
  const KEYS = [SESSION_KEY, PENDING_LOGIN_KEY, DRAFT_KEY, AUTO_SIGN_IN_SUPPRESSED_KEY];

  it('4 つの用途のキーが全部別で、実キーも 4 つの綴りと完全一致する', () => {
    expect(new Set(KEYS).size).toBe(4);
    expect(KEYS.map((key) => `${STORAGE_NAMESPACE}${key}`).sort()).toEqual([
      'blog.admin.auto-sign-in-suppressed',
      'blog.admin.draft',
      'blog.admin.pending-login',
      'blog.admin.session',
    ]);
  });
});

describe('set -> get が構造として往復する', () => {
  it.each([
    ['オブジェクト', { slug: 'hello', draft: false }],
    ['入れ子', { a: { b: { c: [1, 2, 3] } } }],
    ['空文字を含む', { title: '', body: '' }],
    ['日本語', { title: '記事を書く', body: 'これは本文である。' }],
    ['絵文字', { body: '🎉 と ünïcode' }],
    ['真偽値 false', { draft: false }],
    ['配列', ['a', 'b']],
  ])('%s', (_label, value) => {
    const store = createSessionStore(fakeStorage());
    store.set('k', value);
    expect(store.get('k')).toEqual(value);
  });

  it('保存していないキーは undefined', () => {
    expect(createSessionStore(fakeStorage()).get('nothing')).toBeUndefined();
  });
});

describe('**壊れていても投げない**', () => {
  it('壊れた JSON が入っていても get は undefined を返す', () => {
    const storage = fakeStorage();
    storage.entries.set('blog.admin.k', '{ this is not json');
    expect(() => createSessionStore(storage).get('k')).not.toThrow();
    expect(createSessionStore(storage).get('k')).toBeUndefined();
  });

  it('スキーマ版が違うレコードは undefined を返す（起動不能にならない）', () => {
    // 版を上げたときに、古いレコードを持ったタブが開けなくなってはいけない。
    const storage = fakeStorage();
    storage.entries.set('blog.admin.k', JSON.stringify({ v: 999, d: { a: 1 } }));
    expect(createSessionStore(storage).get('k')).toBeUndefined();
  });

  it.each([
    ['版が無い', JSON.stringify({ d: { a: 1 } })],
    ['スカラ', JSON.stringify('plain string')],
    ['配列', JSON.stringify([1, 2, 3])],
    ['null', 'null'],
    ['空文字', ''],
  ])('%s のレコードは undefined を返す', (_label, raw) => {
    const storage = fakeStorage();
    storage.entries.set('blog.admin.k', raw);
    expect(createSessionStore(storage).get('k')).toBeUndefined();
  });
});

describe('**ストレージが使えない環境でも落ちない**', () => {
  it('setItem が必ず投げる環境でも set() は投げない', () => {
    // **保存できないことでエディタが使えなくなってはいけない。**
    expect(() => createSessionStore(throwingStorage()).set('k', { a: 1 })).not.toThrow();
  });

  it('getItem が必ず投げる環境でも get() は undefined を返す', () => {
    expect(createSessionStore(throwingStorage()).get('k')).toBeUndefined();
  });

  it('removeItem が必ず投げる環境でも remove() は投げない', () => {
    expect(() => createSessionStore(throwingStorage()).remove('k')).not.toThrow();
  });

  it('ストレージそのものが無い環境でも作れて、投げずに動く', () => {
    // node 環境（この unit プロジェクト）には sessionStorage が無い。
    const store = createSessionStore(undefined);
    expect(() => store.set('k', { a: 1 })).not.toThrow();
    expect(store.get('k')).toBeUndefined();
    expect(() => store.remove('k')).not.toThrow();
  });
});
