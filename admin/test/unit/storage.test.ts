import { describe, expect, it } from 'vitest';

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
