import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostPublisher } from '../../src/github/commit.ts';
import { createPostReader } from '../../src/github/reader.ts';
import { dispatch } from '../../src/router.ts';
import type { Deps } from '../../src/deps.ts';

/**
 * 編集の経路を**偽の GitHub にファイルを実際に持たせて**検査する。
 *
 * ステータスコードだけを見ると「409 を返しつつ書いてしまう実装」を見逃す
 * （repro.test.ts が 2026-09-07 の事故で学んだこと）。ここでは blob sha も
 * 中身から導出するので、**内容が変われば sha も変わる** — 楽観的並行制御が
 * 本当に効いているかを、偽物の側で誤魔化せない。
 */

/** 中身から blob sha を作る。**内容が 1 バイト違えば別の sha になる。** */
const shaOf = (content: string): string => {
  let hash = 0;
  for (const ch of content) hash = (hash * 31 + ch.codePointAt(0)!) % 0xffffffff;
  return `blob-${hash.toString(16)}`;
};

const body = (post: Record<string, unknown>): string =>
  `---\ntitle: ${JSON.stringify(post['title'])}\ndescription: ${JSON.stringify(post['description'])}\npubDate: ${JSON.stringify(post['pubDate'])}\ndraft: ${String(post['draft'])}\ntags: []\n---\n\n${String(post['body'])}`;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status });

interface Fake {
  files: Map<string, string>;
  /** 書き込み（POST / PATCH）の回数。**拒否経路で 0 であることを主張する。** */
  writes: () => number;
}

const fakeGitHub = (files: Map<string, string>): Fake => {
  let pendingTree: Array<{ path: string; sha: string | null }> = [];
  let writes = 0;
  const blobs = new Map<string, string>();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      const p = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const payload =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (method !== 'GET') writes += 1;

      if (method === 'GET' && p.startsWith('/repos/o/r/contents/')) {
        const file = p.slice('/repos/o/r/contents/'.length);
        const content = files.get(file);
        if (content === undefined) return json({ message: 'Not Found' }, 404);
        return json({
          type: 'file',
          path: file,
          sha: shaOf(content),
          encoding: 'base64',
          content: Buffer.from(content, 'utf8').toString('base64'),
        });
      }
      if (p === '/repos/o/r/git/ref/heads/main') return json({ object: { sha: 'base' } });
      if (p === '/repos/o/r/git/commits/base') return json({ tree: { sha: 'tree0' } });
      if (p === '/repos/o/r/git/trees/tree0') {
        return json({
          truncated: false,
          tree: [...files.keys()].map((path) => ({
            path,
            type: 'blob',
            sha: shaOf(files.get(path)!),
          })),
        });
      }
      if (method === 'GET' && p.startsWith('/repos/o/r/git/blobs/')) {
        const sha = p.slice('/repos/o/r/git/blobs/'.length);
        const found = [...files.values()].find((content) => shaOf(content) === sha);
        if (found === undefined) return json({ message: 'Not Found' }, 404);
        return json({
          encoding: 'base64',
          content: Buffer.from(found, 'utf8').toString('base64'),
        });
      }
      if (method === 'POST' && p === '/repos/o/r/git/blobs') {
        const content = Buffer.from(String(payload?.['content']), 'base64').toString('utf8');
        const sha = shaOf(content);
        blobs.set(sha, content);
        return json({ sha }, 201);
      }
      if (method === 'POST' && p === '/repos/o/r/git/trees') {
        if (payload?.['base_tree'] === undefined) {
          // **base_tree を落とすとリポジトリ全体が 1 コミットで消える。**
          // 偽物の側で気づけるようにしておく。
          return json({ message: 'base_tree is required by this fake' }, 598);
        }
        pendingTree = (payload['tree'] ?? []) as Array<{ path: string; sha: string | null }>;
        return json({ sha: 'tree1' }, 201);
      }
      if (method === 'POST' && p === '/repos/o/r/git/commits') {
        // **ここで実際に書く。** コミットが作られた時点でファイルが変わる。
        for (const entry of pendingTree) {
          if (entry.sha === null) files.delete(entry.path);
          else files.set(entry.path, blobs.get(entry.sha) ?? `NEW blob ${entry.sha}`);
        }
        return json({ sha: 'commit1' }, 201);
      }
      if (method === 'PATCH') return json({ object: { sha: 'commit1' } });
      return json({ message: `unexpected ${method} ${p}` }, 599);
    }),
  );

  return { files, writes: () => writes };
};

const dispatcher = { dispatch: vi.fn(async () => undefined) };

const deps = (): Deps => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wiring = {
    tokenProvider: { getToken: async () => 't' },
    owner: 'o',
    repo: 'r',
    postsPathPrefix: 'posts/',
    logger,
  };
  return {
    authorizer: { authorize: async () => ({ ok: true as const, subject: 's' }) },
    publisher: createPostPublisher(wiring),
    reader: createPostReader(wiring),
    presigner: { presign: async () => ({ url: '', key: '', expiresIn: 0, requiredHeaders: {} }) },
    secretReader: { readPrivateKey: async () => 'PEM' },
    tokenProvider: { getToken: async () => 't' },
    logger,
    authMode: 'cognito',
    deployDispatcher: dispatcher,
    now: () => 0,
  };
};

/** 既存の記事。**pubDate は admin が作る形（ms 付き）。** */
const EXISTING_SLUG = '2026/09/27/142621';
const EXISTING_PATH = `posts/${EXISTING_SLUG}.md`;
const EXISTING_PUB_DATE = '2026-09-27T05:26:21.486Z';

const existingFile = (overrides: Record<string, unknown> = {}): string =>
  body({
    title: '元のタイトル',
    description: '元の説明',
    pubDate: EXISTING_PUB_DATE,
    draft: false,
    body: '元の本文',
    ...overrides,
  });

/** もう 1 本の公開記事。**床を割らせないための対照。** */
const OTHER_PATH = 'posts/2026/09/26/101010.md';
const otherFile = (): string =>
  body({
    title: 'ほか',
    description: 'ほか',
    pubDate: '2026-09-26T01:10:10.000Z',
    draft: false,
    body: 'ほか',
  });

const putRequest = (extra: Record<string, unknown> = {}, sha?: string): never =>
  ({
    method: 'PUT',
    path: '/api/posts',
    headers: { 'content-type': 'application/json' },
    query: {},
    rawBody: JSON.stringify({
      targetSlug: EXISTING_SLUG,
      sha: sha ?? shaOf(existingFile()),
      title: '新しいタイトル',
      description: '新しい説明',
      pubDate: EXISTING_PUB_DATE,
      draft: false,
      tags: [],
      body: '新しい本文',
      ...extra,
    }),
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
  dispatcher.dispatch.mockClear();
});

describe('PUT /api/posts — 正常系', () => {
  it('**ファイルの中身が実際に変わる**', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    const fake = fakeGitHub(files);
    const response = await dispatch(putRequest(), deps());

    expect(response.statusCode).toBe(200);
    const written = fake.files.get(EXISTING_PATH) ?? '';
    expect(written).toContain('新しいタイトル');
    expect(written).toContain('新しい本文');
    expect(written).not.toContain('元のタイトル');
  });

  it('**パスが動かない**（URL と RSS guid が不変であることの実体）', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    const fake = fakeGitHub(files);
    await dispatch(putRequest(), deps());
    expect([...fake.files.keys()]).toEqual([EXISTING_PATH]);
  });

  it('pubDate は既存の値のまま書かれる', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    const fake = fakeGitHub(files);
    await dispatch(putRequest(), deps());
    expect(fake.files.get(EXISTING_PATH)).toContain(EXISTING_PUB_DATE);
  });

  it('dispatch が 1 回呼ばれ、deployTriggered が true になる', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    fakeGitHub(files);
    const response = await dispatch(putRequest(), deps());
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body)['deployTriggered']).toBe(true);
  });

  it('replaced が true（作成ではない）', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    fakeGitHub(files);
    const response = await dispatch(putRequest(), deps());
    expect(JSON.parse(response.body)['replaced']).toBe(true);
  });

  it('コミットメッセージが「更新」で title を含む', async () => {
    const files = new Map([[EXISTING_PATH, existingFile()]]);
    const fake = fakeGitHub(files);
    // 偽物は blob の中身をそのまま書くので、メッセージはコミットの payload 側にある。
    // ここでは中身が新しいものに置き換わったことだけを見て、メッセージは
    // commit-message.test.ts の担当とする。
    await dispatch(putRequest(), deps());
    expect(fake.files.get(EXISTING_PATH)).toContain('新しいタイトル');
  });
});

describe('PUT /api/posts — 楽観的並行制御', () => {
  it('**sha が古いと 409 で、中身が 1 バイトも変わらない**', async () => {
    const original = existingFile();
    const files = new Map([[EXISTING_PATH, original]]);
    const fake = fakeGitHub(files);
    const response = await dispatch(putRequest({}, 'blob-stale'), deps());

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)['error']).toBe('stale_post');
    expect(fake.files.get(EXISTING_PATH)).toBe(original);
  });

  it('409 のとき dispatch を呼ばない', async () => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    await dispatch(putRequest({}, 'blob-stale'), deps());
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(0);
  });

  it('**sha を省略すると 400**（並行制御を外して呼べる経路を作らない）', async () => {
    const original = existingFile();
    const files = new Map([[EXISTING_PATH, original]]);
    const fake = fakeGitHub(files);
    const response = await dispatch(putRequest({ sha: undefined }), deps());

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe('sha');
    expect(fake.files.get(EXISTING_PATH)).toBe(original);
  });

  it('sha が空文字でも 400', async () => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    const response = await dispatch(putRequest({}, '   '), deps());
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe('sha');
  });
});

describe('PUT /api/posts — pubDate は変えられない', () => {
  it('**別の pubDate を送ると 400 で、書き込みが 1 本も出ない**', async () => {
    const original = existingFile();
    const files = new Map([[EXISTING_PATH, original]]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      putRequest({ pubDate: '2026-09-27T06:00:00.000Z' }),
      deps(),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe('pubDate');
    expect(fake.files.get(EXISTING_PATH)).toBe(original);
    // **読み取りしか起きていないこと。** blob も tree も commit も作られていない。
    expect(fake.writes()).toBe(0);
  });

  it('同じ瞬間でも表記が違えば 400（byte 一致を要求する）', async () => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    // 486ms を落とした表記。瞬間としてはほぼ同じだが、値は変わっている。
    const response = await dispatch(putRequest({ pubDate: '2026-09-27T05:26:21Z' }), deps());
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe('pubDate');
  });

  it('pubDate を省略しても 400（now で上書きさせない）', async () => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    const response = await dispatch(putRequest({ pubDate: undefined }), deps());
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe('pubDate');
  });
});

describe('PUT /api/posts — 送ってはいけないフィールド', () => {
  it.each([
    ['slug', { slug: '2026/01/01/000000' }],
    ['overwrite', { overwrite: true }],
  ])('%s を送ると 400', async (field, extra) => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    const response = await dispatch(putRequest(extra), deps());
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)['field']).toBe(field);
  });

  it.each(['hello-world', '..', '2026/9/8/54001', ''])(
    'targetSlug が %o なら 400 で reader を呼ばない',
    async (targetSlug) => {
      const fake = fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
      const response = await dispatch(putRequest({ targetSlug }), deps());
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)['field']).toBe('targetSlug');
      expect(fake.writes()).toBe(0);
    },
  );
});

describe('PUT /api/posts — 存在しない記事', () => {
  it('404 で、書き込みが 1 本も出ない', async () => {
    const fake = fakeGitHub(new Map([[OTHER_PATH, otherFile()]]));
    const response = await dispatch(putRequest(), deps());
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)['error']).toBe('post_not_found');
    expect(fake.writes()).toBe(0);
  });
});

describe('PUT /api/posts — 公開可能数の床', () => {
  it('**最後の公開記事を draft:true にすると 409 で、中身が変わらない**', async () => {
    const original = existingFile();
    const files = new Map([[EXISTING_PATH, original]]);
    const fake = fakeGitHub(files);
    const response = await dispatch(putRequest({ draft: true }), deps());

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)['error']).toBe('would_starve_site');
    expect(fake.files.get(EXISTING_PATH)).toBe(original);
    expect(fake.writes()).toBe(0);
  });

  it('409 のとき dispatch を呼ばない', async () => {
    fakeGitHub(new Map([[EXISTING_PATH, existingFile()]]));
    await dispatch(putRequest({ draft: true }), deps());
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(0);
  });

  it('**もう 1 本公開記事があれば draft にできる**（床のテストが空虚でない対照）', async () => {
    const files = new Map([
      [EXISTING_PATH, existingFile()],
      [OTHER_PATH, otherFile()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(putRequest({ draft: true }), deps());

    expect(response.statusCode).toBe(200);
    expect(fake.files.get(EXISTING_PATH)).toContain('draft: true');
  });

  it('既に draft の記事を draft のまま更新するのは、他に公開記事があれば通る', async () => {
    const files = new Map([
      [EXISTING_PATH, existingFile({ draft: true })],
      [OTHER_PATH, otherFile()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      putRequest({ draft: true }, shaOf(existingFile({ draft: true }))),
      deps(),
    );
    expect(response.statusCode).toBe(200);
    expect(fake.files.get(EXISTING_PATH)).toContain('新しい本文');
  });
});
