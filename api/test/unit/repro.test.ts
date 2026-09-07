import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostPublisher } from '../../src/github/commit.ts';
import { dispatch } from '../../src/router.ts';
import type { Deps } from '../../src/deps.ts';

/**
 * 2026-09-07 の事故の再現。
 *
 * **偽の GitHub がファイルを実際に持つ。** ステータスコードだけを見ると
 * 「上書きされなかったこと」は確かめられない（409 を返しつつ書いてしまう実装も
 * ありうる）。tree に載ったパスを本当に書き換えて、内容で判定する。
 */
const ORIGINAL = '---\ntitle: "test"\n---\n\n元の本文\n';

const json = (p: unknown, s = 200) => new Response(JSON.stringify(p), { status: s });

const fakeGitHub = (files: Map<string, string>) => {
  let pendingTree: Array<{ path: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const p = new URL(String(input)).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);

      if (method === 'GET' && p.startsWith('/repos/o/r/contents/')) {
        const file = p.slice('/repos/o/r/contents/'.length);
        return files.has(file) ? json({ type: 'file', path: file }) : json({ message: 'Not Found' }, 404);
      }
      if (p === '/repos/o/r/git/ref/heads/main') return json({ object: { sha: 'base' } });
      if (p === '/repos/o/r/git/commits/base') return json({ tree: { sha: 'tree0' } });
      if (method === 'POST' && p === '/repos/o/r/git/blobs') return json({ sha: 'blob1' }, 201);
      if (method === 'POST' && p === '/repos/o/r/git/trees') {
        pendingTree = (body?.['tree'] ?? []) as Array<{ path: string }>;
        return json({ sha: 'tree1' }, 201);
      }
      if (method === 'POST' && p === '/repos/o/r/git/commits') {
        // **ここで実際に書く。** コミットが作られた時点でファイルが変わる。
        for (const entry of pendingTree) files.set(entry.path, `NEW: ${String(body?.['message'])}`);
        return json({ sha: 'commit1' }, 201);
      }
      if (method === 'PATCH') return json({ object: { sha: 'commit1' } });
      return json({ message: `unexpected ${method} ${p}` }, 599);
    }),
  );
};

const deps = (): Deps => ({
  authorizer: { authorize: async () => ({ ok: true as const, subject: 's' }) },
  publisher: createPostPublisher({
    tokenProvider: { getToken: async () => 't' },
    owner: 'o',
    repo: 'r',
    postsPathPrefix: 'posts/',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
  presigner: { presign: async () => ({ url: '', key: '', expiresIn: 0, requiredHeaders: {} }) },
  secretReader: { readPrivateKey: async () => 'PEM' },
  tokenProvider: { getToken: async () => 't' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authMode: 'cognito',
  now: () => 0,
});

const post = (extra: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    path: '/api/posts',
    headers: { 'content-type': 'application/json' },
    query: {},
    rawBody: JSON.stringify({
      slug: 'test',
      title: 'test5',
      description: 'test5',
      body: '本文',
      draft: false,
      ...extra,
    }),
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('2026-09-07 の事故の再現', () => {
  it('**既存の slug は 409 になり、記事の中身が 1 バイトも変わらない**', async () => {
    const files = new Map([['posts/test.md', ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post(), deps());
    expect(response.statusCode).toBe(409);
    expect(files.get('posts/test.md')).toBe(ORIGINAL);
  });

  it('偽の GitHub は本当に書き換える（上のテストが空虚でないことの対照）', async () => {
    // 承認して上書きすれば内容は変わる。変わらないなら偽物が壊れており、
    // 上のテストは何も確かめていないことになる。
    const files = new Map([['posts/test.md', ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post({ overwrite: true }), deps());
    expect(response.statusCode).toBe(201);
    expect(files.get('posts/test.md')).not.toBe(ORIGINAL);
    expect(files.get('posts/test.md')).toContain('更新');
  });

  it('新しい slug なら作成され、コミットメッセージは「追加」になる', async () => {
    const files = new Map([['posts/test.md', ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post({ slug: 'test6' }), deps());
    expect(response.statusCode).toBe(201);
    expect(files.get('posts/test.md')).toBe(ORIGINAL);
    expect(files.get('posts/test6.md')).toContain('追加');
  });
});
