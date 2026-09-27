import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { createApp } from '../../src/editor/app.ts';
import type { AuthTransport } from '../../src/auth/session.ts';
import { DRAFT_KEY } from '../../src/editor/draft-persistence.ts';
import { STORAGE_NAMESPACE, createSessionStore } from '../../src/storage/session-store.ts';
import type { WebStorageLike } from '../../src/storage/session-store.ts';

/** 実キー。**綴りを写さない** — 名前空間が変わったらここも一緒に動く。 */
const REAL_DRAFT_KEY = `${STORAGE_NAMESPACE}${DRAFT_KEY}`;

/**
 * 編集モードの DOM テスト。
 *
 * **主題は「新規投稿の経路に混ざらないこと」。** 編集は同じフォームを使い回すので、
 * 送信先・pubDate の可変性・下書きストアのどれか 1 つでも新規と共有すると、
 * 公開済みの記事か書きかけの新規記事のどちらかが静かに壊れる。
 */

const auth: AuthTransport = {
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => true,
};

interface Captured {
  url: string;
  init: RequestInit;
}

const mount = (): HTMLElement => {
  document.body.innerHTML = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<main'),
    INDEX_HTML.indexOf('</main>') + '</main>'.length,
  );
  const root = document.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('index.html から #editor を切り出せなかった');
  return root;
};

const json = (status: number, payload: unknown) => (): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const queueFetch = (
  responses: Array<() => Response>,
): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[calls.length - 1] ?? responses.at(-1);
    if (next === undefined) throw new Error('応答が用意されていない');
    return next();
  };
  return { calls, impl };
};

const SLUG = '2026/09/27/142621';
const PUB_DATE = '2026-09-27T05:26:21.486Z';

const SUMMARY = {
  slug: SLUG,
  title: '既存のタイトル',
  description: '既存の説明',
  pubDate: PUB_DATE,
  draft: false,
  tags: ['astro'],
  sha: 'blob-abc',
};

const DETAIL = { ...SUMMARY, body: '既存の本文' };

/** 一覧 -> 詳細 -> 更新 の 3 応答。 */
const editFlow = (): Array<() => Response> => [
  json(200, { posts: [SUMMARY], count: 1 }),
  json(200, DETAIL),
  json(200, { commitSha: 'c1', path: `posts/${SLUG}.md`, replaced: true, deployTriggered: true }),
];

const start = (
  root: HTMLElement,
  fetchImpl: typeof fetch,
  store?: ReturnType<typeof createSessionStore>,
): ReturnType<typeof createApp> =>
  createApp({
    root,
    auth,
    fetchImpl,
    origin: '',
    now: () => Date.parse('2026-09-28T00:00:00.000Z'),
    renderPreview: async () => '<p>preview</p>',
    ...(store === undefined ? {} : { store }),
  });

const click = (root: HTMLElement, selector: string): void => {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} が無い`);
  // **dispatchEvent を使う。** jsdom の .click() は disabled な要素では発火しない
  // ので、ボタンの見た目だけで緑になる（post-list.test.ts の教訓）。
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const value = (root: HTMLElement, id: string): string =>
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)?.value ?? '';

const set = (root: HTMLElement, id: string, next: string): void => {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (element === null) throw new Error(`#${id} が無い`);
  element.value = next;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const submit = (root: HTMLElement): void => {
  root
    .querySelector<HTMLFormElement>('#post-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

const statusText = (root: HTMLElement): string => root.querySelector('#status')?.textContent ?? '';

/** 一覧を読み込み、最初の行の「編集」を押して詳細が届くまで待つ。 */
const enterEditMode = async (root: HTMLElement, calls: Captured[]): Promise<void> => {
  click(root, '#post-list-reload');
  await vi.waitFor(() => {
    expect(root.querySelector('.post-list__edit')).not.toBeNull();
  });
  click(root, '.post-list__edit');
  await vi.waitFor(() => {
    expect(calls.length).toBe(2);
    expect(value(root, 'title')).toBe('既存のタイトル');
  });
};

const memoryStorage = (): WebStorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, v) => void map.set(key, v),
    removeItem: (key) => void map.delete(key),
  };
};

describe('編集モードに入る', () => {
  it('**一覧の「編集」で詳細が 1 回取得され、フォームに入る**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);

    expect(fetchSpy.calls[1]?.url).toBe(`/api/posts/detail?slug=${encodeURIComponent(SLUG)}`);
    expect(fetchSpy.calls[1]?.init.method).toBe('GET');
    expect(value(root, 'description')).toBe('既存の説明');
    expect(value(root, 'tags')).toBe('astro');
    expect(value(root, 'body')).toBe('既存の本文');
    expect(root.querySelector<HTMLInputElement>('#draft')?.checked).toBe(false);
  });

  it('**#pubDate が readOnly になる**（URL を動かせないことの UI 側の表明）', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(false);

    await enterEditMode(root, fetchSpy.calls);
    expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(true);
  });

  it('#pubDate に slug から戻した JST の壁時計が入る', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);
    // **前方一致で見る。** jsdom は datetime-local の値を `.000` 付きに正規化する。
    // 正確な書式は slugToWallClock の単体テスト（unit/draft-model.test.ts）の担当で、
    // ここで `.000` を書き込むと jsdom の癖をアサーションに焼き付けることになる。
    expect(value(root, 'pubDate').startsWith('2026-09-27T14:26:21')).toBe(true);
  });

  it('送信ボタンの文字が「更新する」に変わり、「新規に戻る」が現れる', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    expect(root.querySelector<HTMLButtonElement>('#new-post')?.hidden).toBe(true);

    await enterEditMode(root, fetchSpy.calls);
    expect(root.querySelector('#submit')?.textContent).toBe('更新する');
    expect(root.querySelector<HTMLButtonElement>('#new-post')?.hidden).toBe(false);
  });
});

describe('編集の送信', () => {
  it('**PUT で targetSlug と sha を送り、slug は送らない**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);

    set(root, 'title', '直したタイトル');
    submit(root);
    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBe(3);
    });

    const captured = fetchSpy.calls[2];
    expect(captured?.url).toBe('/api/posts');
    expect(captured?.init.method).toBe('PUT');
    const sent = JSON.parse(new TextDecoder().decode(captured?.init.body as Uint8Array));
    expect(sent).toEqual({
      targetSlug: SLUG,
      sha: 'blob-abc',
      title: '直したタイトル',
      description: '既存の説明',
      // **既存の値をそのまま送る。** datetime-local を往復させると ms が落ちて
      // api の「表記まで一致」検査に落ちる。
      pubDate: PUB_DATE,
      draft: false,
      tags: ['astro'],
      body: '既存の本文',
    });
    expect(Object.keys(sent)).not.toContain('slug');
  });

  it('成功すると「更新しました」が出る', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('更新しました');
    });
  });

  it('**編集モードでは下書きが保存されない**', async () => {
    const root = mount();
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl, store);

    // 新規の書きかけを 1 度保存させる。
    set(root, 'title', '書きかけ');
    const savedBefore = storage.getItem(REAL_DRAFT_KEY);
    expect(savedBefore).not.toBeNull();

    await enterEditMode(root, fetchSpy.calls);
    set(root, 'title', '編集中のタイトル');

    // **書きかけが上書きされていない。** 編集中の打鍵が保存されていたら壊れる。
    expect(storage.getItem(REAL_DRAFT_KEY)).toBe(savedBefore);
  });

  it('編集の成功で下書きが消えない（新規の書きかけを守る）', async () => {
    const root = mount();
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl, store);

    set(root, 'title', '書きかけ');
    const savedBefore = storage.getItem(REAL_DRAFT_KEY);

    await enterEditMode(root, fetchSpy.calls);
    submit(root);
    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBe(3);
    });

    expect(storage.getItem(REAL_DRAFT_KEY)).toBe(savedBefore);
  });
});

describe('新規に戻る', () => {
  it('readOnly が外れ、ボタンの文字が戻る', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);

    click(root, '#new-post');
    expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(false);
    expect(root.querySelector('#submit')?.textContent).toBe('公開する');
    expect(root.querySelector<HTMLButtonElement>('#new-post')?.hidden).toBe(true);
  });

  it('**保存されていた新規の書きかけが戻る**', async () => {
    const root = mount();
    const store = createSessionStore(memoryStorage());
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl, store);

    set(root, 'title', '書きかけ');
    await enterEditMode(root, fetchSpy.calls);
    expect(value(root, 'title')).toBe('既存のタイトル');

    click(root, '#new-post');
    expect(value(root, 'title')).toBe('書きかけ');
  });

  it('下書きが無ければ空のフォームに戻る', async () => {
    const root = mount();
    const fetchSpy = queueFetch(editFlow());
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);

    click(root, '#new-post');
    expect(value(root, 'title')).toBe('');
    expect(value(root, 'body')).toBe('');
  });

  it('戻ったあとの送信は POST に戻る', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, { posts: [SUMMARY], count: 1 }),
      json(200, DETAIL),
      json(201, { commitSha: 'c2', path: 'posts/2026/09/28/090000.md', replaced: false }),
    ]);
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);

    click(root, '#new-post');
    set(root, 'title', '新しい記事');
    set(root, 'description', '新しい説明');
    set(root, 'body', '新しい本文');
    submit(root);

    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBe(3);
    });
    expect(fetchSpy.calls[2]?.init.method).toBe('POST');
  });
});

describe('編集で返る 409 の文言', () => {
  const conflict = (code: string): Array<() => Response> => [
    json(200, { posts: [SUMMARY], count: 1 }),
    json(200, DETAIL),
    json(409, { error: code, field: code === 'would_starve_site' ? 'draft' : 'sha' }),
  ];

  it.each([
    ['stale_post', '読み直'],
    ['concurrent_update', '読み直'],
  ])('%s は「読み直せ」と伝える', async (code, expected) => {
    const root = mount();
    const fetchSpy = queueFetch(conflict(code));
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain(expected);
    });
  });

  it('would_starve_site は「公開記事が 0 本になる」と伝える', async () => {
    const root = mount();
    const fetchSpy = queueFetch(conflict('would_starve_site'));
    start(root, fetchSpy.impl);
    await enterEditMode(root, fetchSpy.calls);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('公開記事が 0 本');
    });
  });

  it('**上書きの確認は出ない**（slug_conflict の分岐と混ざっていない）', async () => {
    const root = mount();
    const fetchSpy = queueFetch(conflict('stale_post'));
    const confirm = vi.fn(() => true);
    createApp({
      root,
      auth,
      fetchImpl: fetchSpy.impl,
      origin: '',
      now: () => Date.parse('2026-09-28T00:00:00.000Z'),
      renderPreview: async () => '<p>preview</p>',
      confirm,
    });
    await enterEditMode(root, fetchSpy.calls);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('読み直');
    });
    expect(confirm).toHaveBeenCalledTimes(0);
    // **再送していない。** 3 回目で止まっている。
    expect(fetchSpy.calls.length).toBe(3);
  });
});
