import { AUTH_FAILURE_RESPONSES } from './auth.ts';
import type { Deps, PublishResponse } from './deps.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { InvalidJsonBodyError, errorResponse, isJsonContentType, jsonResponse, parseJsonObject } from './http.ts';
import { SlugConflictError } from './github/commit.ts';
import { DeployDispatchError } from './github/dispatch.ts';
import { PostNotFoundError } from './github/reader.ts';
import { DATE_SLUG_PATTERN } from './posts/slug.ts';
import { commitMessages } from './posts/commit-message.ts';
import { renderMarkdown } from './posts/frontmatter.ts';
import { PostValidationError, validateOverwrite, validatePost } from './posts/validate.ts';
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
