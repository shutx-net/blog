import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConcurrentUpdateError,
  SITE_POSTS_PATH_PREFIX,
  SlugConflictError,
  TARGET_BRANCH,
  createPostPublisher,
} from '../../src/github/commit.ts';

const BASE_COMMIT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BLOB_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const NEW_TREE_SHA = 'dddddddddddddddddddddddddddddddddddddddd';
const NEW_COMMIT_SHA = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface FetchCall {
  method: string;
  path: string;
  /** クエリ文字列。存在確認が base commit に固定されていることを見るために要る。 */
  search: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** 既定では記事はまだ無い（404）。衝突を見るテストだけがこれを 200 に差し替える。 */
const CONTENTS_PREFIX = '/repos/shutx-net/blog/contents/';

/** docs の Response schema に沿った最小のフェイク。 */
const defaultResponder = (call: FetchCall): Response => {
  if (call.method === 'GET' && call.path.startsWith(CONTENTS_PREFIX)) {
    return json({ message: 'Not Found' }, 404);
  }
  if (call.method === 'POST' && call.path === '/repos/shutx-net/blog/git/blobs') {
    return json({ sha: BLOB_SHA }, 201);
  }
  if (call.method === 'GET' && call.path === '/repos/shutx-net/blog/git/ref/heads/main') {
    return json({ ref: 'refs/heads/main', object: { sha: BASE_COMMIT_SHA, type: 'commit' } });
  }
  if (call.method === 'GET' && call.path === `/repos/shutx-net/blog/git/commits/${BASE_COMMIT_SHA}`) {
    return json({ sha: BASE_COMMIT_SHA, tree: { sha: BASE_TREE_SHA } });
  }
  if (call.method === 'POST' && call.path === '/repos/shutx-net/blog/git/trees') {
    return json({ sha: NEW_TREE_SHA }, 201);
  }
  if (call.method === 'POST' && call.path === '/repos/shutx-net/blog/git/commits') {
    return json({ sha: NEW_COMMIT_SHA }, 201);
  }
  if (call.method === 'PATCH' && call.path === '/repos/shutx-net/blog/git/refs/heads/main') {
    return json({ ref: 'refs/heads/main', object: { sha: NEW_COMMIT_SHA } });
  }
  return json({ message: `unexpected ${call.method} ${call.path}` }, 599);
};

const installFetch = (responder: (call: FetchCall) => Response = defaultResponder) => {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const call: FetchCall = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: new URL(String(input)).pathname,
        search: new URL(String(input)).search,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
      };
      calls.push(call);
      return responder(call);
    }),
  );
  return { calls };
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const publisher = (log = logger(), postsPathPrefix = SITE_POSTS_PATH_PREFIX) =>
  createPostPublisher({
    tokenProvider: { getToken: vi.fn(async () => 'ghs_test_token') },
    owner: 'shutx-net',
    repo: 'blog',
    postsPathPrefix,
    logger: log,
  });

const input = (
  overrides: Partial<{
    slug: string;
    markdown: string;
    createMessage: string;
    replaceMessage: string;
    overwrite: boolean;
  }> = {},
) => ({
  slug: 'hello-world',
  markdown: '---\ntitle: "テスト"\n---\n\n本文\n',
  createMessage: 'feat(site): 記事 hello-world を追加',
  replaceMessage: 'feat(site): 記事 hello-world を更新',
  overwrite: false,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const callOf = (calls: FetchCall[], index: number): FetchCall => calls[index] as FetchCall;

/**
 * method + path で 1 本を引く。
 *
 * **添字で引かない。** 呼び出しの本数や順序が変わるたびに、無関係な主張が
 * まとめて赤くなる（存在確認を挟んだときに実際そうなった）。
 */
const findCall = (calls: FetchCall[], method: string, path: string): FetchCall => {
  const found = calls.find((c) => c.method === method && c.path === path);
  if (found === undefined) {
    throw new Error(`${method} ${path} が無い: ${JSON.stringify(calls.map((c) => [c.method, c.path]))}`);
  }
  return found;
};

const BLOB_PATH = '/repos/shutx-net/blog/git/blobs';
const TREE_PATH = '/repos/shutx-net/blog/git/trees';
const COMMIT_PATH = '/repos/shutx-net/blog/git/commits';
const REF_UPDATE_PATH = '/repos/shutx-net/blog/git/refs/heads/main';

describe('呼び出し列', () => {
  it('正確に 7 本で、順序も固定されている', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      // **base を先に決め、その base に対して存在を確かめてから書き始める。**
      // blob より前に確認するので、409 のときリポジトリに何も残らない。
      ['GET', '/repos/shutx-net/blog/git/ref/heads/main'],
      ['GET', '/repos/shutx-net/blog/contents/site/src/content/posts/hello-world.md'],
      ['GET', `/repos/shutx-net/blog/git/commits/${BASE_COMMIT_SHA}`],
      ['POST', '/repos/shutx-net/blog/git/blobs'],
      ['POST', '/repos/shutx-net/blog/git/trees'],
      ['POST', '/repos/shutx-net/blog/git/commits'],
      ['PATCH', '/repos/shutx-net/blog/git/refs/heads/main'],
    ]);
  });

  it('すべての呼び出しが installation token を Bearer で送る', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.headers['authorization']).toBe('Bearer ghs_test_token');
      expect(call.headers['accept']).toBe('application/vnd.github+json');
      expect(call.headers['x-github-api-version']).toBe('2026-03-10');
    }
  });

  it('新しいコミットの sha とパスを返す', async () => {
    installFetch();
    const result = await publisher().publish(input());
    expect(result).toEqual({
      commitSha: NEW_COMMIT_SHA,
      path: 'site/src/content/posts/hello-world.md',
      replaced: false,
    });
  });
});

describe('単数形 ref と複数形 refs の取り違え', () => {
  it('参照の取得は git/ref/heads/main（単数）である', async () => {
    // docs.github.com の operation path がそう定義されている。
    const { calls } = installFetch();
    await publisher().publish(input());
    const get = calls.filter((c) => c.method === 'GET' && c.path.includes('/git/ref'));
    expect(get.map((c) => c.path)).toContain('/repos/shutx-net/blog/git/ref/heads/main');
    expect(get.map((c) => c.path)).not.toContain('/repos/shutx-net/blog/git/refs/heads/main');
  });

  it('参照の更新は git/refs/heads/main（複数）である', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    const patch = calls.filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(callOf(patch, 0).path).toBe('/repos/shutx-net/blog/git/refs/heads/main');
    expect(callOf(patch, 0).path).not.toBe('/repos/shutx-net/blog/git/ref/heads/main');
  });

  it('ブランチが main に固定されている', async () => {
    // infra/lib/cicd-stack.ts の信頼ポリシーが refs/heads/main を StringEquals で
    // 固定しているので、他ブランチにコミットしてもデプロイは走らない。
    expect(TARGET_BRANCH).toBe('main');
    const { calls } = installFetch();
    await publisher().publish(input());
    for (const call of calls.filter((c) => c.path.includes('/git/ref'))) {
      expect(call.path.endsWith('/heads/main')).toBe(true);
    }
  });
});

describe('blob の作成', () => {
  it('ボディが { content: <base64>, encoding: "base64" } である', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    const body = findCall(calls, 'POST', BLOB_PATH).body ?? {};
    expect(Object.keys(body).sort()).toEqual(['content', 'encoding']);
    expect(body['encoding']).toBe('base64');
    expect(typeof body['content']).toBe('string');
  });

  it('UTF-8 の日本語本文が base64 往復で 1 バイトも変わらない', async () => {
    const markdown = '---\ntitle: "日本語のタイトル"\n---\n\n絵文字 🎌 と ASCII と ～〜①\n';
    const { calls } = installFetch();
    await publisher().publish(input({ markdown }));
    const content = String(findCall(calls, 'POST', BLOB_PATH).body?.['content']);
    expect(Buffer.from(content, 'base64').toString('utf8')).toBe(markdown);
  });

  it("encoding に 'utf-8' を使わない", async () => {
    // docs: "Currently, \"utf-8\" and \"base64\" are supported"。base64 を選ぶのは
    // YAML front matter と本文に何が来ても安全に運べるから。
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(findCall(calls, 'POST', BLOB_PATH).body?.['encoding']).not.toBe('utf-8');
  });
});

describe('tree の作成', () => {
  const treeBody = async (): Promise<Record<string, unknown>> => {
    const { calls } = installFetch();
    await publisher().publish(input());
    return findCall(calls, 'POST', TREE_PATH).body ?? {};
  };

  it('**base_tree が入っている**（無いとリポジトリ全体が 1 コミットで消える）', async () => {
    // docs: "If not provided, GitHub will create a new Git tree object from only the
    // entries defined in the tree parameter. If you create a new commit pointing to
    // such a tree, then all files which were a part of the parent commit's tree and
    // were not defined in the tree parameter will be listed as deleted."
    // **本ファイルで最も重要な 1 行。**
    expect((await treeBody())['base_tree']).toBe(BASE_TREE_SHA);
  });

  it('base_tree が親コミットの tree.sha であって commit の sha ではない', async () => {
    const body = await treeBody();
    expect(body['base_tree']).not.toBe(BASE_COMMIT_SHA);
  });

  it('エントリがちょうど 1 件で、path / mode / type / sha を持つ', async () => {
    const tree = (await treeBody())['tree'] as Array<Record<string, unknown>>;
    expect(tree).toHaveLength(1);
    expect(tree[0]).toEqual({
      path: 'site/src/content/posts/hello-world.md',
      mode: '100644',
      type: 'blob',
      sha: BLOB_SHA,
    });
  });

  it('mode が docs の列挙のうち 100644 である', async () => {
    const tree = (await treeBody())['tree'] as Array<Record<string, unknown>>;
    expect(['100644', '100755', '040000', '160000', '120000']).toContain(tree[0]?.['mode']);
    expect(tree[0]?.['mode']).toBe('100644');
  });

  it('エントリに sha と content が同時に入らない', async () => {
    // docs: "Using both tree.sha and content will return an error"
    const tree = (await treeBody())['tree'] as Array<Record<string, unknown>>;
    for (const entry of tree) {
      expect('sha' in entry && 'content' in entry).toBe(false);
    }
  });
});

describe('commit の作成', () => {
  const commitBody = async (createMessage?: string): Promise<Record<string, unknown>> => {
    const { calls } = installFetch();
    await publisher().publish(createMessage === undefined ? input() : input({ createMessage }));
    return findCall(calls, 'POST', COMMIT_PATH).body ?? {};
  };

  it('{ message, tree, parents } で、parents が親コミット 1 件である', async () => {
    expect(await commitBody()).toEqual({
      message: 'feat(site): 記事 hello-world を追加',
      tree: NEW_TREE_SHA,
      parents: [BASE_COMMIT_SHA],
    });
  });

  it('parents が空配列でも undefined でもない', async () => {
    // docs: "If omitted or empty, the commit will be written as a root commit"
    // — 履歴が切れる。
    const parents = (await commitBody())['parents'] as unknown[];
    expect(Array.isArray(parents)).toBe(true);
    expect(parents).toHaveLength(1);
  });

  it('コミットメッセージが Conventional Commits に従う', async () => {
    // リポジトリ規約（AGENTS.md）が API 経由のコミットにも適用されることを固定する。
    const message = String((await commitBody())['message']);
    expect(message).toMatch(/^(feat|fix|refactor|test|docs|build|ci|chore)(\([a-z]+\))?: /);
  });
});

describe('ref の更新', () => {
  it('ボディが { sha } だけで force を渡していない', async () => {
    // docs: "Leaving this out or setting it to false will make sure you're not
    // overwriting work"。他人のコミットを踏み潰さない。
    const { calls } = installFetch();
    await publisher().publish(input());
    const body = findCall(calls, 'PATCH', REF_UPDATE_PATH).body ?? {};
    expect(body['sha']).toBe(NEW_COMMIT_SHA);
    expect(body['force']).not.toBe(true);
    expect(Object.keys(body).filter((k) => k !== 'sha' && k !== 'force')).toEqual([]);
  });

  it('422 のとき ConcurrentUpdateError を投げ、リトライしない', async () => {
    const { calls } = installFetch((call) =>
      call.method === 'PATCH'
        ? json({ message: 'Update is not a fast forward' }, 422)
        : defaultResponder(call),
    );
    await expect(publisher().publish(input())).rejects.toBeInstanceOf(ConcurrentUpdateError);
    // 踏み潰さないので再試行もしない。PATCH はちょうど 1 回。
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('422 の判定がレスポンス本文の文言に依存しない', async () => {
    // 'Update is not a fast forward' は docs に載っていない。status だけで判定する。
    installFetch((call) =>
      call.method === 'PATCH' ? json({ message: '全く別の文言' }, 422) : defaultResponder(call),
    );
    await expect(publisher().publish(input())).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });

  it('422 以外の失敗は ConcurrentUpdateError にしない', async () => {
    installFetch((call) =>
      call.method === 'PATCH' ? json({ message: 'boom' }, 500) : defaultResponder(call),
    );
    const error = await publisher()
      .publish(input())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConcurrentUpdateError);
  });
});

describe('パスの封じ込め', () => {
  it('SITE_POSTS_PATH_PREFIX が site/src/content/posts/ である', () => {
    // **記事リポジトリを分離する前の値。** infra はこの定数を渡し、
    // 切り替えのときだけ 'posts/' に変える。
    expect(SITE_POSTS_PATH_PREFIX).toBe('site/src/content/posts/');
  });

  it('**記事パスの接頭辞は注入値である**（定数を素通ししない）', async () => {
    // 記事リポジトリ側では 'posts/' になる。ハードコードのままだと
    // 切り替えたときに blog-content の中に site/src/content/posts/ が生える。
    const { calls } = installFetch();
    await publisher(logger(), 'posts/').publish(input());
    const tree = (findCall(calls, 'POST', TREE_PATH).body?.['tree'] as Array<Record<string, unknown>>) ?? [];
    expect(tree[0]?.['path']).toBe('posts/hello-world.md');
  });

  it('接頭辞を変えても slug の検証は効く', async () => {
    installFetch();
    await expect(publisher(logger(), 'posts/').publish(input({ slug: '../escape' }))).rejects.toThrow(
      /slug must match/,
    );
  });

  it.each(['../etc/passwd', 'a/b', './x', 'a\\b', '', '.', '..', 'a b'])(
    'slug %o は例外になり、fetch を 1 度も呼ばない',
    async (slug) => {
      const { calls } = installFetch();
      await expect(publisher().publish(input({ slug }))).rejects.toThrow();
      expect(calls, '検証前に GitHub を呼ばない').toHaveLength(0);
    },
  );

  it('正常な slug から作られるパスが posts ディレクトリの直下に収まる', async () => {
    const { calls } = installFetch();
    await publisher().publish(input({ slug: 'node-24-notes' }));
    const tree = (findCall(calls, 'POST', TREE_PATH).body?.['tree'] as Array<Record<string, unknown>>) ?? [];
    const path = String(tree[0]?.['path']);
    expect(path).toBe('site/src/content/posts/node-24-notes.md');
    expect(path.startsWith(SITE_POSTS_PATH_PREFIX)).toBe(true);
    expect(path.slice(SITE_POSTS_PATH_PREFIX.length)).not.toContain('/');
  });

  it('**日付パスの slug が posts の下の階層に収まる**', async () => {
    // 投稿日時から導出した slug。Phase 3 でこれが既定になる。
    const { calls } = installFetch();
    await publisher(logger(), 'posts/').publish(input({ slug: '2026/09/08/054001' }));
    const tree = (findCall(calls, 'POST', TREE_PATH).body?.['tree'] as Array<Record<string, unknown>>) ?? [];
    expect(tree[0]?.['path']).toBe('posts/2026/09/08/054001.md');
  });

  it('日付パスでも存在確認のパスが追随する', async () => {
    // TOCTOU 対策の存在確認は path を使って組み立てる。階層が増えても同じ path を見ること。
    const { calls } = installFetch();
    await publisher(logger(), 'posts/').publish(input({ slug: '2026/09/08/054001' }));
    const lookup = calls.find((c) => c.method === 'GET' && c.path.startsWith(CONTENTS_PREFIX));
    expect(lookup?.path).toBe(`${CONTENTS_PREFIX}posts/2026/09/08/054001.md`);
  });

  it.each([
    'posts/2026/09/08/054001', // **日付パス時代に元の事故が起きた形**
    '2026/09/054001', // 階層が足りない
    '2026/09/08/09/054001', // 階層が多い
    '2026/9/8/54001', // ゼロ埋めなし
    '2026/09/08/054001/', // 末尾スラッシュ
    '2026/09/../08/054001', // 日付パスの皮をかぶった traversal
  ])('日付パスに似ているだけの slug %o は例外になり、fetch を 1 度も呼ばない', async (slug) => {
    const { calls } = installFetch();
    await expect(publisher(logger(), 'posts/').publish(input({ slug }))).rejects.toThrow(
      /slug must match/,
    );
    expect(calls, '検証前に GitHub を呼ばない').toHaveLength(0);
  });
});

describe('既存スラッグの上書き', () => {
  /** 記事が既にある世界。存在確認だけを 200 にする。 */
  const existingResponder = (call: FetchCall): Response =>
    call.method === 'GET' && call.path.startsWith(CONTENTS_PREFIX)
      ? json({ type: 'file', path: call.path.slice(CONTENTS_PREFIX.length), sha: BLOB_SHA })
      : defaultResponder(call);

  const WRITE_METHODS = new Set(['POST', 'PATCH']);

  it('**既存スラッグは SlugConflictError で拒否される**', async () => {
    installFetch(existingResponder);
    await expect(publisher().publish(input())).rejects.toBeInstanceOf(SlugConflictError);
  });

  it('**拒否されたとき blob も tree も commit も ref 更新も起きない**', async () => {
    // ここが本丸。書き込みが 1 本でも飛べば「途中まで書けた」状態が生まれる。
    const { calls } = installFetch(existingResponder);
    await publisher().publish(input()).catch(() => undefined);
    expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([]);
  });

  it('存在確認が base commit に固定されている（TOCTOU を作らない）', async () => {
    // コミットの親も ref 更新の前提も同じ base。間に他人が main を進めれば
    // PATCH が 422 になるので、古い読みに基づいて踏み潰す窓が無い。
    const { calls } = installFetch();
    await publisher().publish(input());
    const lookup = findCall(calls, 'GET', '/repos/shutx-net/blog/contents/site/src/content/posts/hello-world.md');
    expect(lookup.search).toBe(`?ref=${BASE_COMMIT_SHA}`);
  });

  it('存在確認は ref の取得より後、blob の作成より前に来る', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    const at = (method: string, path: string): number =>
      calls.findIndex((c) => c.method === method && c.path === path);
    const ref = at('GET', '/repos/shutx-net/blog/git/ref/heads/main');
    const lookup = at('GET', '/repos/shutx-net/blog/contents/site/src/content/posts/hello-world.md');
    const blob = at('POST', BLOB_PATH);
    expect(ref).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(ref);
    expect(blob).toBeGreaterThan(lookup);
  });

  it('overwrite が true なら成功し、replaced: true を返す', async () => {
    installFetch(existingResponder);
    const result = await publisher().publish(input({ overwrite: true }));
    expect(result).toEqual({
      commitSha: NEW_COMMIT_SHA,
      path: 'site/src/content/posts/hello-world.md',
      replaced: true,
    });
  });

  it('**上書きのときは replaceMessage がコミットメッセージになる**', async () => {
    const { calls } = installFetch(existingResponder);
    await publisher().publish(input({ overwrite: true }));
    expect(findCall(calls, 'POST', COMMIT_PATH).body?.['message']).toBe(
      'feat(site): 記事 hello-world を更新',
    );
  });

  it('**overwrite が true でも実在しなければ createMessage を使い replaced: false を返す**', async () => {
    // 409 を受けてから承認するまでに誰かが記事を消した場合。
    // 「更新」と書かれたコミットが作成に付くと、履歴が嘘をつく。
    const { calls } = installFetch();
    const result = await publisher().publish(input({ overwrite: true }));
    expect(findCall(calls, 'POST', COMMIT_PATH).body?.['message']).toBe(
      'feat(site): 記事 hello-world を追加',
    );
    expect(result.replaced).toBe(false);
  });

  it('存在確認が 200 でも 404 でもないときは書き込まずに落ちる（fail closed）', async () => {
    // 500 を「無い」と読むと、既存記事を黙って踏み潰す方向に倒れる。
    const { calls } = installFetch((call) =>
      call.method === 'GET' && call.path.startsWith(CONTENTS_PREFIX)
        ? json({ message: 'boom' }, 500)
        : defaultResponder(call),
    );
    await expect(publisher().publish(input())).rejects.toThrow(/content lookup failed with status 500/);
    expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([]);
  });

  it('403（権限不足）も「無い」と解釈しない', async () => {
    const { calls } = installFetch((call) =>
      call.method === 'GET' && call.path.startsWith(CONTENTS_PREFIX)
        ? json({ message: 'Forbidden' }, 403)
        : defaultResponder(call),
    );
    await expect(publisher().publish(input())).rejects.toThrow(/content lookup failed/);
    expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([]);
  });

  it('接頭辞を変えても存在確認のパスが追随する', async () => {
    const { calls } = installFetch();
    await publisher(logger(), 'posts/').publish(input());
    expect(calls.some((c) => c.path === '/repos/shutx-net/blog/contents/posts/hello-world.md')).toBe(true);
  });

  it('SlugConflictError の message にトークンもレスポンス本文も出ない', async () => {
    installFetch((call) =>
      call.method === 'GET' && call.path.startsWith(CONTENTS_PREFIX)
        ? json({ message: 'leaked ghs_test_token here' }, 200)
        : defaultResponder(call),
    );
    let text = '';
    try {
      await publisher().publish(input());
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain('ghs_test_token');
    expect(text).not.toContain('leaked');
  });
});

describe('秘密が漏れない', () => {
  it('installation token がログに現れない', async () => {
    const log = logger();
    installFetch();
    await publisher(log).publish(input());
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain('ghs_test_token');
  });

  it('失敗時の例外に token もレスポンス本文も出ない', async () => {
    installFetch((call) =>
      call.method === 'PATCH'
        ? json({ message: 'leaked ghs_test_token here' }, 500)
        : defaultResponder(call),
    );
    let text = '';
    try {
      await publisher().publish(input());
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain('ghs_test_token');
    expect(text).not.toContain('leaked');
  });
});
