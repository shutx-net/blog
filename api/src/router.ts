import { AUTH_NOT_CONFIGURED } from './auth.ts';
import type { Deps } from './deps.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { InvalidJsonBodyError, errorResponse, isJsonContentType, jsonResponse, parseJsonObject } from './http.ts';

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

const createPost = async ({ body, deps }: RouteContext): Promise<ApiResponse> => {
  const slug = String(body['slug'] ?? '');
  const result = await deps.publisher.publish({
    slug,
    markdown: String(body['body'] ?? ''),
    message: `feat(site): 記事 ${slug} を追加`,
  });
  return jsonResponse(201, result);
};

const presignMedia = async ({ body, deps }: RouteContext): Promise<ApiResponse> => {
  const result = await deps.presigner.presign({
    contentType: String(body['contentType'] ?? ''),
    size: Number(body['size'] ?? 0),
  });
  return jsonResponse(200, result);
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
      // 401 ではなく 503。401 は「資格情報を出し直せば通る」を意味するが、
      // deny-all では通る資格情報が **存在しない**。
      return result.reason === AUTH_NOT_CONFIGURED
        ? errorResponse(503, 'auth_not_configured')
        : errorResponse(403, 'forbidden');
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

  return route.handle({ request, body, deps });
};
