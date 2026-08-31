import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import type { AuthTransport } from '../../src/auth/session.ts';
import { readFields } from '../../src/editor/bind.ts';
import { createApp } from '../../src/editor/app.ts';
import {
  applyDraftToForm,
  clearDraft,
  loadDraft,
  saveDraft,
} from '../../src/editor/draft-persistence.ts';
import type { DraftFields } from '../../src/editor/model.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const auth: AuthTransport = {
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => true,
};

const countingStorage = (): WebStorageLike & { writes: string[] } => {
  const entries = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const mount = (): HTMLElement => {
  document.body.innerHTML = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<main'),
    INDEX_HTML.indexOf('</main>') + '</main>'.length,
  );
  const root = document.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('index.html から #editor を切り出せなかった');
  return root;
};

const set = (root: HTMLElement, id: string, value: string): void => {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (element === null) throw new Error(`#${id} が無い`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const submit = (root: HTMLElement): void => {
  root
    .querySelector<HTMLFormElement>('#post-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

const stored = (root: HTMLElement, id: string): string =>
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)?.value ?? '';

const saved: DraftFields = {
  slug: 'restored-post',
  title: '復元されたタイトル',
  description: '復元された説明',
  pubDate: '2026-08-31T12:00',
  tags: 'aws, cognito',
  draft: false,
  body: '# 見出し\n\n復元された本文。',
};

const noPreview = async (): Promise<string> => '<p>preview</p>';

describe('**フォームの値が復元される**', () => {
  it('各 input / textarea の value が下書きから戻る', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    saveDraft(store, saved);

    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    // **textContent ではなく value を見る。**
    expect(stored(root, 'slug')).toBe(saved.slug);
    expect(stored(root, 'title')).toBe(saved.title);
    expect(stored(root, 'description')).toBe(saved.description);
    expect(stored(root, 'pubDate')).toBe(saved.pubDate);
    expect(stored(root, 'tags')).toBe(saved.tags);
    expect(stored(root, 'body')).toBe(saved.body);
  });

  it('**draft のチェックボックスが false のまま復元される**', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    saveDraft(store, saved);

    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    expect(root.querySelector<HTMLInputElement>('#draft')?.checked).toBe(false);
  });

  it('**復元が readFields と往復する**（フィールド id がずれていない）', () => {
    // applyDraftToForm が書く id と bind.ts の readFields が読む id が
    // ずれると、片方だけ復元されるという分かりにくい壊れ方をする。
    const root = mount();
    applyDraftToForm(root, saved);
    expect(readFields(root)).toEqual(saved);
  });

  it('下書きが無ければフォームは空のまま（既定は draft: true）', () => {
    const root = mount();
    createApp({
      root,
      auth,
      store: createSessionStore(countingStorage()),
      renderPreview: noPreview,
      now: () => Date.parse('2026-08-31T02:30:00.000Z'),
    });

    expect(stored(root, 'title')).toBe('');
    expect(root.querySelector<HTMLInputElement>('#draft')?.checked).toBe(true);
  });

  it('**復元が保存し直すループにならない**（復元直後の書き込みが 0 回）', () => {
    const root = mount();
    const storage = countingStorage();
    const store = createSessionStore(storage);
    saveDraft(store, saved);
    storage.writes.length = 0;

    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    expect(storage.writes).toEqual([]);
  });
});

describe('**打鍵のたびに保存される**', () => {
  it('#title に input を起こすと下書きが更新される', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    set(root, 'title', 'あたらしいタイトル');

    expect(loadDraft(store)?.title).toBe('あたらしいタイトル');
  });

  it('#body も保存される', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    set(root, 'body', '書きかけの本文');

    expect(loadDraft(store)?.body).toBe('書きかけの本文');
  });

  it('draft チェックボックスの変更も保存される', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    set(root, 'title', 'x');
    const checkbox = root.querySelector<HTMLInputElement>('#draft');
    if (checkbox === null) throw new Error('#draft が無い');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));

    expect(loadDraft(store)?.draft).toBe(false);
  });
});

describe('**公開に成功したら下書きを消す**', () => {
  const validFields = (root: HTMLElement): void => {
    set(root, 'slug', 'a-post');
    set(root, 'title', 'A title');
    set(root, 'description', 'A description');
    set(root, 'body', 'Body text.');
  };

  it('POST /api/posts が 200 なら下書きが消える', async () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({
      root,
      auth,
      store,
      renderPreview: noPreview,
      now: () => Date.parse('2026-08-31T02:30:00.000Z'),
      fetchImpl: async () =>
        new Response(JSON.stringify({ commitSha: 'abc', path: 'x.md' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    validFields(root);
    expect(loadDraft(store)).toBeDefined();

    submit(root);

    // 成功した記事の下書きが残り続けて、次に開いたときに復活するのを防ぐ。
    await vi.waitFor(() => {
      expect(loadDraft(store)).toBeUndefined();
    });
  });

  it('**失敗時は消さない**（書き直せなければならない）', async () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({
      root,
      auth,
      store,
      renderPreview: noPreview,
      now: () => Date.parse('2026-08-31T02:30:00.000Z'),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });

    validFields(root);
    submit(root);

    await vi.waitFor(() => {
      expect(root.querySelector('#status')?.textContent ?? '').not.toBe('送信中…');
    });
    expect(loadDraft(store)?.slug).toBe('a-post');
  });

  it('clearDraft の後に打鍵すればまた保存される', () => {
    const root = mount();
    const store = createSessionStore(countingStorage());
    createApp({ root, auth, store, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') });

    set(root, 'title', 'x');
    clearDraft(store);
    set(root, 'title', 'y');

    expect(loadDraft(store)?.title).toBe('y');
  });
});

describe('**ストレージが使えなくてもエディタは動く**', () => {
  const throwingStore = (): SessionStore =>
    createSessionStore({
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

  it('createApp が投げず、入力も動く', () => {
    const root = mount();
    expect(() =>
      createApp({ root, auth, store: throwingStore(), renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') }),
    ).not.toThrow();

    expect(() => set(root, 'title', 'まだ書ける')).not.toThrow();
    expect(stored(root, 'title')).toBe('まだ書ける');
  });

  it('送信も動く', async () => {
    const root = mount();
    const calls: string[] = [];
    createApp({
      root,
      auth,
      store: throwingStore(),
      renderPreview: noPreview,
      now: () => Date.parse('2026-08-31T02:30:00.000Z'),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ commitSha: 'a', path: 'b' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    set(root, 'slug', 'a-post');
    set(root, 'title', 'A title');
    set(root, 'description', 'A description');
    set(root, 'body', 'Body text.');
    submit(root);

    await vi.waitFor(() => {
      expect(calls).toEqual(['/api/posts']);
    });
  });

  it('store を渡さなくても動く（省略可能）', () => {
    const root = mount();
    expect(() => createApp({ root, auth, renderPreview: noPreview, now: () => Date.parse('2026-08-31T02:30:00.000Z') })).not.toThrow();
    expect(() => set(root, 'title', 'x')).not.toThrow();
  });
});
