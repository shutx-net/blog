import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostPublisher } from '../../src/github/commit.ts';
import { createPostReader } from '../../src/github/reader.ts';
import { dispatch } from '../../src/router.ts';
import type { Deps } from '../../src/deps.ts';

/**
 * 削除の経路を**偽の GitHub にファイルを実際に持たせて**検査する。
 *
 * **削除は取り消せない唯一の操作なので、ステータスコードだけでは足りない。**
 * 「409 を返しつつ消してしまう実装」も「対象以外まで消す実装」もありうる。
 * ここでは偽物が tree のエントリを本当に適用するので、`files` の中身で判定できる。
 *
 * `post-update.test.ts` と同じ偽物を使う。**写しを 1 本に保つほうが正しい**が、
 * 偽物を共有モジュールに出すと「テストの都合で本番の形が決まる」方向に働くので、
 * いまは 2 本の独立したハーネスとして置いている（片方を緩めても他方が緑のままになる
 * 危険はあるが、どちらも `base_tree` の欠落を 598 で見張っている）。
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
  /** 最後に tree へ送ったエントリ。`sha: null` であることを主張する。 */
  lastTree: () => Array<{ path: string; sha: string | null }>;
}

const fakeGitHub = (files: Map<string, string>): Fake => {
  let pendingTree: Array<{ path: string; sha: string | null }> = [];
  let lastTree: Array<{ path: string; sha: string | null }> = [];
  let writes = 0;
  const blobs = new Map<string, string>();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const p = new URL(String(input)).pathname;
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
          // 削除経路ではこれが最も重い事故なので、偽物の側で気づけるようにする。
          return json({ message: 'base_tree is required by this fake' }, 598);
        }
        pendingTree = (payload['tree'] ?? []) as Array<{ path: string; sha: string | null }>;
        lastTree = pendingTree;
        return json({ sha: 'tree1' }, 201);
      }
      if (method === 'POST' && p === '/repos/o/r/git/commits') {
        // **ここで実際に適用する。** `sha: null` のエントリは消える。
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

  return { files, writes: () => writes, lastTree: () => lastTree };
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

const TARGET_SLUG = '2026/09/27/142621';
const TARGET_PATH = `posts/${TARGET_SLUG}.md`;

const publishedFile = (label: string): string =>
  body({
    title: `${label} のタイトル`,
    description: `${label} の説明`,
    pubDate: '2026-09-27T05:26:21.486Z',
    draft: false,
    body: `${label} の本文`,
  });

const draftFile = (label: string): string =>
  body({
    title: `${label} のタイトル`,
    description: `${label} の説明`,
    pubDate: '2026-09-26T01:10:10.000Z',
    draft: true,
    body: `${label} の本文`,
  });

/** もう 1 本の公開記事。**床を割らせないための対照。** */
const OTHER_PATH = 'posts/2026/09/26/101010.md';
const otherPublished = (): string =>
  body({
    title: 'ほか',
    description: 'ほか',
    pubDate: '2026-09-26T01:10:10.000Z',
    draft: false,
    body: 'ほか',
  });

const deleteRequest = (query: Record<string, string>): never =>
  ({
    method: 'DELETE',
    path: '/api/posts',
    headers: {},
    query,
    rawBody: undefined,
  }) as never;

/** 対象の現況から sha を引く。**中身が変われば sha も変わる。** */
const shaFor = (files: Map<string, string>, path: string): string => shaOf(files.get(path)!);

afterEach(() => {
  vi.unstubAllGlobals();
  dispatcher.dispatch.mockClear();
});

describe('DELETE /api/posts — 正常系', () => {
  it('**対象のファイルが実際に消え、他のファイルが残る**', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }),
      deps(),
    );

    expect(response.statusCode).toBe(200);
    expect(fake.files.has(TARGET_PATH)).toBe(false);
    // **base_tree を落とす事故の検知。** 対象以外が消えていたら、
    // tree が base を継いでいない。
    expect(fake.files.get(OTHER_PATH)).toBe(otherPublished());
  });

  it('**tree のエントリは `sha: null`**（これが削除の表現）', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    await dispatch(deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }), deps());

    expect(fake.lastTree()).toEqual([
      { path: TARGET_PATH, mode: '100644', type: 'blob', sha: null },
    ]);
  });

  it('応答が path と commitSha を返し、dispatch が 1 回だけ走る', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }),
      deps(),
    );

    const payload = JSON.parse(String(response.body)) as Record<string, unknown>;
    expect(payload['path']).toBe(TARGET_PATH);
    expect(payload['commitSha']).toBe('commit1');
    expect(payload['deployTriggered']).toBe(true);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('コミットメッセージが title を含み、日付パスを含まない', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    fakeGitHub(files);
    const messages: string[] = [];
    const spy = vi.mocked(globalThis.fetch);
    await dispatch(deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }), deps());
    for (const call of spy.mock.calls) {
      const init = call[1];
      if (init?.body === undefined) continue;
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (typeof parsed['message'] === 'string') messages.push(parsed['message']);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('対象 のタイトル');
    expect(messages[0]).toContain('削除');
    expect(messages[0]).not.toContain('2026/09/27');
  });

  it('**下書きは削除できる**（公開記事が残っていれば床を割らない）', async () => {
    const DRAFT_PATH = 'posts/2026/09/25/090000.md';
    const files = new Map([
      [DRAFT_PATH, draftFile('下書き')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: '2026/09/25/090000', sha: shaFor(files, DRAFT_PATH) }),
      deps(),
    );

    expect(response.statusCode).toBe(200);
    expect(fake.files.has(DRAFT_PATH)).toBe(false);
  });
});

describe('DELETE /api/posts — 拒否（何も消さない）', () => {
  it('**最後の公開記事は 409 で、ファイルが残る**', async () => {
    const files = new Map([[TARGET_PATH, publishedFile('対象')]]);
    const fake = fakeGitHub(files);
    const before = fake.writes();
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }),
      deps(),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))['error']).toBe('would_starve_site');
    expect(fake.files.get(TARGET_PATH)).toBe(publishedFile('対象'));
    // **書き込みリクエストが 1 本も飛んでいない。**
    expect(fake.writes()).toBe(before);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('**公開 1 本 + 下書き 3 本でその公開を消そうとすると 409**（総数は 3 残るのに拒否する）', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      ['posts/2026/09/20/090000.md', draftFile('下書き1')],
      ['posts/2026/09/21/090000.md', draftFile('下書き2')],
      ['posts/2026/09/22/090000.md', draftFile('下書き3')],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }),
      deps(),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))['error']).toBe('would_starve_site');
    expect(fake.files.get(TARGET_PATH)).toBe(publishedFile('対象'));
    // 総数は 4 のまま。**「総数 >= 1」で判定していたら通ってしまう形。**
    expect(fake.files.size).toBe(4);
  });

  it('**公開が 2 本あれば消える**（上の床のテストが空虚でないことの対照）', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: shaFor(files, TARGET_PATH) }),
      deps(),
    );

    expect(response.statusCode).toBe(200);
    expect(fake.files.has(TARGET_PATH)).toBe(false);
  });

  it('**sha が違えば 409 で、1 バイトも消えない**', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    const response = await dispatch(
      deleteRequest({ slug: TARGET_SLUG, sha: 'blob-stale' }),
      deps(),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))['error']).toBe('stale_post');
    expect(fake.files.get(TARGET_PATH)).toBe(publishedFile('対象'));
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('**sha が無ければ 400**（省略で並行制御を外せない）', async () => {
    const files = new Map([[TARGET_PATH, publishedFile('対象')]]);
    const fake = fakeGitHub(files);
    const before = fake.writes();
    const response = await dispatch(deleteRequest({ slug: TARGET_SLUG }), deps());

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))['field']).toBe('sha');
    expect(fake.writes()).toBe(before);
  });

  it('存在しない slug は 404 で、書き込みが 0 本', async () => {
    const files = new Map([
      [TARGET_PATH, publishedFile('対象')],
      [OTHER_PATH, otherPublished()],
    ]);
    const fake = fakeGitHub(files);
    const before = fake.writes();
    const response = await dispatch(
      deleteRequest({ slug: '2020/01/01/000000', sha: 'blob-whatever' }),
      deps(),
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(String(response.body))['error']).toBe('post_not_found');
    expect(fake.writes()).toBe(before);
    expect(fake.files.size).toBe(2);
  });

  it.each([
    ['..', '..'],
    ['traversal', '../../etc/passwd'],
    ['平坦スラッグ', 'hello-world'],
    ['桁違い', '2026/9/8/54001'],
  ])('%s は 400 で、リクエストが 1 本も飛ばない', async (_label, slug) => {
    const files = new Map([[TARGET_PATH, publishedFile('対象')]]);
    fakeGitHub(files);
    const spy = vi.mocked(globalThis.fetch);
    const response = await dispatch(deleteRequest({ slug, sha: 'blob-whatever' }), deps());

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))['field']).toBe('slug');
    // **形の検証で落ちる入力では GitHub を一度も呼ばない**（token の交換も起きない）。
    expect(spy).not.toHaveBeenCalled();
  });
});
