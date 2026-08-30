import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { createApp } from '../../src/editor/app.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

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

const set = (root: HTMLElement, id: string, value: string): void => {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (element === null) throw new Error(`#${id} が無い`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

/** 有効な記事を埋める。 */
const fillValid = (root: HTMLElement): void => {
  set(root, 'slug', 'a-post');
  set(root, 'title', 'A title');
  set(root, 'description', 'A description');
  set(root, 'body', 'Body text.');
};

const submit = (root: HTMLElement): void => {
  root
    .querySelector<HTMLFormElement>('#post-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

const statusText = (root: HTMLElement): string => root.querySelector('#status')?.textContent ?? '';

/** 応答を順に返す fetch のスパイ。 */
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

const json = (status: number, payload: unknown) => (): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 実パイプラインを使わない（描画は 4.11 で見ている。ここは送信が主題）。 */
const start = (root: HTMLElement, fetchImpl: typeof fetch): ReturnType<typeof createApp> =>
  createApp({
    root,
    auth,
    fetchImpl,
    origin: '',
    now: () => Date.parse('2026-08-31T02:30:00.000Z'),
    renderPreview: async () => '<p>preview</p>',
  });

describe('送信', () => {
  it('**POST /api/posts が 1 回だけ呼ばれ、body が validateDraft の結果である**', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(201, { commitSha: 'abc123', path: 'site/src/content/posts/a-post.md' })]);
    start(root, fetchSpy.impl);
    fillValid(root);
    set(root, 'tags', 'astro, nix');
    submit(root);

    await vi.waitFor(() => {
      expect(fetchSpy.calls.length).toBe(1);
    });

    const captured = fetchSpy.calls[0];
    expect(captured?.url).toBe('/api/posts');
    expect(captured?.init.method).toBe('POST');
    expect(JSON.parse(new TextDecoder().decode(captured?.init.body as Uint8Array))).toEqual({
      slug: 'a-post',
      title: 'A title',
      description: 'A description',
      pubDate: '2026-08-31T02:30:00.000Z',
      draft: true,
      tags: ['astro', 'nix'],
      body: 'Body text.',
    });
  });

  it('検証エラーがある状態では送信されない（fetch が 0 回）', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(201, {})]);
    start(root, fetchSpy.impl);
    set(root, 'slug', 'Bad Slug');
    submit(root);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('**送信中は二重送信できない**（連打しても fetch は 1 回）', async () => {
    const root = mount();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Captured[] = [];
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      await gate;
      return json(201, { commitSha: 'a', path: 'p' })();
    };

    const root2 = root;
    start(root2, impl);
    fillValid(root2);

    submit(root2);
    submit(root2);
    submit(root2);

    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(calls.length).toBe(1);
    expect(root2.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(true);

    release?.();
    await vi.waitFor(() => {
      expect(statusText(root2)).toContain('abc'.slice(0, 0) + '公開しました');
    });
  });
});

describe('応答の読み替え', () => {
  it('201 のとき commitSha と path を表示する', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(201, { commitSha: 'abc123', path: 'site/src/content/posts/a-post.md' }),
    ]);
    start(root, fetchSpy.impl);
    fillValid(root);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('abc123');
    });
    expect(statusText(root)).toContain('site/src/content/posts/a-post.md');
    expect(root.querySelector('#status')?.getAttribute('data-kind')).toBe('ok');
  });

  it('503 auth_not_configured のとき「認証が未設定」と表示する', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(503, { error: 'auth_not_configured' })]);
    start(root, fetchSpy.impl);
    fillValid(root);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('認証が未設定');
    });
    expect(root.querySelector('#status')?.getAttribute('data-kind')).toBe('error');
  });

  it('**404 のとき x-amz-content-sha256 の専用文言を出す**', async () => {
    // Phase 3 で 1 度踏んだ罠。403（署名失敗）が CustomErrorResponses で
    // 404 の HTML に化けるので、404 は「経路が無い」ではなく
    // 「署名が失敗した」と読む。UI にその知識を埋め込む。
    const root = mount();
    const fetchSpy = queueFetch([
      () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
    ]);
    start(root, fetchSpy.impl);
    fillValid(root);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('x-amz-content-sha256');
    });
  });

  it('400 invalid_post の field が該当フィールドの近くに出る', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(400, { error: 'invalid_post', field: 'slug' })]);
    start(root, fetchSpy.impl);
    fillValid(root);
    submit(root);

    await vi.waitFor(() => {
      const item = root.querySelector('#problems li[data-field="slug"]');
      expect(item).not.toBeNull();
    });
  });

  it('送信が終われば再び送信できる', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(503, { error: 'auth_not_configured' })]);
    start(root, fetchSpy.impl);
    fillValid(root);
    submit(root);

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('認証が未設定');
    });
    expect(root.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(false);
  });
});

describe('画像アップロード', () => {
  /** `<input type="file">` に File を載せる。jsdom は files を直接代入できない。 */
  const attach = (root: HTMLElement, file: File): void => {
    const input = root.querySelector<HTMLInputElement>('#image');
    if (input === null) throw new Error('#image が無い');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const pngFile = (size = 4): File =>
    new File([new Uint8Array(size)], 'photo.png', { type: 'image/png' });

  it('**presign -> PUT -> 本文への挿入がこの順に起きる**', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, {
        url: 'https://bucket.s3.ap-northeast-1.amazonaws.com/media/2026/08/ab.png?sig=x',
        key: 'media/2026/08/ab.png',
        expiresIn: 900,
        requiredHeaders: { 'content-type': 'image/png', 'content-length': '4' },
      }),
      () => new Response('', { status: 200 }),
    ]);
    start(root, fetchSpy.impl);
    fillValid(root);
    attach(root, pngFile());

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLTextAreaElement>('#body')?.value).toContain(
        '![photo.png](/media/2026/08/ab.png)',
      );
    });

    expect(fetchSpy.calls.map((call) => call.url)).toEqual([
      '/api/media/presign',
      'https://bucket.s3.ap-northeast-1.amazonaws.com/media/2026/08/ab.png?sig=x',
    ]);
    expect(fetchSpy.calls[1]?.init.method).toBe('PUT');
  });

  it('**PUT が失敗したら本文を書き換えない**', async () => {
    const root = mount();
    const fetchSpy = queueFetch([
      json(200, {
        url: 'https://bucket.s3.example/media/2026/08/ab.png?sig=x',
        key: 'media/2026/08/ab.png',
        expiresIn: 900,
        requiredHeaders: { 'content-type': 'image/png', 'content-length': '4' },
      }),
      () => new Response('<Error/>', { status: 403 }),
    ]);
    start(root, fetchSpy.impl);
    fillValid(root);
    const before = root.querySelector<HTMLTextAreaElement>('#body')?.value;
    attach(root, pngFile());

    await vi.waitFor(() => {
      expect(statusText(root)).toContain('アップロード');
    });
    expect(root.querySelector<HTMLTextAreaElement>('#body')?.value).toBe(before);
  });

  it('presign が失敗したら PUT に進まない', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(503, { error: 'auth_not_configured' })]);
    start(root, fetchSpy.impl);
    fillValid(root);
    attach(root, pngFile());

    // **失敗の表示を待つ。** 「status が空でない」で待つと、送信前に出る
    // 『画像をアップロード中…』で先に解決してしまい、fetch が 0 回のまま
    // 通ってしまう（実際に踏んだ）。
    await vi.waitFor(() => {
      expect(statusText(root)).toContain('失敗');
    });
    // presign の 1 回だけ。PUT には進んでいない。
    expect(fetchSpy.calls.length).toBe(1);
    expect(fetchSpy.calls[0]?.url).toBe('/api/media/presign');
  });

  it('許可外の content type は presign を呼ばずに拒否する', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(200, {})]);
    start(root, fetchSpy.impl);
    fillValid(root);
    attach(root, new File([new Uint8Array(4)], 'x.svg', { type: 'image/svg+xml' }));

    await vi.waitFor(() => {
      expect(statusText(root).length).toBeGreaterThan(0);
    });
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('10 MiB 超は presign を呼ばずに拒否する', async () => {
    const root = mount();
    const fetchSpy = queueFetch([json(200, {})]);
    start(root, fetchSpy.impl);
    fillValid(root);
    // 実バイトを確保せずに size だけ大きい File を作る。
    const big = pngFile(1);
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    attach(root, big);

    await vi.waitFor(() => {
      expect(statusText(root).length).toBeGreaterThan(0);
    });
    expect(fetchSpy.calls.length).toBe(0);
  });
});
