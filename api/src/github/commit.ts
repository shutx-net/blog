import type { InstallationTokenProvider, Logger, PostPublisher, PublishInput, PublishResult } from '../deps.ts';
import { POST_SLUG_PATTERN } from '../posts/slug.ts';
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

/**
 * 既にある記事のスラッグに、上書きの意思なしで投稿しようとしたときに投げる。
 *
 * **これはルータで 409 になる。** 黙って上書きすると、公開済みの記事が警告なしに
 * 消える（2026-09-07 に実際に起きた: 下書きから復元された slug が前回のまま残り、
 * 別の記事として書いたつもりの投稿が既存の posts/test.md を置き換えた）。
 */
export class SlugConflictError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    // slug は POST_SLUG_PATTERN で [a-z0-9-] か日付パスの数字とスラッシュに限定されて
    // いるので、資格情報は載りえない（増えたのは数字と '/' だけで結論は変わらない）。
    // それでも HTTP 応答には出さない（入力をエコーしない規律は router が持つ）。
    super(`post '${slug}' already exists; pass overwrite to replace it`);
    this.name = 'SlugConflictError';
    this.slug = slug;
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
 *
 * **日付パス（`2026/09/08/054001`）はスラッシュを含むが、封じ込めは弱まっていない。**
 * `POST_SLUG_PATTERN` は平坦スラッグと日付パスの和で、**両辺とも strict allowlist**
 * （文字クラスは `[a-z0-9]` と `[0-9]` だけ、桁数も固定）なので、`..` も `\` も
 * 表現できない。スラッシュを許したことと traversal を許したことは別である。
 */
const pathForSlug = (prefix: string, slug: string): string => {
  if (!POST_SLUG_PATTERN.test(slug)) {
    throw new Error(`slug must match ${POST_SLUG_PATTERN.source}`);
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

    // 1. 参照の取得は **単数形** git/ref/heads/main（docs の operation path）。
    //    **最初に base を決めるのが、この関数の並び順の理由。** 以降の存在確認・
    //    コミットの親・ref 更新の前提を、すべてこの 1 つの sha に揃える。
    const refResponse = await request('GET', `${repoPath}/git/ref/heads/${TARGET_BRANCH}`, token);
    assertOk(refResponse, 'ref lookup');
    const baseCommitSha = ((await refResponse.json()) as { object?: { sha?: string } }).object?.sha;
    if (typeof baseCommitSha !== 'string') throw new Error('GitHub ref response has no object.sha');

    // 2. **既存記事の確認。書き込みを 1 本も出す前に行う。**
    //
    //    Contents API を使うのは、既に持っている base tree では判定できないから。
    //    docs (Get a tree): 既定では最上位のエントリしか返さないので、posts/ は
    //    「tree 型のエントリ 1 件」としてしか見えない。?recursive=1 なら全件返るが、
    //    **100,000 エントリ / 7 MB を超えると truncated: true で黙って切り詰められる** —
    //    それを「無い」と読む実装は、育ったリポジトリでいつか公開記事を踏み潰す。
    //    Contents API は 200 / 404 で答えるので、その罠が無い。追加の呼び出しは 1 本。
    //
    //    **?ref に base commit の sha を渡すのが TOCTOU 対策の要。** ブランチ名で
    //    問い合わせると「確認した木」と「コミットの親にする木」がずれうる。
    //    同じ sha に固定したうえで、6 の PATCH を force なしにしてあるので、
    //    確認とコミットの間に main が進めば ref 更新が 422 で落ちる。
    //    **古い読みに基づいて上書きする窓が無い。**
    const lookupResponse = await request(
      'GET',
      `${repoPath}/contents/${path}?ref=${baseCommitSha}`,
      token,
    );
    if (lookupResponse.status !== 200 && lookupResponse.status !== 404) {
      // **404 以外の失敗を「無い」と読まない（fail closed）。** 403 や 500 を不在と
      // 解釈すると、権限が落ちた日に既存記事を黙って置き換える方向に倒れる。
      throw new Error(`GitHub content lookup failed with status ${lookupResponse.status}`);
    }
    const replaced = lookupResponse.status === 200;
    if (replaced && !input.overwrite) throw new SlugConflictError(input.slug);

    // 3. 親コミットから **tree の sha** を取る。commit の sha ではない。
    const commitResponse = await request('GET', `${repoPath}/git/commits/${baseCommitSha}`, token);
    assertOk(commitResponse, 'commit lookup');
    const baseTreeSha = ((await commitResponse.json()) as { tree?: { sha?: string } }).tree?.sha;
    if (typeof baseTreeSha !== 'string') throw new Error('GitHub commit response has no tree.sha');

    // 4. blob。base64 で送る — YAML front matter と本文に何が来ても安全に運べる。
    const blobResponse = await request('POST', `${repoPath}/git/blobs`, token, {
      content: Buffer.from(input.markdown, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    assertOk(blobResponse, 'blob creation');
    const blobSha = ((await blobResponse.json()) as { sha?: string }).sha;
    if (typeof blobSha !== 'string') throw new Error('GitHub blob response has no sha');

    // 5. tree。**base_tree を必ず渡す。**
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

    // 6. commit。parents を省くと root commit になり履歴が切れる。
    //
    //    **メッセージは「実際に何をしたか」で選ぶ。** overwrite が true でも記事が
    //    実在しなければ作成なので、createMessage を使う（409 を承認する間に誰かが
    //    記事を消した場合。「更新」と書かれたコミットが作成に付くと履歴が嘘をつく）。
    const newCommitResponse = await request('POST', `${repoPath}/git/commits`, token, {
      message: replaced ? input.replaceMessage : input.createMessage,
      tree: treeSha,
      parents: [baseCommitSha],
    });
    assertOk(newCommitResponse, 'commit creation');
    const commitSha = ((await newCommitResponse.json()) as { sha?: string }).sha;
    if (typeof commitSha !== 'string') throw new Error('GitHub commit creation response has no sha');

    // 7. 参照の更新は **複数形** git/refs/heads/main。force は渡さない
    //    （docs: "Leaving this out or setting it to false will make sure you're not
    //    overwriting work"）。**ここが GitHub Actions のビルドを起動する唯一のトリガ。**
    //    2 の存在確認を同じ base に固定しているので、force を足すとその保証ごと壊れる。
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

    deps.logger.info('committed post', { path, commitSha, replaced });
    return { commitSha, path, replaced };
  };

  return { publish };
};
