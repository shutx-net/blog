import { describe, expect, it } from 'vitest';

import { beginSignIn, signOut } from '../../src/auth/session.ts';
import {
  DRAFT_KEY,
  clearDraft,
  isEmptyDraft,
  loadDraft,
  saveDraft,
} from '../../src/editor/draft-persistence.ts';
import { emptyDraft } from '../../src/editor/model.ts';
import type { DraftFields } from '../../src/editor/model.ts';
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

const typed = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  slug: 'a-post',
  title: '記事のタイトル',
  description: '説明',
  pubDate: '2026-08-31T12:00',
  tags: 'aws, cognito',
  draft: true,
  body: '# 見出し\n\n本文である。',
  ...overrides,
});

describe('saveDraft -> loadDraft', () => {
  it('7 フィールドすべてが往復する', () => {
    const store = newStore();
    saveDraft(store, typed());
    expect(loadDraft(store)).toEqual(typed());
  });

  it('**draft: false が true に化けない**', () => {
    // 真偽値の欠落が既定 true に落ちると「公開のつもりが下書き」になる。
    const store = newStore();
    saveDraft(store, typed({ draft: false }));
    expect(loadDraft(store)?.draft).toBe(false);
  });

  it('draft: true も保たれる', () => {
    const store = newStore();
    saveDraft(store, typed({ draft: true }));
    expect(loadDraft(store)?.draft).toBe(true);
  });

  it.each([
    ['日本語と改行', { body: '一行目\n\n二行目\n- 箇条書き' }],
    ['絵文字', { title: '🎉 リリース' }],
    ['空文字を含む', { description: '', tags: '' }],
    ['Markdown の記号', { body: '`code` **bold** [link](/a)' }],
  ])('%s が往復する', (_label, overrides) => {
    const store = newStore();
    saveDraft(store, typed(overrides));
    expect(loadDraft(store)).toEqual(typed(overrides));
  });
});

describe('**空の下書きは保存しない**', () => {
  it('emptyDraft() は保存されない', () => {
    // 開いただけのタブが古い下書きを上書きしないこと。
    const store = newStore();
    saveDraft(store, emptyDraft());
    expect(store.get(DRAFT_KEY)).toBeUndefined();
    expect(loadDraft(store)).toBeUndefined();
  });

  it('既に下書きがあるとき、空の下書きで消しにいかない', () => {
    const store = newStore();
    saveDraft(store, typed());
    saveDraft(store, emptyDraft());
    // **上書きも削除もしない。** 開いただけのタブに壊させない。
    expect(loadDraft(store)).toEqual(typed());
  });

  it('isEmptyDraft が emptyDraft() に対して true', () => {
    expect(isEmptyDraft(emptyDraft())).toBe(true);
  });

  it.each([
    ['slug だけ', { slug: 'x' }],
    ['body だけ', { body: 'x' }],
    ['draft が false', { draft: false }],
    ['pubDate だけ', { pubDate: '2026-01-01T00:00' }],
  ])('%s でも「空ではない」と判定される', (_label, overrides) => {
    expect(isEmptyDraft({ ...emptyDraft(), ...overrides })).toBe(false);
  });

  it('1 文字でも入れば保存される', () => {
    const store = newStore();
    saveDraft(store, { ...emptyDraft(), title: 'あ' });
    expect(loadDraft(store)?.title).toBe('あ');
  });
});

describe('**壊れていても投げない**（復元に失敗してもエディタは開ける）', () => {
  it.each([
    ['壊れたレコード', { slug: 123 }],
    ['draft が欠けている', { slug: '', title: '', description: '', pubDate: '', tags: '', body: '' }],
    ['draft が文字列', { ...typed(), draft: 'true' }],
    ['body が欠けている', { slug: 'x', title: '', description: '', pubDate: '', tags: '', draft: true }],
    ['空オブジェクト', {}],
    ['配列', [1, 2]],
    ['文字列', 'nope'],
  ])('%s は undefined', (_label, record) => {
    const store = newStore();
    store.set(DRAFT_KEY, record);
    expect(() => loadDraft(store)).not.toThrow();
    expect(loadDraft(store)).toBeUndefined();
  });

  it('保存していなければ undefined', () => {
    expect(loadDraft(newStore())).toBeUndefined();
  });

  it('ストレージが投げても saveDraft は投げない', () => {
    const throwing = createSessionStore({
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
    expect(() => saveDraft(throwing, typed())).not.toThrow();
    expect(loadDraft(throwing)).toBeUndefined();
  });
});

describe('clearDraft', () => {
  it('保存した下書きを消す', () => {
    const store = newStore();
    saveDraft(store, typed());
    clearDraft(store);
    expect(loadDraft(store)).toBeUndefined();
  });

  it('下書きが無くても投げない', () => {
    expect(() => clearDraft(newStore())).not.toThrow();
  });
});

/**
 * **攻撃 8「リダイレクトで下書きが消える」— このフェーズで最も重要な 1 件。**
 *
 * 順序（保存が先・遷移が後）を、コードの並びではなく**観測**で固定する。
 * 偽 `redirect` の中から store を読むので、実装がどちらの形でも正しく検出できる。
 */
describe('**攻撃 8: リダイレクトを跨いで下書きが生き残る**', () => {
  it('beginSignIn の redirect が呼ばれた時点で下書きが既に store にある', async () => {
    const store = newStore();
    const fields = typed();
    let seenAtRedirect: DraftFields | undefined;

    // app.ts と同じ順序: **保存してから** beginSignIn を呼ぶ。
    saveDraft(store, fields);
    await beginSignIn({
      store,
      now: () => 1_800_000_000_000,
      random: () => new Uint8Array(32).fill(2),
      origin: 'https://d8gsxbwzr6ft8.cloudfront.net',
      redirect: () => {
        seenAtRedirect = loadDraft(store);
      },
    });

    expect(seenAtRedirect).toEqual(fields);
  });

  it('ログイン開始は下書きを消さない', async () => {
    const store = newStore();
    saveDraft(store, typed());
    await beginSignIn({
      store,
      now: () => 1_800_000_000_000,
      random: () => new Uint8Array(32).fill(2),
      origin: 'https://d8gsxbwzr6ft8.cloudfront.net',
      redirect: () => {},
    });
    expect(loadDraft(store)).toEqual(typed());
  });

  it('**サインアウトの遷移でも下書きは残る**（下書き側からも掛けておく）', async () => {
    const store = newStore();
    saveDraft(store, typed());
    let seenAtRedirect: DraftFields | undefined;

    await signOut({
      store,
      origin: 'https://d8gsxbwzr6ft8.cloudfront.net',
      redirect: () => {
        seenAtRedirect = loadDraft(store);
      },
      fetchImpl: async () => new Response('', { status: 200 }),
    });

    expect(seenAtRedirect).toEqual(typed());
    expect(loadDraft(store)).toEqual(typed());
  });
});
