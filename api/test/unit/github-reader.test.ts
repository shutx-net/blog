import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostNotFoundError, createPostReader } from '../../src/github/reader.ts';
import type { PostReader } from '../../src/deps.ts';

/**
 * 一覧・取得の検査。
 *
 * **偽の GitHub がファイルを実際に持つ**（`repro.test.ts` と同じ手法）。
 * 「200 が返る」だけを見ると、front matter を読めていない実装も通ってしまう。
 * blob の中身を本当に返させて、パースした値で判定する。
 */
const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status });

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const markdown = (title: string, extra: Record<string, string> = {}): string =>
  [
    '---',
    `title: "${title}"`,
    `description: "${title} の説明"`,
    `pubDate: "${extra['pubDate'] ?? '2026-09-27T05:26:21.486Z'}"`,
    `draft: ${extra['draft'] ?? 'false'}`,
    'tags: []',
    '---',
    '',
    `${title} の本文`,
    '',
  ].join('\n');

interface FakeOptions {
  /** パス -> 中身。tree と blob と contents の三方から同じ Map を見る。 */
  files: Map<string, string>;
  truncated?: boolean;
  /** contents 取得のステータスを差し替える（fail closed の検査用）。 */
  contentsStatus?: number;
  /** blob / contents の encoding を差し替える（1MB 超の罠の検査用）。 */
  encoding?: string;
  /** tree のエントリを直接差し替える（形の崩れた slug の検査用）。 */
  treeOverride?: Array<{ path: string; type: string; sha: string }>;
}

const fakeGitHub = (options: FakeOptions) => {
  const calls: Array<{ method: string; path: string }> = [];
  const shaFor = (path: string): string => `blob-${path}`;
  const byBlobSha = (): Map<string, string> =>
    new Map([...options.files].map(([path, text]) => [shaFor(path), text]));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      const p = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: `${p}${url.search}` });
      const encoding = options.encoding ?? 'base64';

      if (p === '/repos/o/r/git/ref/heads/main') return json({ object: { sha: 'base' } });
      if (p === '/repos/o/r/git/commits/base') return json({ tree: { sha: 'tree0' } });
      if (p === '/repos/o/r/git/trees/tree0') {
        const tree =
          options.treeOverride ??
          [...options.files.keys()].map((path) => ({ path, type: 'blob', sha: shaFor(path) }));
        return json({ sha: 'tree0', tree, truncated: options.truncated ?? false });
      }
      if (p.startsWith('/repos/o/r/git/blobs/')) {
        const sha = p.slice('/repos/o/r/git/blobs/'.length);
        const text = byBlobSha().get(sha);
        if (text === undefined) return json({ message: 'Not Found' }, 404);
        return json({ sha, content: b64(text), encoding });
      }
      if (p.startsWith('/repos/o/r/contents/')) {
        if (options.contentsStatus !== undefined) {
          return json({ message: 'nope' }, options.contentsStatus);
        }
        const file = decodeURIComponent(p.slice('/repos/o/r/contents/'.length));
        const text = options.files.get(file);
        if (text === undefined) return json({ message: 'Not Found' }, 404);
        return json({ type: 'file', path: file, sha: shaFor(file), content: b64(text), encoding });
      }
      return json({ message: `unexpected ${method} ${p}` }, 599);
    }),
  );

  return { calls };
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const reader = (): PostReader =>
  createPostReader({
    tokenProvider: { getToken: async () => 'ghs_token' },
    owner: 'o',
    repo: 'r',
    postsPathPrefix: 'posts/',
    logger,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('list: 記事の一覧', () => {
  it('**全記事の slug と front matter を返す**', async () => {
    fakeGitHub({
      files: new Map([
        ['posts/2026/09/27/142621.md', markdown('ひとつめ')],
        ['posts/2026/09/28/090000.md', markdown('ふたつめ', { draft: 'true' })],
      ]),
    });
    const posts = await reader().list();
    expect(posts.map((post) => post.slug)).toEqual(['2026/09/28/090000', '2026/09/27/142621']);
    expect(posts[1]?.title).toBe('ひとつめ');
    expect(posts[1]?.description).toBe('ひとつめ の説明');
    expect(posts[1]?.draft).toBe(false);
  });

  it('**下書きも含む**（管理画面は下書きを見たい）', async () => {
    fakeGitHub({
      files: new Map([['posts/2026/09/27/142621.md', markdown('内緒', { draft: 'true' })]]),
    });
    const posts = await reader().list();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.draft).toBe(true);
  });

  it('新しいものが先に来る（slug の降順）', async () => {
    fakeGitHub({
      files: new Map([
        ['posts/2026/01/01/000000.md', markdown('古い')],
        ['posts/2026/12/31/235959.md', markdown('新しい')],
        ['posts/2026/06/15/120000.md', markdown('途中')],
      ]),
    });
    expect((await reader().list()).map((post) => post.title)).toEqual(['新しい', '途中', '古い']);
  });

  it('**返り値に blob の sha が入る**（Phase 4 の並行制御トークン）', async () => {
    fakeGitHub({ files: new Map([['posts/2026/09/27/142621.md', markdown('t')]]) });
    expect((await reader().list())[0]?.sha).toBe('blob-posts/2026/09/27/142621.md');
  });

  it('**truncated: true なら throw する（fail closed）**', async () => {
    // 切り詰めを「記事が無い」と読むと一覧が嘘をつく。
    fakeGitHub({
      files: new Map([['posts/2026/09/27/142621.md', markdown('t')]]),
      truncated: true,
    });
    await expect(reader().list()).rejects.toThrow(/truncated/i);
  });

  it('postsPathPrefix の外のファイルを拾わない', async () => {
    fakeGitHub({
      files: new Map([
        ['posts/2026/09/27/142621.md', markdown('記事')],
        ['README.md', '# readme'],
        ['docs/2026/09/27/142621.md', markdown('別ディレクトリ')],
      ]),
    });
    const posts = await reader().list();
    expect(posts.map((post) => post.title)).toEqual(['記事']);
  });

  it('.md 以外を拾わない', async () => {
    fakeGitHub({
      files: new Map([
        ['posts/2026/09/27/142621.md', markdown('記事')],
        ['posts/.gitkeep', ''],
        ['posts/2026/09/27/142621.txt', 'ちがう'],
      ]),
    });
    expect((await reader().list()).map((post) => post.title)).toEqual(['記事']);
  });

  it('tree の blob 以外（サブディレクトリのエントリ）を拾わない', async () => {
    fakeGitHub({
      files: new Map([['posts/2026/09/27/142621.md', markdown('記事')]]),
      treeOverride: [
        { path: 'posts/2026', type: 'tree', sha: 'sub' },
        { path: 'posts/2026/09/27/142621.md', type: 'blob', sha: 'blob-posts/2026/09/27/142621.md' },
      ],
    });
    expect((await reader().list())).toHaveLength(1);
  });

  it('**形の合わない slug で throw する**（content repo に想定外の形が入った合図）', async () => {
    fakeGitHub({
      files: new Map([['posts/hello-world.md', markdown('平坦')]]),
    });
    await expect(reader().list()).rejects.toThrow(/slug/);
  });

  it('**encoding が base64 でなければ throw する**（1MB 超で content が空になる罠）', async () => {
    fakeGitHub({
      files: new Map([['posts/2026/09/27/142621.md', markdown('t')]]),
      encoding: 'none',
    });
    await expect(reader().list()).rejects.toThrow(/encoding/);
  });

  it('記事が 0 本でも空配列を返す（throw しない）', async () => {
    fakeGitHub({ files: new Map([['README.md', '# readme']]) });
    expect(await reader().list()).toEqual([]);
  });

  it('**リクエスト本数が 3 + 記事数である**（N+1 を自覚的に固定する）', async () => {
    // ref -> commit -> tree の 3 本に、記事 1 本あたり blob 1 本。
    // 増えたらここが落ちる。無自覚に呼び出しが増えるのを防ぐための主張。
    const files = new Map([
      ['posts/2026/09/27/142621.md', markdown('a')],
      ['posts/2026/09/28/090000.md', markdown('b')],
      ['posts/2026/09/29/090000.md', markdown('c')],
    ]);
    const { calls } = fakeGitHub({ files });
    await reader().list();
    expect(calls).toHaveLength(3 + files.size);
    expect(calls.filter((call) => call.path.startsWith('/repos/o/r/git/blobs/'))).toHaveLength(3);
  });

  it('tree は ?recursive=1 で取る（既定は最上位だけ）', async () => {
    const { calls } = fakeGitHub({ files: new Map([['posts/2026/09/27/142621.md', markdown('t')]]) });
    await reader().list();
    expect(calls.some((call) => call.path === '/repos/o/r/git/trees/tree0?recursive=1')).toBe(true);
  });

  it('**書き込みを 1 本も出さない**', async () => {
    const { calls } = fakeGitHub({ files: new Map([['posts/2026/09/27/142621.md', markdown('t')]]) });
    await reader().list();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('read: 1 記事の取得', () => {
  const FILE = 'posts/2026/09/27/142621.md';

  it('front matter と本文と sha を返す', async () => {
    fakeGitHub({ files: new Map([[FILE, markdown('よむ')]]) });
    const post = await reader().read('2026/09/27/142621');
    expect(post.slug).toBe('2026/09/27/142621');
    expect(post.title).toBe('よむ');
    expect(post.body).toBe('よむ の本文\n');
    expect(post.sha).toBe(`blob-${FILE}`);
  });

  it('**不在は PostNotFoundError**', async () => {
    fakeGitHub({ files: new Map() });
    await expect(reader().read('2026/09/27/142621')).rejects.toThrow(PostNotFoundError);
  });

  it.each([403, 500, 502])('**%i を「無い」と読まない（fail closed）**', async (status) => {
    // 権限が落ちた日に「記事が消えた」と表示するのは、消えたと誤認させるだけでなく
    // Phase 5 の削除判定（公開可能数の床）を誤らせる。
    fakeGitHub({ files: new Map([[FILE, markdown('t')]]), contentsStatus: status });
    const promise = reader().read('2026/09/27/142621');
    await expect(promise).rejects.toThrow(new RegExp(String(status)));
    await expect(promise).rejects.not.toThrow(PostNotFoundError);
  });

  it('**形の合わない slug は GitHub を呼ぶ前に落ちる**', async () => {
    const { calls } = fakeGitHub({ files: new Map([[FILE, markdown('t')]]) });
    await expect(reader().read('../../etc/passwd')).rejects.toThrow(/slug/);
    expect(calls).toHaveLength(0);
  });

  it.each(['..', 'hello-world', '2026/9/8/54001', '2026/09/27/142621.md'])(
    'traversal と形崩れ %o を拒む',
    async (slug) => {
      const { calls } = fakeGitHub({ files: new Map([[FILE, markdown('t')]]) });
      await expect(reader().read(slug)).rejects.toThrow(/slug/);
      expect(calls).toHaveLength(0);
    },
  );

  it('**encoding が base64 でなければ throw する**', async () => {
    fakeGitHub({ files: new Map([[FILE, markdown('t')]]), encoding: 'none' });
    await expect(reader().read('2026/09/27/142621')).rejects.toThrow(/encoding/);
  });

  it('**書き込みを 1 本も出さない**', async () => {
    const { calls } = fakeGitHub({ files: new Map([[FILE, markdown('t')]]) });
    await reader().read('2026/09/27/142621');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('**ログにトークンが出ない**', async () => {
    fakeGitHub({ files: new Map([[FILE, markdown('t')]]) });
    await reader().read('2026/09/27/142621');
    await reader().list();
    const logged = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain('ghs_token');
  });
});
