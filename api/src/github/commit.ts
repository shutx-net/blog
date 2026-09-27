import type {
  DeleteInput,
  InstallationTokenProvider,
  Logger,
  PostPublisher,
  PublishInput,
  PublishResult,
  UpdateInput,
} from '../deps.ts';
import { DATE_SLUG_PATTERN } from '../posts/slug.ts';
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
    // slug は DATE_SLUG_PATTERN で数字とスラッシュだけに限定されているので、
    // 資格情報は載りえない。それでも HTTP 応答には出さない
    // （入力をエコーしない規律は router が持つ）。
    super(`post '${slug}' already exists; pass overwrite to replace it`);
    this.name = 'SlugConflictError';
    this.slug = slug;
  }
}

/**
 * 読んだときと中身が変わっていた（あるいは消えていた）ときに投げる。
 *
 * **ルータで 409 になる。** 呼び出し側が送ってきた blob sha が、コミットの base に
 * 固定して引いた現在の sha と一致しないという意味。**リトライしてはいけない** —
 * 同じ sha で再送しても一致しないし、sha を取り直して再送するのは
 * 「他人の変更を読まずに踏み潰す」ことになる。読み直すのが唯一の正しい対応。
 *
 * 記事が消えていた場合も同じ。存在しない blob の sha は一致しえないので、
 * 「変わった」と「消えた」を別の例外に分けていない — **利用者の対応が同じ**
 * （読み直す）なら、区別は情報を増やさずに分岐を増やすだけ。
 */
export class StalePostError extends Error {
  constructor() {
    super('the post changed since it was read; re-read it before saving');
    this.name = 'StalePostError';
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
 * **posts ディレクトリの外に出られないことをここでも検査する**（入力側の検証と二重化）。
 * 「安全な形だけを通す」allowlist で行う — '../' を除去する blocklist 方式は、除去後に
 * 再び '../' が現れる入力（'....//'）で破れる。
 *
 * 日付パス（`2026/09/08/054001`）はスラッシュを含むが封じ込めは弱まっていない。
 * `DATE_SLUG_PATTERN` は **strict allowlist**（文字クラスは `[0-9]` だけ、桁数も階層も固定）
 * で `..` も `\` も表現できない。**スラッシュを許したことと traversal を許したことは別である。**
 *
 * **export しているのは reader.ts が同じ検査を使うため。** 写しを作ると片方だけ緩む。
 */
export const pathForSlug = (prefix: string, slug: string): string => {
  if (!DATE_SLUG_PATTERN.test(slug)) {
    throw new Error(`slug must match ${DATE_SLUG_PATTERN.source}`);
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

  /**
   * **コミットの base を決め、同じ base で対象の現況を読む。**
   *
   * `publish` と `update` が**同じ手順を通ることがこの関数の存在理由**である。
   * 写しを 2 本持つと、片方だけ `?ref` をブランチ名に戻したり、片方だけ
   * 存在確認を飛ばしたりする形で静かに緩む。
   */
  const locate = async (
    slug: string,
  ): Promise<{ token: string; baseCommitSha: string; path: string; existingSha: string | undefined }> => {
    // **GitHub を呼ぶ前に検証する。** 検証で落ちる入力で 1 本でもリクエストが飛ぶと、
    // 失敗が「途中まで書けた」状態になりうる。
    const path = pathForSlug(deps.postsPathPrefix, slug);
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
    //    base tree では判定できないので Contents API を使う。docs (Get a tree) の既定は
    //    最上位のエントリだけなので posts/ は「tree 型のエントリ 1 件」にしか見えず、
    //    ?recursive=1 は **100,000 エントリ / 7 MB を超えると truncated: true で黙って
    //    切り詰められる** — それを「無い」と読む実装は、育ったリポジトリでいつか公開記事を
    //    踏み潰す。Contents API は 200 / 404 で答えるのでその罠が無い。呼び出しは 1 本。
    //
    //    **?ref に base commit の sha を渡すのが TOCTOU 対策の要。** ブランチ名で問い合わせ
    //    ると「確認した木」と「コミットの親にする木」がずれうる。同じ sha に固定したうえで
    //    ref の PATCH を force なしにしてあるので、確認とコミットの間に main が進めば ref 更新
    //    が 422 で落ちる。**古い読みに基づいて上書きする窓が無い。**
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
    if (lookupResponse.status === 404) {
      return { token, baseCommitSha, path, existingSha: undefined };
    }

    // **sha を読む。** 更新の楽観的並行制御はこの値との一致で行う。
    const existingSha = ((await lookupResponse.json()) as { sha?: string }).sha;
    if (typeof existingSha !== 'string') throw new Error('GitHub content response has no sha');
    return { token, baseCommitSha, path, existingSha };
  };

  /**
   * blob -> tree -> commit -> ref を 1 コミットで通す。
   *
   * **`locate` が決めた base をそのまま受け取るのが要点。** ここで base を
   * 取り直すと、存在確認と ref 更新の前提がずれて TOCTOU の穴が開く。
   */
  const writeCommit = async (args: {
    token: string;
    baseCommitSha: string;
    path: string;
    /**
     * tree に何を載せるか。**書き込みと削除で分岐するのはここだけ。**
     *
     * 削除のために別の関数を置くと、`base_tree` を渡す行と `parents` を渡す行が
     * 2 箇所に増える。どちらも**落とすとリポジトリが壊れる**行なので、写しを作らない。
     */
    change: { kind: 'write'; markdown: string } | { kind: 'delete' };
    message: string;
  }): Promise<string> => {
    const { token, baseCommitSha, path } = args;

    // 3. 親コミットから **tree の sha** を取る。commit の sha ではない。
    const commitResponse = await request('GET', `${repoPath}/git/commits/${baseCommitSha}`, token);
    assertOk(commitResponse, 'commit lookup');
    const baseTreeSha = ((await commitResponse.json()) as { tree?: { sha?: string } }).tree?.sha;
    if (typeof baseTreeSha !== 'string') throw new Error('GitHub commit response has no tree.sha');

    // 4. blob。base64 で送る — YAML front matter と本文に何が来ても安全に運べる。
    //
    //    **削除では blob を作らない。** docs (Create a tree): "If the value is null
    //    then the file will be deleted." — 消すだけなら中身は要らないので、
    //    無駄な書き込みリクエストを出さない。
    let blobSha: string | null = null;
    if (args.change.kind === 'write') {
      const blobResponse = await request('POST', `${repoPath}/git/blobs`, token, {
        content: Buffer.from(args.change.markdown, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      assertOk(blobResponse, 'blob creation');
      const created = ((await blobResponse.json()) as { sha?: string }).sha;
      if (typeof created !== 'string') throw new Error('GitHub blob response has no sha');
      blobSha = created;
    }

    // 5. tree。**base_tree を必ず渡す。**
    //    docs: "If not provided, GitHub will create a new Git tree object from only the
    //    entries defined in the tree parameter. ... all files which were a part of the
    //    parent commit's tree and were not defined in the tree parameter will be listed
    //    as deleted." — **落とすとリポジトリ全体が 1 コミットで消える。**
    const treeResponse = await request('POST', `${repoPath}/git/trees`, token, {
      base_tree: baseTreeSha,
      // sha と content を同時に入れない（docs: "Using both tree.sha and content will
      // return an error"）。blob は上で作ってあるので sha だけを指す。
      // **削除は `sha: null`。** docs: "Returns an error if you try to delete a file
      // that does not exist." なので存在確認が要るが、それは `locate` が済ませている。
      tree: [{ path, mode: FILE_MODE, type: 'blob', sha: blobSha }],
    });
    assertOk(treeResponse, 'tree creation');
    const treeSha = ((await treeResponse.json()) as { sha?: string }).sha;
    if (typeof treeSha !== 'string') throw new Error('GitHub tree response has no sha');

    // 6. commit。parents を省くと root commit になり履歴が切れる。
    const newCommitResponse = await request('POST', `${repoPath}/git/commits`, token, {
      message: args.message,
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

    return commitSha;
  };

  const publish = async (input: PublishInput): Promise<PublishResult> => {
    const { token, baseCommitSha, path, existingSha } = await locate(input.slug);
    const replaced = existingSha !== undefined;
    if (replaced && !input.overwrite) throw new SlugConflictError(input.slug);

    // **メッセージは「実際に何をしたか」で選ぶ。** overwrite が true でも記事が
    // 実在しなければ作成なので、createMessage を使う（409 を承認する間に誰かが
    // 記事を消した場合。「更新」と書かれたコミットが作成に付くと履歴が嘘をつく）。
    const commitSha = await writeCommit({
      token,
      baseCommitSha,
      path,
      change: { kind: 'write', markdown: input.markdown },
      message: replaced ? input.replaceMessage : input.createMessage,
    });

    deps.logger.info('committed post', { path, commitSha, replaced });
    return { commitSha, path, replaced };
  };

  const update = async (input: UpdateInput): Promise<PublishResult> => {
    const { token, baseCommitSha, path, existingSha } = await locate(input.slug);

    // **消えていた場合も一致しない側に倒す。** 存在しない blob の sha は一致しえない
    // ので、`existingSha === undefined` は「読んだものが今は無い」＝ stale である。
    if (existingSha !== input.sha) throw new StalePostError();

    const commitSha = await writeCommit({
      token,
      baseCommitSha,
      path,
      change: { kind: 'write', markdown: input.markdown },
      message: input.message,
    });

    deps.logger.info('updated post', { path, commitSha });
    // **replaced は常に true。** 上で存在を確かめているので、作成になる経路が無い。
    return { commitSha, path, replaced: true };
  };

  /**
   * 記事を 1 コミットで削除する。
   *
   * **`update` と同じ `locate` / `writeCommit` を通る。** 削除だけ別の手順にすると、
   * `?ref` を base sha に固定する行や `base_tree` を渡す行が写しになり、
   * いつか片方だけ緩む。**落とすと壊れ方が最も大きいのが削除経路**なので、
   * 共有する側に倒している。
   *
   * **床の判定はここではしない。** 「公開記事が 0 本になるか」はリポジトリ全体を
   * 見る必要があり、publisher は 1 記事しか知らない。router が `wouldStarveSite` で
   * 判定してから呼ぶ。
   */
  const remove = async (input: DeleteInput): Promise<PublishResult> => {
    const { token, baseCommitSha, path, existingSha } = await locate(input.slug);

    // **消えていた場合も一致しない側に倒す**（`update` と同じ理由）。
    // docs も存在しないファイルの削除はエラーになると書いているので、
    // ここで落としておかないと GitHub 側の 422 として返ることになる。
    if (existingSha !== input.sha) throw new StalePostError();

    const commitSha = await writeCommit({
      token,
      baseCommitSha,
      path,
      change: { kind: 'delete' },
      message: input.message,
    });

    deps.logger.info('deleted post', { path, commitSha });
    // **replaced は true。** 「既にあったものに手を入れた」という意味で、
    // 呼び出し側が作成と区別できる形を揃えている。
    return { commitSha, path, replaced: true };
  };

  return { publish, update, remove };
};
