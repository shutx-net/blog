import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConcurrentUpdateError,
  POSTS_DIR,
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
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** docs の Response schema に沿った最小のフェイク。 */
const defaultResponder = (call: FetchCall): Response => {
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

const publisher = (log = logger()) =>
  createPostPublisher({
    tokenProvider: { getToken: vi.fn(async () => 'ghs_test_token') },
    owner: 'shutx-net',
    repo: 'blog',
    logger: log,
  });

const input = (overrides: Partial<{ slug: string; markdown: string; message: string }> = {}) => ({
  slug: 'hello-world',
  markdown: '---\ntitle: "テスト"\n---\n\n本文\n',
  message: 'feat(site): 記事 hello-world を追加',
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const callOf = (calls: FetchCall[], index: number): FetchCall => calls[index] as FetchCall;

describe('呼び出し列', () => {
  it('正確に 6 本で、順序も固定されている', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/repos/shutx-net/blog/git/blobs'],
      ['GET', '/repos/shutx-net/blog/git/ref/heads/main'],
      ['GET', `/repos/shutx-net/blog/git/commits/${BASE_COMMIT_SHA}`],
      ['POST', '/repos/shutx-net/blog/git/trees'],
      ['POST', '/repos/shutx-net/blog/git/commits'],
      ['PATCH', '/repos/shutx-net/blog/git/refs/heads/main'],
    ]);
  });

  it('すべての呼び出しが installation token を Bearer で送る', async () => {
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(calls).toHaveLength(6);
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
    const body = callOf(calls, 0).body ?? {};
    expect(Object.keys(body).sort()).toEqual(['content', 'encoding']);
    expect(body['encoding']).toBe('base64');
    expect(typeof body['content']).toBe('string');
  });

  it('UTF-8 の日本語本文が base64 往復で 1 バイトも変わらない', async () => {
    const markdown = '---\ntitle: "日本語のタイトル"\n---\n\n絵文字 🎌 と ASCII と ～〜①\n';
    const { calls } = installFetch();
    await publisher().publish(input({ markdown }));
    const content = String(callOf(calls, 0).body?.['content']);
    expect(Buffer.from(content, 'base64').toString('utf8')).toBe(markdown);
  });

  it("encoding に 'utf-8' を使わない", async () => {
    // docs: "Currently, \"utf-8\" and \"base64\" are supported"。base64 を選ぶのは
    // YAML front matter と本文に何が来ても安全に運べるから。
    const { calls } = installFetch();
    await publisher().publish(input());
    expect(callOf(calls, 0).body?.['encoding']).not.toBe('utf-8');
  });
});

describe('tree の作成', () => {
  const treeBody = async (): Promise<Record<string, unknown>> => {
    const { calls } = installFetch();
    await publisher().publish(input());
    return callOf(calls, 3).body ?? {};
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
  const commitBody = async (message?: string): Promise<Record<string, unknown>> => {
    const { calls } = installFetch();
    await publisher().publish(message === undefined ? input() : input({ message }));
    return callOf(calls, 4).body ?? {};
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
    const body = callOf(calls, 5).body ?? {};
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
  it('POSTS_DIR が site/src/content/posts/ である', () => {
    expect(POSTS_DIR).toBe('site/src/content/posts/');
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
    const tree = (callOf(calls, 3).body?.['tree'] as Array<Record<string, unknown>>) ?? [];
    const path = String(tree[0]?.['path']);
    expect(path).toBe('site/src/content/posts/node-24-notes.md');
    expect(path.startsWith(POSTS_DIR)).toBe(true);
    expect(path.slice(POSTS_DIR.length)).not.toContain('/');
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
