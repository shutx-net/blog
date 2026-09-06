import type { InstallationTokenProvider, Logger, PostPublisher, PublishInput, PublishResult } from '../deps.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION } from './token.ts';

/**
 * コミット先のブランチ。
 *
 * **main 固定にしているのは infra/lib/cicd-stack.ts の信頼ポリシーと結合しているから。**
 * デプロイロールの sub 条件が `repo:shutx-net/blog:ref:refs/heads/main` に
 * StringEquals で固定されているので、他のブランチにコミットしても GitHub Actions の
 * デプロイは動かない。ここを変えるなら cicd-stack.ts も一緒に変えること。
 */
export const TARGET_BRANCH = 'main';

/**
 * 記事リポジトリを分離する**前**の接頭辞。code repo の中での記事の置き場所。
 *
 * **もう infra は渡さない。** 残しているのは、切り替えが後戻りしていないことを
 * posting-api.test.ts が名指しで主張するため（`not.toBe(SITE_POSTS_PATH_PREFIX)`）。
 */
export const SITE_POSTS_PATH_PREFIX = 'site/src/content/posts/';

/**
 * blog-content の中での記事の置き場所。**infra が今日この値を渡す。**
 *
 * **定数を直接使わないこと** — 値は deps 経由で注入する。ハードコードすると、
 * 宛先リポジトリだけ切り替えた日に blog-content の中へ site/src/content/posts/ が生える。
 */
export const CONTENT_POSTS_PATH_PREFIX = 'posts/';

/** Git の通常ファイル。docs の列挙は 100644 / 100755 / 040000 / 160000 / 120000。 */
const FILE_MODE = '100644';

/**
 * ref の更新が競合したときに投げる。
 *
 * **これを受けてリトライしてはいけない。** force なしの PATCH が 422 になるのは
 * 「他の誰かが main を進めた」という意味で、再試行は他人のコミットを踏み潰す方向にしか働かない。
 */
export class ConcurrentUpdateError extends Error {
  constructor() {
    super(`ref refs/heads/${TARGET_BRANCH} moved while committing; retry the request`);
    this.name = 'ConcurrentUpdateError';
  }
}

export interface PostPublisherDeps {
  tokenProvider: InstallationTokenProvider;
  owner: string;
  repo: string;
  /** 記事を置くディレクトリ。末尾のスラッシュを含む。 */
  postsPathPrefix: string;
  logger: Logger;
}

/**
 * slug からファイルパスを組み立てる。
 *
 * **posts ディレクトリの外に出られないことをここでも検査する**（3.6 の検証と二重化）。
 * 検証は「安全な形だけを通す」allowlist で行う。'../' を除去する blocklist 方式は、
 * 除去後に再び '../' が現れる入力（'....//'）で破れる。
 */
const pathForSlug = (prefix: string, slug: string): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/');
  }
  return `${prefix}${slug}.md`;
};

export const createPostPublisher = (deps: PostPublisherDeps): PostPublisher => {
  const repoPath = `/repos/${deps.owner}/${deps.repo}`;

  const request = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${GITHUB_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`GitHub request ${method} ${path} failed (${(error as Error).name})`);
    }
  };

  /** status だけを転記する。**レスポンス本文は読まない**（token をエコーされても漏らさない）。 */
  const assertOk = (response: Response, what: string): void => {
    if (!response.ok) throw new Error(`GitHub ${what} failed with status ${response.status}`);
  };

  const publish = async (input: PublishInput): Promise<PublishResult> => {
    // **GitHub を呼ぶ前に検証する。** 検証で落ちる入力で 1 本でもリクエストが飛ぶと、
    // 失敗が「途中まで書けた」状態になりうる。
    const path = pathForSlug(deps.postsPathPrefix, input.slug);
    const token = await deps.tokenProvider.getToken();

    // 1. blob。base64 で送る — YAML front matter と本文に何が来ても安全に運べる。
    const blobResponse = await request('POST', `${repoPath}/git/blobs`, token, {
      content: Buffer.from(input.markdown, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    assertOk(blobResponse, 'blob creation');
    const blobSha = ((await blobResponse.json()) as { sha?: string }).sha;
    if (typeof blobSha !== 'string') throw new Error('GitHub blob response has no sha');

    // 2. 参照の取得は **単数形** git/ref/heads/main（docs の operation path）。
    const refResponse = await request('GET', `${repoPath}/git/ref/heads/${TARGET_BRANCH}`, token);
    assertOk(refResponse, 'ref lookup');
    const baseCommitSha = ((await refResponse.json()) as { object?: { sha?: string } }).object?.sha;
    if (typeof baseCommitSha !== 'string') throw new Error('GitHub ref response has no object.sha');

    // 3. 親コミットから **tree の sha** を取る。commit の sha ではない。
    const commitResponse = await request('GET', `${repoPath}/git/commits/${baseCommitSha}`, token);
    assertOk(commitResponse, 'commit lookup');
    const baseTreeSha = ((await commitResponse.json()) as { tree?: { sha?: string } }).tree?.sha;
    if (typeof baseTreeSha !== 'string') throw new Error('GitHub commit response has no tree.sha');

    // 4. tree。**base_tree を必ず渡す。**
    //    docs: "If not provided, GitHub will create a new Git tree object from only the
    //    entries defined in the tree parameter. ... all files which were a part of the
    //    parent commit's tree and were not defined in the tree parameter will be listed
    //    as deleted." — **落とすとリポジトリ全体が 1 コミットで消える。**
    const treeResponse = await request('POST', `${repoPath}/git/trees`, token, {
      base_tree: baseTreeSha,
      // sha と content を同時に入れない（docs: "Using both tree.sha and content will
      // return an error"）。blob は上で作ってあるので sha だけを指す。
      tree: [{ path, mode: FILE_MODE, type: 'blob', sha: blobSha }],
    });
    assertOk(treeResponse, 'tree creation');
    const treeSha = ((await treeResponse.json()) as { sha?: string }).sha;
    if (typeof treeSha !== 'string') throw new Error('GitHub tree response has no sha');

    // 5. commit。parents を省くと root commit になり履歴が切れる。
    const newCommitResponse = await request('POST', `${repoPath}/git/commits`, token, {
      message: input.message,
      tree: treeSha,
      parents: [baseCommitSha],
    });
    assertOk(newCommitResponse, 'commit creation');
    const commitSha = ((await newCommitResponse.json()) as { sha?: string }).sha;
    if (typeof commitSha !== 'string') throw new Error('GitHub commit creation response has no sha');

    // 6. 参照の更新は **複数形** git/refs/heads/main。force は渡さない
    //    （docs: "Leaving this out or setting it to false will make sure you're not
    //    overwriting work"）。**ここが GitHub Actions のビルドを起動する唯一のトリガ。**
    const updateResponse = await request(
      'PATCH',
      `${repoPath}/git/refs/heads/${TARGET_BRANCH}`,
      token,
      { sha: commitSha },
    );
    if (updateResponse.status === 422) {
      // 本文の文言（'Update is not a fast forward'）は docs に載っていないので依存しない。
      throw new ConcurrentUpdateError();
    }
    assertOk(updateResponse, 'ref update');

    deps.logger.info('committed post', { path, commitSha });
    return { commitSha, path };
  };

  return { publish };
};
