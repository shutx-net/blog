import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { createApp } from '../../src/editor/app.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

const signedIn: AuthTransport = {
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => true,
};

const signedOut: AuthTransport = {
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => false,
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

const json = (status: number, payload: unknown) => (): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const queueFetch = (
  responses: Array<() => Response>,
): { calls: string[]; impl: typeof fetch } => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    const next = responses[calls.length - 1] ?? responses.at(-1);
    if (next === undefined) throw new Error('応答が用意されていない');
    return next();
  };
  return { calls, impl };
};

const start = (
  root: HTMLElement,
  fetchImpl: typeof fetch,
  auth: AuthTransport = signedIn,
): ReturnType<typeof createApp> =>
  createApp({
    root,
    auth,
    fetchImpl,
    origin: '',
    now: () => Date.parse('2026-08-31T02:30:00.000Z'),
    renderPreview: async () => '<p>preview</p>',
  });

const reload = (root: HTMLElement): void => {
  root.querySelector<HTMLButtonElement>('#post-list-reload')?.click();
};

const listStatus = (root: HTMLElement): string =>
  root.querySelector('#post-list-status')?.textContent ?? '';

const slugs = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('#post-list-items li')]
    .map((li) => (li as HTMLElement).dataset['slug'] ?? '')
    .filter((slug) => slug.length > 0);

const POSTS = [
  {
    slug: '2026/09/27/142621',
    title: 'test',
    description: 'testtesttest',
    pubDate: '2026-09-27T05:26:21.486Z',
    draft: false,
    tags: [],
    sha: 'blob-a',
  },
  {
    slug: '2026/08/01/090000',
    title: '下書きの記事',
    description: 'd',
    pubDate: '2026-08-01T00:00:00.000Z',
    draft: true,
    tags: [],
    sha: 'blob-b',
  },
];

describe('一覧の読み込み', () => {
  it('**起動しただけでは一覧 API を呼ばない**（既存の送信テストの呼び出し回数を動かさない）', () => {
    const root = mount();
    const spy = queueFetch([json(200, { posts: POSTS, count: POSTS.length })]);
    start(root, spy.impl);

    expect(spy.calls).toEqual([]);
  });

  it('**未認証では「更新」を押しても呼ばない**（401 を並べても意味が無い）', async () => {
    const root = mount();
    const spy = queueFetch([json(200, { posts: [], count: 0 })]);
    start(root, spy.impl, signedOut);

    reload(root);
    await vi.waitFor(() => expect(listStatus(root)).toContain('ログイン'));

    expect(spy.calls).toEqual([]);
  });

  it('認証済みで「更新」を押すと GET /api/posts を 1 回だけ呼び、記事が出る', async () => {
    const root = mount();
    const spy = queueFetch([json(200, { posts: POSTS, count: POSTS.length })]);
    start(root, spy.impl);

    reload(root);
    await vi.waitFor(() => expect(slugs(root)).toHaveLength(2));

    expect(spy.calls).toEqual(['/api/posts']);
    // 降順。**下書きも出る**（管理画面は下書きを見たい）。
    expect(slugs(root)).toEqual(['2026/09/27/142621', '2026/08/01/090000']);
    expect(root.querySelector('#post-list-items')?.textContent).toContain('下書き');
  });

  it('0 件のときは「まだ記事が無い」と出す（未読み込みと区別する）', async () => {
    const root = mount();
    const spy = queueFetch([json(200, { posts: [], count: 0 })]);
    start(root, spy.impl);

    // 押す前は「未読み込み」であって「0 件」ではない。
    expect(root.querySelector('#post-list-items')?.textContent ?? '').not.toContain('まだ記事が無い');

    reload(root);
    await vi.waitFor(() =>
      expect(root.querySelector('#post-list-items')?.textContent).toContain('まだ記事が無い'),
    );
  });

  it('**一覧が失敗してもフォームは使える**（記事は書けなければならない）', async () => {
    const root = mount();
    const spy = queueFetch([json(503, { error: 'auth_not_configured' })]);
    start(root, spy.impl);

    const submit = root.querySelector<HTMLButtonElement>('#submit');
    const set = (id: string, value: string): void => {
      const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
      if (element === null) throw new Error(`#${id} が無い`);
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('title', 'A title');
    set('description', 'A description');
    set('body', 'Body.');

    reload(root);
    await vi.waitFor(() => expect(listStatus(root)).toContain('認証が未設定'));

    // **失敗の行き先が違う。** 一覧の失敗は #problems（入力の指摘）にも
    // #status（送信の結果）にも混ざらない。
    expect(root.querySelectorAll('#problems li')).toHaveLength(0);
    expect(root.querySelector('#status')?.textContent ?? '').not.toContain('認証が未設定');
    expect(submit?.disabled).toBe(false);
  });

  it('連打しても重ねて呼ばない（読み込み中は押せない）', async () => {
    const root = mount();
    let resolveFirst: ((response: Response) => void) | undefined;
    const calls: string[] = [];
    const impl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    };
    start(root, impl);

    reload(root);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // 応答が返る前にもう一度押しても増えない。
    reload(root);
    reload(root);
    await Promise.resolve();
    expect(calls).toEqual(['/api/posts']);
    expect(root.querySelector<HTMLButtonElement>('#post-list-reload')?.disabled).toBe(true);

    resolveFirst?.(json(200, { posts: [], count: 0 })());
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>('#post-list-reload')?.disabled).toBe(false),
    );
  });

  it('**ボタンの disabled に頼らずに重複を止める**（Phase 4 は直接呼ぶ）', async () => {
    const root = mount();
    const calls: string[] = [];
    let resolveFirst: ((response: Response) => void) | undefined;
    const impl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    };
    start(root, impl);

    const button = root.querySelector<HTMLButtonElement>('#post-list-reload');
    button?.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // **`.click()` は disabled な要素では発火しない**ので、それだけでは
    // 「二重呼び出しを止めている」ことの証明にならない。`dispatchEvent` は
    // disabled でもリスナまで届くので、**中の見張り**を直接試せる。
    // Phase 4 が編集後に一覧を呼ぶのは、まさにこの「ボタンを経由しない」経路。
    expect(button?.disabled).toBe(true);
    button?.dispatchEvent(new Event('click', { bubbles: true }));
    button?.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(calls).toEqual(['/api/posts']);
    resolveFirst?.(json(200, { posts: [], count: 0 })());
  });
});
