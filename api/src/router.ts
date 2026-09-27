import { AUTH_FAILURE_RESPONSES } from './auth.ts';
import type { Deps, PublishResponse } from './deps.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { InvalidJsonBodyError, errorResponse, isJsonContentType, jsonResponse, parseJsonObject } from './http.ts';
import { ConcurrentUpdateError, SlugConflictError, StalePostError } from './github/commit.ts';
import { DeployDispatchError } from './github/dispatch.ts';
import { PostNotFoundError } from './github/reader.ts';
import { DATE_SLUG_PATTERN } from './posts/slug.ts';
import { commitMessages } from './posts/commit-message.ts';
import { renderMarkdown } from './posts/frontmatter.ts';
import { wouldStarveSite } from './posts/publishable-floor.ts';
import { PostValidationError, validateOverwrite, validatePost, validateUpdate } from './posts/validate.ts';
import { MediaValidationError } from './media/presign.ts';
import { KeyNotProvisionedError } from './secret.ts';

export interface RouteContext {
  request: ApiRequest;
  /** bodyKind: 'json' の経路だけ中身が入る。'none' の経路では空オブジェクト。 */
  body: Record<string, unknown>;
  deps: Deps;
}

export interface Route {
  method: string;
  path: string;
  /**
   * **health 以外はすべて true。** 判定はルータのディスパッチ前で行うので、
   * ハンドラ側が認可を書き忘れることが構造的に起きない。
   */
  requiresAuth: boolean;
  /** 'json' ならルータが Content-Type 検証（415）と JSON パース（400）を行う。 */
  bodyKind: 'json' | 'none';
  handle(context: RouteContext): Promise<ApiResponse>;
}

const health = async ({ deps }: RouteContext): Promise<ApiResponse> =>
  // 運用者がデプロイ後に fail-closed 状態を確認できること自体が要件。
  jsonResponse(200, { status: 'ok', authMode: deps.authMode });

/**
 * 鍵ローテーションの検証用（DEVELOPERS.md の手順 2「動作を確認」の実体）。
 *
 * **秘密鍵も installation token も返さない。** 「その鍵でトークンが取れたか」の
 * 真偽だけを返す。?versionStage=AWSPENDING で投入直後の鍵を検証できる。
 */
const githubAppHealth = async ({ request, deps }: RouteContext): Promise<ApiResponse> => {
  const versionStage = request.query['versionStage'];
  try {
    await deps.tokenProvider.getToken(versionStage === undefined ? undefined : { versionStage });
    return jsonResponse(200, { status: 'ok', canMintInstallationToken: true, versionStage: versionStage ?? 'AWSCURRENT' });
  } catch (error) {
    // 例外の中身は返さない。鍵の状態を運用者に伝えるのは真偽値だけで足りる。
    deps.logger.warn('github-app health check failed', { name: (error as Error).name });
    return jsonResponse(200, { status: 'degraded', canMintInstallationToken: false, versionStage: versionStage ?? 'AWSCURRENT' });
  }
};

/**
 * dispatch の失敗を、秘密を含まない構造化フィールドに落とす。
 *
 * **status の有無が transport と status を分ける印。** name だけを残していた頃は
 * 両方の経路が `Error` を投げていたため、ログから原因を断定できなかった
 * （2026-09-06 の投稿で実際に詰まった）。
 *
 * DeployDispatcher は interface なので、別の実装が素の Error を投げうる。
 * その場合も落とさず `reason: 'unknown'` として残す。
 */
const describeDispatchFailure = (error: unknown): Record<string, unknown> => {
  const name = error instanceof Error ? error.name : typeof error;
  if (!(error instanceof DeployDispatchError)) return { name, reason: 'unknown' };

  const record: Record<string, unknown> = { name, reason: error.reason };
  if (error.status !== undefined) record['status'] = error.status;
  if (error.transportErrorName !== undefined) {
    record['transportErrorName'] = error.transportErrorName;
  }
  return record;
};

const createPost = async ({ body, deps }: RouteContext): Promise<ApiResponse> => {
  let post;
  let overwrite;
  try {
    post = validatePost(body, deps.now());
    overwrite = validateOverwrite(body);
  } catch (error) {
    if (error instanceof PostValidationError) {
      // どのフィールドが悪いかだけを返す。**入力値そのものは返さない。**
      return jsonResponse(400, { error: 'invalid_post', field: error.field });
    }
    throw error;
  }

  let result;
  try {
    result = await deps.publisher.publish({
      slug: post.slug,
      markdown: renderMarkdown(post),
      // AGENTS.md の Conventional Commits はリポジトリ規約なので、API 経由の
      // コミットにも同じように適用する。
      // **どちらが使われるかは publisher が決める**（存在確認を持っているのが向こう）。
      //
      // **slug ではなく title で組む。** slug は pubDate から導出した日付パスなので、
      // `記事 2026/09/08/054001 を追加` では履歴から中身が読めない。
      ...commitMessages(post.title),
      overwrite,
    });
  } catch (error) {
    if (error instanceof SlugConflictError) {
      // **409。403 でも 404 でもない** — CloudFront の CustomErrorResponses が
      // origin の 403/404 を HTML に差し替えるので、admin から区別が付かなくなる
      // （auth.ts が同じ理由で 403 を禁じている）。
      //
      // **dispatch はしない。** リポジトリは 1 バイトも変わっていないので、
      // ここでデプロイを起動しても何も反映されないうえ、失敗と区別が付かなくなる。
      deps.logger.warn('post slug already exists', { slug: error.slug });
      // **slug を本文に載せない**（入力をエコーしない規律）。呼び出し側は自分が
      // 送った slug を知っている。
      return jsonResponse(409, { error: 'slug_conflict', field: 'slug' });
    }
    throw error;
  }

  // **ここから先は記事が既にコミットされている。** 何が起きても 201 を返し、
  // publish をやり直さない。やり直すと同じ記事が 2 コミットされる。
  if (deps.deployDispatcher === undefined) return jsonResponse(201, result);

  try {
    await deps.deployDispatcher.dispatch();
  } catch (error) {
    // **メッセージは載せない。** dispatch 側が本文を読まない規律を、ログでも崩さない。
    // 載せてよいのは、こちらが決めた列挙値と HTTP ステータスだけ。
    deps.logger.error('deploy dispatch failed after publish', describeDispatchFailure(error));
    return jsonResponse(201, { ...result, deployTriggered: false } satisfies PublishResponse);
  }
  return jsonResponse(201, { ...result, deployTriggered: true } satisfies PublishResponse);
};

/**
 * 既存記事の差し替え。
 *
 * **順序がこの関数の中身である。**
 *
 *   1. `targetSlug` の形（400）      — reader を呼ぶ前に弾く
 *   2. 既存の読み取り（404）          — 検証に既存の pubDate が要る
 *   3. ボディの検証（400）            — pubDate の不変と sha の必須
 *   4. 公開可能数の床（409）          — **書き込みの前**
 *   5. 差し替え（409）                — sha 不一致 / ref の競合
 *   6. dispatch
 *
 * **4 を 5 の前に置くのが要点。** 逆順だと「コミットしてからデプロイが落ちる」
 * ことになり、利用者から見て最も分かりにくい壊れ方になる。
 */
const updatePost = async ({ body, deps }: RouteContext): Promise<ApiResponse> => {
  // **reader を呼ぶ前に形を確かめる。** 呼んでから弾くと、不正な入力でも
  // installation token の交換と GitHub への往復が起きる（getPost と同じ立場）。
  const targetSlug = body['targetSlug'];
  if (typeof targetSlug !== 'string' || !DATE_SLUG_PATTERN.test(targetSlug)) {
    return jsonResponse(400, { error: 'invalid_post', field: 'targetSlug' });
  }

  let existing;
  try {
    existing = await deps.reader.read(targetSlug);
  } catch (error) {
    if (error instanceof PostNotFoundError) {
      deps.logger.warn('post to update not found', { slug: error.slug });
      return jsonResponse(404, { error: 'post_not_found' });
    }
    throw error;
  }

  let update;
  try {
    update = validateUpdate(body, existing, deps.now());
  } catch (error) {
    if (error instanceof PostValidationError) {
      return jsonResponse(400, { error: 'invalid_post', field: error.field });
    }
    throw error;
  }

  // **公開記事が 0 本になる更新を拒む。** 下書きに戻す操作でも起きる。
  //
  // `deploy.yml` のスラッグ照合ガードが数えているのは**公開分**なので、
  // 「総数」で判定すると許可したのにデプロイが落ちる。
  // `UnknownSlugError` は**握り潰さない** — read が成功した直後に list に居ない
  // のはリポジトリの不整合であり、推測で許可に倒すと「拒否されないのに
  // デプロイが落ちる」状態になる。そのまま 500 として上げる。
  if (wouldStarveSite(await deps.reader.list(), { kind: 'update', slug: targetSlug, draft: update.post.draft })) {
    deps.logger.warn('update would leave the site with no published posts', { slug: targetSlug });
    return jsonResponse(409, { error: 'would_starve_site', field: 'draft' });
  }

  let result;
  try {
    result = await deps.publisher.update({
      // **読んだときのパスをそのまま使う。** 導出し直した slug を使うと、
      // front matter がファイル名と食い違う記事で別のパスに書いてしまう。
      slug: targetSlug,
      markdown: renderMarkdown(update.post),
      // 更新は常に差し替えなので replaceMessage だけを渡す。
      message: commitMessages(update.post.title).replaceMessage,
      sha: update.sha,
    });
  } catch (error) {
    // **どちらも「読み直せ」が唯一の対応。** それでもコードを分けているのは、
    // ログから「中身が変わった」と「main が進んだ」を区別できるようにするため。
    if (error instanceof StalePostError) {
      deps.logger.warn('post changed since it was read', { slug: targetSlug });
      return jsonResponse(409, { error: 'stale_post', field: 'sha' });
    }
    if (error instanceof ConcurrentUpdateError) {
      deps.logger.warn('ref moved while updating', { slug: targetSlug });
      return jsonResponse(409, { error: 'concurrent_update', field: 'sha' });
    }
    throw error;
  }

  // **ここから先は記事が既にコミットされている。** createPost と同じ規律で、
  // 何が起きても成功を返し、update をやり直さない。
  if (deps.deployDispatcher === undefined) return jsonResponse(200, result);

  try {
    await deps.deployDispatcher.dispatch();
  } catch (error) {
    deps.logger.error('deploy dispatch failed after update', describeDispatchFailure(error));
    return jsonResponse(200, { ...result, deployTriggered: false } satisfies PublishResponse);
  }
  return jsonResponse(200, { ...result, deployTriggered: true } satisfies PublishResponse);
};

/**
 * 記事の一覧。**下書きも返す。**
 *
 * 管理画面は下書きを編集したいので、公開側の `isPublished` フィルタとは立場が違う。
 * だから**この経路は認証が外せない** — blog-content は private で、ここが素通しに
 * なると下書きが誰にでも読める。`ROUTES` の全件走査がそれを主張している。
 *
 * **本文は返さない。** 一覧は記事数ぶんの blob 取得になるので、本文まで載せると
 * 転送量が記事の長さの合計に比例する。編集で本文が要るのは 1 本だけ。
 */
const listPosts = async ({ deps }: RouteContext): Promise<ApiResponse> => {
  const posts = await deps.reader.list();
  return jsonResponse(200, { posts, count: posts.length });
};

/**
 * 記事 1 本の取得。**スラッグはクエリで受ける。**
 *
 * パスパラメータにしない理由: スラッグは `2026/09/27/142621` でスラッシュを含むので、
 * `/api/posts/:slug` にすると `(method, path)` の完全一致で引いているルート表の
 * 照合機構を作り直すことになる。クエリは `githubAppHealth` が既に使っている経路で、
 * `event.ts` が `rawQueryString` を展開済み。
 */
const getPost = async ({ request, deps }: RouteContext): Promise<ApiResponse> => {
  const slug = request.query['slug'];
  // **reader を呼ぶ前に形を確かめる。** 呼んでから弾くと、不正な入力でも
  // installation token の交換と GitHub への往復が起きる。
  if (slug === undefined || !DATE_SLUG_PATTERN.test(slug)) {
    // **入力値はエコーしない**（どのフィールドが悪いかだけ返す規律）。
    return jsonResponse(400, { error: 'invalid_post', field: 'slug' });
  }

  try {
    return jsonResponse(200, await deps.reader.read(slug));
  } catch (error) {
    if (error instanceof PostNotFoundError) {
      // **404 を使ってよい。** auth.ts が 403/404 を禁じているのは *認可失敗* の
      // 写像であって、リソースの不在は別。ただし CloudFront の CustomErrorResponses が
      // origin の 404 を HTML に差し替えるので、admin にはこの JSON が届かず
      // NON_JSON_RESPONSE として見える（client.ts が既にその扱いを持っている）。
      deps.logger.warn('post not found', { slug: error.slug });
      return jsonResponse(404, { error: 'post_not_found' });
    }
    throw error;
  }
};

/**
 * 記事の削除。**唯一の破壊的操作。**
 *
 * slug と sha を**クエリで受ける**。ボディ付き DELETE は経路上の中間装置に
 * 落とされうるのに対し、ボディ無しは `client.ts` が `EMPTY_PAYLOAD_SHA256` を
 * 送る形で GET が本番で通っている（実証済みの経路に乗せる）。
 *
 * 順序が要件: **形（400）→ 読み取り（404）→ sha 一致（409）→ 床（409）→ 削除**。
 * 書き込みを 1 本も出す前に拒否が全部終わっていることが、
 * 「拒否したのに消えている」を構造的に起こさないための条件である。
 */
const deletePost = async ({ request, deps }: RouteContext): Promise<ApiResponse> => {
  const slug = request.query['slug'];
  // **GitHub を呼ぶ前に形を確かめる。** 呼んでから弾くと、不正な入力でも
  // installation token の交換が起きる（getPost / updatePost と同じ立場）。
  if (slug === undefined || !DATE_SLUG_PATTERN.test(slug)) {
    return jsonResponse(400, { error: 'invalid_post', field: 'slug' });
  }
  const sha = request.query['sha'];
  // **省略を許さない。** 許すと「読んだときと同じものを消している」確認を
  // 外して呼べる経路ができる（UpdateInput.sha と同じ規律）。
  if (sha === undefined || sha.trim().length === 0) {
    return jsonResponse(400, { error: 'invalid_post', field: 'sha' });
  }

  let existing;
  try {
    existing = await deps.reader.read(slug);
  } catch (error) {
    if (error instanceof PostNotFoundError) {
      deps.logger.warn('post to delete not found', { slug: error.slug });
      return jsonResponse(404, { error: 'post_not_found' });
    }
    throw error;
  }

  // **床の判定を書き込みの前に置く。** `deploy.yml` のスラッグ照合ガードが数えて
  // いるのは**公開分**なので、「総数」で判定すると許可したのにデプロイが落ちる
  // （公開 1 本 + 下書き 3 本でその公開を消す場合が実例）。
  // `UnknownSlugError` は**握り潰さない** — read が成功した直後に list に居ないのは
  // リポジトリの不整合であり、許可に倒すと「拒否されないのにデプロイが落ちる」。
  if (wouldStarveSite(await deps.reader.list(), { kind: 'delete', slug })) {
    deps.logger.warn('delete would leave the site with no published posts', { slug });
    return jsonResponse(409, { error: 'would_starve_site', field: 'slug' });
  }

  let result;
  try {
    result = await deps.publisher.remove({
      slug,
      // **title は削除の前にしか読めない。** 履歴から何が消えたか読めるように、
      // ここで組んだメッセージを渡す。
      message: commitMessages(existing.title).deleteMessage,
      sha,
    });
  } catch (error) {
    if (error instanceof StalePostError) {
      deps.logger.warn('post changed since it was read', { slug });
      return jsonResponse(409, { error: 'stale_post', field: 'sha' });
    }
    if (error instanceof ConcurrentUpdateError) {
      deps.logger.warn('ref moved while deleting', { slug });
      return jsonResponse(409, { error: 'concurrent_update', field: 'sha' });
    }
    throw error;
  }

  // **ここから先は記事が既に消えている。** createPost / updatePost と同じ規律で、
  // 何が起きても成功を返し、削除をやり直さない。
  if (deps.deployDispatcher === undefined) return jsonResponse(200, result);

  try {
    await deps.deployDispatcher.dispatch();
  } catch (error) {
    deps.logger.error('deploy dispatch failed after delete', describeDispatchFailure(error));
    return jsonResponse(200, { ...result, deployTriggered: false } satisfies PublishResponse);
  }
  return jsonResponse(200, { ...result, deployTriggered: true } satisfies PublishResponse);
};

const presignMedia = async ({ body, deps }: RouteContext): Promise<ApiResponse> => {
  const filename = body['filename'];
  try {
    const result = await deps.presigner.presign({
      contentType: typeof body['contentType'] === 'string' ? body['contentType'] : '',
      // 数値以外は NaN にして presigner の検証に落とす（'10' を 10 と読まない）。
      size: typeof body['size'] === 'number' ? body['size'] : Number.NaN,
      ...(typeof filename === 'string' ? { filename } : {}),
    });
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof MediaValidationError) {
      return jsonResponse(400, { error: 'invalid_media', field: error.field });
    }
    throw error;
  }
};

/**
 * ルート表。
 *
 * **経路を足すときは requiresAuth を必ず true にすること。** test/unit/router.test.ts が
 * 表を全件走査して「GET /api/health 以外はすべて認証必須」を主張しているので、
 * 忘れると赤くなる。
 */
export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/api/health', requiresAuth: false, bodyKind: 'none', handle: health },
  {
    method: 'GET',
    path: '/api/health/github-app',
    requiresAuth: true,
    bodyKind: 'none',
    handle: githubAppHealth,
  },
  { method: 'GET', path: '/api/posts', requiresAuth: true, bodyKind: 'none', handle: listPosts },
  {
    method: 'GET',
    path: '/api/posts/detail',
    requiresAuth: true,
    bodyKind: 'none',
    handle: getPost,
  },
  { method: 'POST', path: '/api/posts', requiresAuth: true, bodyKind: 'json', handle: createPost },
  { method: 'PUT', path: '/api/posts', requiresAuth: true, bodyKind: 'json', handle: updatePost },
  {
    method: 'DELETE',
    path: '/api/posts',
    requiresAuth: true,
    // **ボディを取らない。** slug と sha はクエリで受ける（deletePost 参照）。
    bodyKind: 'none',
    handle: deletePost,
  },
  {
    method: 'POST',
    path: '/api/media/presign',
    requiresAuth: true,
    bodyKind: 'json',
    handle: presignMedia,
  },
];

/**
 * 経路解決 -> **認可** -> Content-Type -> ボディの順に閉じる。
 *
 * **認可がボディの検証より前にあることが本フェーズの核心。** 逆順にすると、
 * 認可されないリクエストでもボディを parse することになり、
 * 「拒否時にコラボレータを一切呼ばない」という不変条件が保てなくなる。
 */
export const dispatch = async (request: ApiRequest, deps: Deps): Promise<ApiResponse> => {
  const route = ROUTES.find((r) => r.method === request.method && r.path === request.path);
  if (route === undefined) return errorResponse(404, 'not_found');

  if (route.requiresAuth) {
    const result = await deps.authorizer.authorize(request);
    if (!result.ok) {
      // **写像表は auth.ts が持つ。ここで分岐を書かない。**
      // 表は 401 と 503 しか持てない型になっており、**403 と 404 は書けない**。
      // CloudFront の CustomErrorResponses が origin の 403/404 も HTML に差し替える
      // ため、403 を使うと admin から「経路が無い」と区別が付かなくなる（auth.ts 参照）。
      const failure = AUTH_FAILURE_RESPONSES[result.reason];
      return errorResponse(failure.statusCode, failure.error);
    }
  }

  let body: Record<string, unknown> = {};
  if (route.bodyKind === 'json') {
    if (!isJsonContentType(request.headers)) return errorResponse(415, 'unsupported_media_type');
    try {
      body = parseJsonObject(request.rawBody);
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) return errorResponse(400, 'invalid_json');
      throw error;
    }
  }

  try {
    return await route.handle({ request, body, deps });
  } catch (error) {
    if (error instanceof KeyNotProvisionedError) {
      // 鍵がまだ Secrets Manager に入っていない。呼び出し側の誤りではなく設定漏れなので
      // 4xx にしない。**本フェーズの既定状態がこれ**（CDK は空のシークレットを作る）。
      deps.logger.error('GitHub App private key is not provisioned');
      return errorResponse(503, 'key_not_provisioned');
    }
    throw error;
  }
};
