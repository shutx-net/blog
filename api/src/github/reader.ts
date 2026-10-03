import type { InstallationTokenProvider, Logger, PostDetail, PostReader, PostSummary } from '../deps.ts';
import { DATE_SLUG_PATTERN } from '../posts/slug.ts';
import { parseMarkdown } from '../posts/parse-frontmatter.ts';
import { TARGET_BRANCH, pathForSlug } from './commit.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION } from './token.ts';

/**
 * 記事が見つからなかったときに投げる。
 *
 * **ルータで 404 になる。** `auth.ts` が 403/404 を禁じているのは *認可失敗* の写像で
 * あって、リソースの不在は別の話。ただし CloudFront の `CustomErrorResponses` が
 * origin の 404 を HTML に差し替えるので、admin 側には JSON が届かず
 * `NON_JSON_RESPONSE` として見える（`client.ts` が既にその扱いを持っている）。
 */
export class PostNotFoundError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    // slug は DATE_SLUG_PATTERN を通った値なので数字とスラッシュだけ。
    super(`post '${slug}' does not exist`);
    this.name = 'PostNotFoundError';
    this.slug = slug;
  }
}

export interface PostReaderDeps {
  tokenProvider: InstallationTokenProvider;
  owner: string;
  repo: string;
  /** 記事を置くディレクトリ。末尾のスラッシュを含む。 */
  postsPathPrefix: string;
  logger: Logger;
}

/** GitHub が base64 以外で返したときに落とすための期待値。 */
const EXPECTED_ENCODING = 'base64';

interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
}

export const createPostReader = (deps: PostReaderDeps): PostReader => {
  const repoPath = `/repos/${deps.owner}/${deps.repo}`;

  const request = async (path: string, token: string): Promise<Response> => {
    try {
      return await fetch(`${GITHUB_API_BASE}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      // **元の例外を素通ししない。** fetch の例外メッセージには URL が載る。
      throw new Error(`GitHub request GET ${path} failed (${(error as Error).name})`);
    }
  };

  /** status だけを転記する。**レスポンス本文は読まない**（token をエコーされても漏らさない）。 */
  const assertOk = (response: Response, what: string): void => {
    if (!response.ok) throw new Error(`GitHub ${what} failed with status ${response.status}`);
  };

  /**
   * base64 の `content` を UTF-8 に戻す。
   *
   * **`encoding` を確かめるのが要点。** Contents API は 1 MB を超えるファイルに対して
   * `content: ""` / `encoding: "none"` を返す。確かめずにデコードすると
   * **front matter が空の記事**として扱われ、`parseMarkdown` が「必須キーが無い」と
   * 言い出す。原因から遠いエラーになるので、ここで落とす。
   */
  const decodeContent = (payload: { content?: string; encoding?: string }, what: string): string => {
    if (payload.encoding !== EXPECTED_ENCODING) {
      throw new Error(
        `GitHub ${what} returned encoding '${String(payload.encoding)}'; expected ${EXPECTED_ENCODING}`,
      );
    }
    if (typeof payload.content !== 'string') {
      throw new Error(`GitHub ${what} response has no content`);
    }
    return Buffer.from(payload.content, 'base64').toString('utf8');
  };

  /**
   * **base commit の sha を先に決める。** 一覧の tree と、その中の blob を
   * 同じコミットから読む。ブランチ名で引くと、tree を読んだ後に main が進めば
   * 「一覧には居るが blob は別のもの」という組み合わせが作れる。
   */
  const baseCommitSha = async (token: string): Promise<string> => {
    const response = await request(`${repoPath}/git/ref/heads/${TARGET_BRANCH}`, token);
    assertOk(response, 'ref lookup');
    const sha = ((await response.json()) as { object?: { sha?: string } }).object?.sha;
    if (typeof sha !== 'string') throw new Error('GitHub ref response has no object.sha');
    return sha;
  };

  /** パスから slug を復元する。**形が合わなければ throw**（無視して隠さない）。 */
  const slugForPath = (path: string): string => {
    const slug = path.slice(deps.postsPathPrefix.length, -'.md'.length);
    if (!DATE_SLUG_PATTERN.test(slug)) {
      // **黙って飛ばさない。** 想定外の形のファイルが content repo に入ったという
      // 合図であり、それは deploy.yml のスラッグ照合ガードが止める状態でもある。
      // 一覧だけ通してしまうと「管理画面には見えるがデプロイは落ちる」ことになる。
      throw new Error(`post path '${path}' does not yield a slug matching ${DATE_SLUG_PATTERN.source}`);
    }
    return slug;
  };

  const list = async (): Promise<PostSummary[]> => {
    const token = await deps.tokenProvider.getToken();
    const commitSha = await baseCommitSha(token);

    const commitResponse = await request(`${repoPath}/git/commits/${commitSha}`, token);
    assertOk(commitResponse, 'commit lookup');
    const treeSha = ((await commitResponse.json()) as { tree?: { sha?: string } }).tree?.sha;
    if (typeof treeSha !== 'string') throw new Error('GitHub commit response has no tree.sha');

    // **?recursive=1 が要る。** 既定は最上位のエントリだけなので、日付パスの記事は
    // `posts` という tree 型のエントリ 1 件にしか見えない。
    const treeResponse = await request(`${repoPath}/git/trees/${treeSha}?recursive=1`, token);
    assertOk(treeResponse, 'tree lookup');
    const tree = (await treeResponse.json()) as { tree?: TreeEntry[]; truncated?: boolean };

    // **切り詰めを「記事が無い」と読まない（fail closed）。**
    // 100,000 エントリ / 7 MB を超えると truncated: true で黙って削られる。
    // 一覧が短くなるだけでなく、公開可能数の床を誤らせる。
    if (tree.truncated === true) {
      throw new Error('GitHub tree response is truncated; cannot list posts reliably');
    }

    const entries = (tree.tree ?? []).filter(
      (entry): entry is { path: string; sha: string } =>
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        typeof entry.sha === 'string' &&
        entry.path.startsWith(deps.postsPathPrefix) &&
        entry.path.endsWith('.md'),
    );

    const posts: PostSummary[] = [];
    for (const entry of entries) {
      const slug = slugForPath(entry.path);
      const blobResponse = await request(`${repoPath}/git/blobs/${entry.sha}`, token);
      assertOk(blobResponse, 'blob lookup');
      const payload = (await blobResponse.json()) as { content?: string; encoding?: string };
      const { title, description, pubDate, draft, tags } = parseMarkdown(
        decodeContent(payload, 'blob lookup'),
      );
      posts.push({ slug, title, description, pubDate, draft, tags, sha: entry.sha });
    }

    // **slug の降順。** slug は pubDate から導出した日付パスなので、辞書順が時系列順に
    // なる。pubDate を parse して並べ替えるより安く、手で編集して pubDate と slug が
    // 食い違った記事でも順序が決定的になる（URL の順序と一致する）。
    posts.sort((left, right) => (left.slug < right.slug ? 1 : left.slug > right.slug ? -1 : 0));

    deps.logger.info('listed posts', { count: posts.length, commitSha });
    return posts;
  };

  const read = async (slug: string): Promise<PostDetail> => {
    // **GitHub を呼ぶ前に検証する。** publisher と同じ `pathForSlug` を通す。
    const path = pathForSlug(deps.postsPathPrefix, slug);
    const token = await deps.tokenProvider.getToken();
    const commitSha = await baseCommitSha(token);

    // **?ref に commit の sha を渡す。** ブランチ名で引くと、返した blob sha が
    // 「どの木のものか」が曖昧になる。この sha が編集・削除の楽観的並行制御のトークンになる。
    const response = await request(`${repoPath}/contents/${path}?ref=${commitSha}`, token);
    if (response.status === 404) throw new PostNotFoundError(slug);
    // **404 以外の失敗を「無い」と読まない（fail closed）。** 403 や 500 を不在と
    // 解釈すると、権限が落ちた日に「記事が消えた」と表示し、削除の床判定も誤らせる。
    assertOk(response, 'content lookup');

    const payload = (await response.json()) as { content?: string; encoding?: string; sha?: string };
    if (typeof payload.sha !== 'string') throw new Error('GitHub content response has no sha');
    const parsed = parseMarkdown(decodeContent(payload, 'content lookup'));

    deps.logger.info('read post', { path, commitSha });
    return { slug, ...parsed, sha: payload.sha };
  };

  return { list, read };
};
