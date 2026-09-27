import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { createApp } from '../../src/editor/app.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

/**
 * 削除の DOM テスト。
 *
 * **主題は「押しただけでは消えないこと」。** 削除は取り消せない唯一の操作なので、
 * 確認を通らない経路でリクエストが飛ばないことを、`fetch` の呼び出し回数で見る。
 * 文言や見た目ではなく**通信が起きていないこと**が主張の中身である。
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
const OTHER_SLUG = '2026/09/26/101010';

const summary = (slug: string, title: string) => ({
  slug,
  title,
  description: `${title} の説明`,
  pubDate: `${slug.slice(0, 10).replaceAll('/', '-')}T00:00:00.000Z`,
  draft: false,
  tags: [],
  sha: `blob-${slug}`,
});

const LIST = { posts: [summary(SLUG, '対象'), summary(OTHER_SLUG, 'ほか')], count: 2 };

/** 一覧 -> 削除 -> 再読込 の 3 応答。 */
const deleteFlow = (): Array<() => Response> => [
  json(200, LIST),
  json(200, { commitSha: 'c1', path: `posts/${SLUG}.md`, replaced: true, deployTriggered: true }),
  json(200, { posts: [summary(OTHER_SLUG, 'ほか')], count: 1 }),
];

const start = (
  root: HTMLElement,
  fetchImpl: typeof fetch,
  confirmImpl?: (message: string) => boolean,
): ReturnType<typeof createApp> =>
  createApp({
    root,
    auth,
    fetchImpl,
    origin: '',
    now: () => Date.parse('2026-09-28T00:00:00.000Z'),
    renderPreview: async () => '<p>preview</p>',
    ...(confirmImpl === undefined ? {} : { confirm: confirmImpl }),
  });

const click = (root: HTMLElement, selector: string): void => {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} が無い`);
  // **dispatchEvent を使う。** jsdom の .click() は disabled な要素では発火しない。
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const listStatus = (root: HTMLElement): string =>
  root.querySelector('#post-list-status')?.textContent ?? '';

/** 一覧を読み込み、行が描かれるまで待つ。 */
const loadList = async (root: HTMLElement, calls: Captured[]): Promise<void> => {
  click(root, '#post-list-reload');
  await vi.waitFor(() => {
    expect(calls.length).toBe(1);
    expect(root.querySelectorAll('.post-list__delete')).toHaveLength(2);
  });
};

describe('削除の確認', () => {
  it('**「削除」で確認が 1 回呼ばれ、slug が文言に入る**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    const confirmSpy = vi.fn((_message: string) => false);
    start(root, fetchSpy.impl, confirmSpy);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain(SLUG);
  });

  it('**文言が「履歴には残るがサイトからは消える」ことを伝える**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    const confirmSpy = vi.fn((_message: string) => false);
    start(root, fetchSpy.impl, confirmSpy);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    const message = String(confirmSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('履歴');
    expect(message).toContain('サイト');
  });

  it('**承認しなければ DELETE が飛ばない**（fail closed）', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    start(root, fetchSpy.impl, () => false);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    await vi.waitFor(() => {
      expect(listStatus(root)).not.toBe('');
    });
    // **一覧の 1 本だけ。** DELETE が増えていない。
    expect(fetchSpy.calls).toHaveLength(1);
  });

  it('**confirm を注入せず globalThis.confirm も無ければ DELETE が飛ばない**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    // jsdom は window.confirm を「未実装」として持つので、消して「無い」状態を作る。
    const original = globalThis.confirm;
    delete (globalThis as { confirm?: unknown }).confirm;
    try {
      start(root, fetchSpy.impl);
      await loadList(root, fetchSpy.calls);
      click(root, '.post-list__delete');
      await vi.waitFor(() => {
        expect(listStatus(root)).not.toBe('');
      });
      expect(fetchSpy.calls).toHaveLength(1);
    } finally {
      globalThis.confirm = original;
    }
  });
});

describe('削除の実行', () => {
  it('**承認すると DELETE が 1 回、slug と sha がクエリに入る**', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    start(root, fetchSpy.impl, () => true);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBeGreaterThanOrEqual(2);
    });

    const call = fetchSpy.calls[1]!;
    expect(call.init.method).toBe('DELETE');
    const url = new URL(call.url, 'https://example.invalid');
    expect(url.pathname).toBe('/api/posts');
    expect(url.searchParams.get('slug')).toBe(SLUG);
    expect(url.searchParams.get('sha')).toBe(`blob-${SLUG}`);
    // **ボディを付けない。** 経路上の中間装置がボディ付き DELETE を落としうる。
    expect(call.init.body).toBeUndefined();
  });

  it('**成功したら一覧を読み直す**（消えた行が残らない）', async () => {
    const root = mount();
    const fetchSpy = queueFetch(deleteFlow());
    start(root, fetchSpy.impl, () => true);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    await vi.waitFor(() => {
      expect(root.querySelectorAll('.post-list__delete')).toHaveLength(1);
    });
    expect(fetchSpy.calls).toHaveLength(3);
    expect(fetchSpy.calls[2]?.init.method).toBe('GET');
  });

  it('**409 would_starve_site は理由だけを出し、確認を出し直さない**', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, LIST),
      json(409, { error: 'would_starve_site', field: 'slug' }),
    ]);
    const confirmSpy = vi.fn((_message: string) => true);
    start(root, fetchSpy.impl, confirmSpy);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__delete');
    await vi.waitFor(() => {
      expect(listStatus(root)).toContain('公開記事が 0 本');
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // **行が残る。** 消えていないので一覧を読み直さない。
    expect(root.querySelectorAll('.post-list__delete')).toHaveLength(2);
  });

  it('**編集中の記事を削除したら新規モードに戻る**', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, LIST),
      json(200, { ...summary(SLUG, '対象'), body: '既存の本文' }),
      json(200, { commitSha: 'c1', path: `posts/${SLUG}.md`, replaced: true }),
      json(200, { posts: [summary(OTHER_SLUG, 'ほか')], count: 1 }),
    ]);
    start(root, fetchSpy.impl, () => true);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__edit');
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(true);
    });

    click(root, '.post-list__delete');
    await vi.waitFor(() => {
      // **編集モードの痕跡が消える。** 残すと、次の送信が消えた記事を更新しようとする。
      expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(false);
    });
    expect(root.querySelector('#submit')?.textContent).toBe('公開する');
  });

  it('編集中でない記事を削除しても編集モードは続く', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, LIST),
      json(200, { ...summary(SLUG, '対象'), body: '既存の本文' }),
      json(200, { commitSha: 'c1', path: `posts/${OTHER_SLUG}.md`, replaced: true }),
      json(200, { posts: [summary(SLUG, '対象')], count: 1 }),
    ]);
    start(root, fetchSpy.impl, () => true);
    await loadList(root, fetchSpy.calls);

    click(root, '.post-list__edit');
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(true);
    });

    // 2 行目（ほか）の削除を押す。
    const buttons = root.querySelectorAll<HTMLElement>('.post-list__delete');
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBeGreaterThanOrEqual(3);
    });
    expect(root.querySelector<HTMLInputElement>('#pubDate')?.readOnly).toBe(true);
  });
});
