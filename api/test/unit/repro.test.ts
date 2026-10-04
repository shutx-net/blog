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
        // **sha を返す。** 本物の Contents API は必ず返し、更新経路はこの値を
        // 楽観的並行制御に使う。省いた偽物は「本物なら通らない実装」を通してしまう。
        return files.has(file)
          ? json({ type: 'file', path: file, sha: `blob-${file}` })
          : json({ message: 'Not Found' }, 404);
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
  // このファイルは書き込み経路の再現なので、読み取りは呼ばれないことを型で満たすだけ。
  // **呼ばれたら落ちるようにしておく**（黙って空の一覧を返すと、将来ここに
  // 読み取りが混ざったときに気づけない）。
  reader: {
    list: async () => {
      throw new Error('reader.list must not be called on the write path');
    },
    read: async () => {
      throw new Error('reader.read must not be called on the write path');
    },
  },
  presigner: { presign: async () => ({ url: '', key: '', expiresIn: 0, requiredHeaders: {} }) },
  secretReader: { readPrivateKey: async () => 'PEM' },
  tokenProvider: { getToken: async () => 't' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authMode: 'cognito',
  now: () => 0,
});

/**
 * **slug は送らない。** 導出値なので、送ると 400 になる。
 * 書き込み先を決めたいときは `pubDate` を渡す。
 */
const post = (extra: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    path: '/api/posts',
    headers: { 'content-type': 'application/json' },
    query: {},
    rawBody: JSON.stringify({
      title: 'test5',
      description: 'test5',
      body: '本文',
      draft: false,
      // 20:40:01Z は JST では翌日 05:40:01 -> posts/2026/09/08/054001.md
      pubDate: '2026-09-07T20:40:01.277Z',
      ...extra,
    }),
  }) as never;

/** 既存の記事と同じパス。**この 1 本が衝突の相手になる。** */
const EXISTING = 'posts/2026/09/08/054001.md';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('2026-09-07 の事故の再現', () => {
  it('**既存の slug は 409 になり、記事の中身が 1 バイトも変わらない**', async () => {
    const files = new Map([[EXISTING, ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post(), deps());
    expect(response.statusCode).toBe(409);
    expect(files.get(EXISTING)).toBe(ORIGINAL);
  });

  it('偽の GitHub は本当に書き換える（上のテストが空虚でないことの対照）', async () => {
    // 承認して上書きすれば内容は変わる。変わらないなら偽物が壊れており、
    // 上のテストは何も確かめていないことになる。
    const files = new Map([[EXISTING, ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post({ overwrite: true }), deps());
    expect(response.statusCode).toBe(201);
    expect(files.get(EXISTING)).not.toBe(ORIGINAL);
    expect(files.get(EXISTING)).toContain('更新');
  });

  it('別の時刻なら作成され、コミットメッセージは「追加」になる', async () => {
    const files = new Map([[EXISTING, ORIGINAL]]);
    fakeGitHub(files);
    const response = await dispatch(post({ pubDate: '2026-09-07T20:40:02.000Z' }), deps());
    expect(response.statusCode).toBe(201);
    expect(files.get(EXISTING)).toBe(ORIGINAL);
    expect(files.get('posts/2026/09/08/054002.md')).toContain('追加');
  });
});

/**
 * **投稿のリクエストを実際に通して、書き込み先のパスを検査する。**
 *
 * `dateSlug` の単体テストは `api/test/unit/post-slug.test.ts` にあるが、それは
 * 「関数が正しい文字列を返す」ことしか言えない。ここは **HTTP のボディから
 * tree に載るパスまで**が繋がっていることを、偽の GitHub が実際に書いた
 * キーで確かめる。配線が外れていれば関数が正しくても記事は別の場所に出る。
 */
describe('**日付パスがコミット先に届く**', () => {
  const pathWritten = async (pubDate: string): Promise<string[]> => {
    const files = new Map<string, string>();
    fakeGitHub(files);
    const response = await dispatch(post({ pubDate }), deps());
    expect(response.statusCode).toBe(201);
    return [...files.keys()];
  };

  it.each([
    ['実際に踏んだ時刻', '2026-09-07T20:40:01.277Z', 'posts/2026/09/08/054001.md'],
    ['JST 0 時ちょうど', '2026-09-07T15:00:00.000Z', 'posts/2026/09/08/000000.md'],
    ['その 1ms 前', '2026-09-07T14:59:59.999Z', 'posts/2026/09/07/235959.md'],
    ['年またぎ', '2026-12-31T15:00:00.000Z', 'posts/2027/01/01/000000.md'],
  ])('境界値 %s -> %s', async (_label, pubDate, expected) => {
    expect(await pathWritten(pubDate)).toEqual([expected]);
  });

  it('**応答の path も同じ**（利用者が画面で見る値）', async () => {
    const files = new Map<string, string>();
    fakeGitHub(files);
    const response = await dispatch(post(), deps());
    expect(JSON.parse(String(response.body))['path']).toBe('posts/2026/09/08/054001.md');
  });

  it('コミットメッセージが title を含み、日付パスを含まない', async () => {
    const files = new Map<string, string>();
    fakeGitHub(files);
    await dispatch(post(), deps());
    const written = files.get('posts/2026/09/08/054001.md') ?? '';
    expect(written).toContain('test5');
    expect(written).not.toContain('2026/09/08');
  });
});
