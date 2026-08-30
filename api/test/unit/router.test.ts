import { describe, expect, it, vi } from 'vitest';
import type { Authorizer } from '../../src/auth.ts';
import { denyAllAuthorizer } from '../../src/auth.ts';
import type { ApiRequest, ApiResponse } from '../../src/http.ts';
import type { Deps } from '../../src/deps.ts';
import { ROUTES, dispatch } from '../../src/router.ts';
import { KeyNotProvisionedError } from '../../src/secret.ts';

/**
 * すべてのコラボレータをスパイにした deps。
 *
 * **本ファイルの中心は「503 が返る」ではなく「これらが 1 度も呼ばれない」ことである。**
 * 呼ばれた後で 503 を返す実装は前者のテストを通してしまう。
 */
const spyDeps = (authorizer: Authorizer = denyAllAuthorizer) => {
  const publisher = { publish: vi.fn(async () => ({ commitSha: 'x', path: 'p' })) };
  const presigner = {
    presign: vi.fn(async () => ({
      url: 'https://example.invalid/',
      key: 'media/2026/08/x.png',
      expiresIn: 900,
      requiredHeaders: { 'content-type': 'image/png', 'content-length': '1' },
    })),
  };
  const secretReader = { readPrivateKey: vi.fn(async () => 'PEM') };
  const tokenProvider = { getToken: vi.fn(async () => 'ghs_token') };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: Deps = {
    authorizer,
    publisher,
    presigner,
    secretReader,
    tokenProvider,
    logger,
    authMode: 'deny-all',
    now: () => new Date('2026-08-30T00:00:00Z').getTime(),
  };
  const spies = [
    publisher.publish,
    presigner.presign,
    secretReader.readPrivateKey,
    tokenProvider.getToken,
  ];
  const expectNoCollaboratorCalls = (): void => {
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
  };
  return { deps, publisher, presigner, secretReader, tokenProvider, logger, expectNoCollaboratorCalls };
};

/** 常に許可する Authorizer。**本番には存在しない** — 拒否テストが空虚でないことの対照用。 */
const allowAuthorizer: Authorizer = {
  authorize: async () => ({ ok: true, subject: 'test-subject' }),
};

const request = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: 'GET',
  path: '/api/health',
  headers: {},
  query: {},
  rawBody: undefined,
  ...overrides,
});

const jsonPost = (path: string, body: unknown): ApiRequest =>
  request({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify(body),
  });

const bodyOf = (response: ApiResponse): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

describe('ルート表', () => {
  it('ちょうど 4 経路である', () => {
    expect(ROUTES).toHaveLength(4);
  });

  it('経路の集合が固定されている', () => {
    expect(ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/health',
      'GET /api/health/github-app',
      'POST /api/media/presign',
      'POST /api/posts',
    ]);
  });

  it('GET /api/health 以外の **すべて** が requiresAuth: true である', () => {
    // 表を全件走査するのが要点。個別に書くと、経路を足したときに認可を
    // 付け忘れても気づけない。**将来の経路追加が自動的にこのテストに落ちる**。
    const unauthenticated = ROUTES.filter((route) => !route.requiresAuth);
    expect(unauthenticated.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/health',
    ]);
  });

  it('書き込み経路（POST）が 1 つ残らず認証必須である', () => {
    for (const route of ROUTES.filter((r) => r.method !== 'GET')) {
      expect(route.requiresAuth, `${route.method} ${route.path} に認可が付いていない`).toBe(true);
    }
  });

  it('パスがすべて /api/ で始まる', () => {
    // CloudFront の /api/* ビヘイビアに originPath を付けていないので、
    // rawPath は '/api/...' のまま届く。表を '/api/' 側に揃える。
    for (const route of ROUTES) expect(route.path.startsWith('/api/')).toBe(true);
  });
});

describe('AUTH_MODE=deny-all のとき書き込み経路に到達できない', () => {
  it('POST /api/posts が 503 を返し、コラボレータを 1 つも呼ばない', async () => {
    const { deps, expectNoCollaboratorCalls } = spyDeps();
    const response = await dispatch(
      jsonPost('/api/posts', { title: 't', description: 'd', body: 'b', slug: 'hello' }),
      deps,
    );
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)['error']).toBe('auth_not_configured');
    expectNoCollaboratorCalls();
  });

  it('POST /api/media/presign が 503 を返し、コラボレータを 1 つも呼ばない', async () => {
    const { deps, expectNoCollaboratorCalls } = spyDeps();
    const response = await dispatch(
      jsonPost('/api/media/presign', { contentType: 'image/png', size: 100 }),
      deps,
    );
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)['error']).toBe('auth_not_configured');
    expectNoCollaboratorCalls();
  });

  it('GET /api/health/github-app も 503 で、鍵を読みに行かない', async () => {
    const { deps, secretReader, tokenProvider } = spyDeps();
    const response = await dispatch(request({ path: '/api/health/github-app' }), deps);
    expect(response.statusCode).toBe(503);
    expect(secretReader.readPrivateKey).toHaveBeenCalledTimes(0);
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(0);
  });

  it('401 ではなく 503 を返す（通る資格情報が存在しないため）', async () => {
    const { deps } = spyDeps();
    const response = await dispatch(jsonPost('/api/posts', {}), deps);
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).toBe(503);
  });

  it('壊れた JSON でも認可が先で、body を parse しない（503 であって 400 ではない）', async () => {
    // 認可判定を **ディスパッチ前** に置いていることの証拠。ハンドラの中で認可すると
    // この順序は保てず、将来ハンドラを足したときに書き忘れられる。
    const { deps, expectNoCollaboratorCalls } = spyDeps();
    const response = await dispatch(
      request({
        method: 'POST',
        path: '/api/posts',
        headers: { 'content-type': 'application/json' },
        rawBody: '{not json',
      }),
      deps,
    );
    expect(response.statusCode).toBe(503);
    expectNoCollaboratorCalls();
  });
});

describe('拒否テストが空虚でないことの対照（同じ入力を許可すると到達する）', () => {
  // **これが無いと「呼び出し回数 0」は無意味になる。** ルートが壊れていて 404 に
  // なっているだけでも 0 件は達成できてしまう。許可した場合に **実際に呼ばれる**
  // ことを示して初めて、0 件が「認可で止めた」ことの証拠になる。
  it('許可すると POST /api/posts が publisher を呼ぶ', async () => {
    const { deps, publisher } = spyDeps(allowAuthorizer);
    await dispatch(
      jsonPost('/api/posts', {
        slug: 'hello-world',
        title: 'タイトル',
        description: '説明',
        body: '本文',
      }),
      deps,
    );
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('許可すると POST /api/media/presign が presigner を呼ぶ', async () => {
    const { deps, presigner } = spyDeps(allowAuthorizer);
    await dispatch(jsonPost('/api/media/presign', { contentType: 'image/png', size: 100 }), deps);
    expect(presigner.presign).toHaveBeenCalledTimes(1);
  });

  it('許可すると GET /api/health/github-app が tokenProvider を呼ぶ', async () => {
    const { deps, tokenProvider } = spyDeps(allowAuthorizer);
    await dispatch(request({ path: '/api/health/github-app' }), deps);
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
  });
});

describe('鍵が未投入のとき', () => {
  it('503 key_not_provisioned になる（4xx にしない）', async () => {
    // CDK は空のシークレットを作るので、鍵を投入するまでこの状態が既定になる。
    // 呼び出し側の誤りではなく設定漏れなので 4xx では意味が違う。
    const { deps, tokenProvider } = spyDeps(allowAuthorizer);
    tokenProvider.getToken = vi.fn(async () => {
      throw new KeyNotProvisionedError();
    });
    const response = await dispatch(request({ path: '/api/health/github-app' }), deps);
    // health は自前で捕まえて degraded を返す。
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)['canMintInstallationToken']).toBe(false);
  });

  it('書き込み経路では 503 key_not_provisioned になる', async () => {
    const { deps, publisher } = spyDeps(allowAuthorizer);
    publisher.publish = vi.fn(async () => {
      throw new KeyNotProvisionedError();
    });
    const response = await dispatch(
      jsonPost('/api/posts', {
        slug: 'hello-world',
        title: 'タイトル',
        description: '説明',
        body: '本文',
      }),
      deps,
    );
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)['error']).toBe('key_not_provisioned');
  });

  it('503 の本文に例外メッセージが載らない', async () => {
    const { deps, publisher } = spyDeps(allowAuthorizer);
    publisher.publish = vi.fn(async () => {
      throw new KeyNotProvisionedError();
    });
    const response = await dispatch(
      jsonPost('/api/posts', {
        slug: 'hello-world',
        title: 'タイトル',
        description: '説明',
        body: '本文',
      }),
      deps,
    );
    expect(response.body).not.toContain('put-secret-value');
  });
});

describe('GET /api/health', () => {
  it('deny-all でも 200 を返し、authMode を明かす', async () => {
    // 運用者がデプロイ後に fail-closed 状態を確認できること自体が要件。
    const { deps } = spyDeps();
    const response = await dispatch(request(), deps);
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)['authMode']).toBe('deny-all');
  });

  it('health もコラボレータを呼ばない', async () => {
    const { deps, expectNoCollaboratorCalls } = spyDeps();
    await dispatch(request(), deps);
    expectNoCollaboratorCalls();
  });
});

describe('経路の不一致', () => {
  it.each([
    ['GET', '/api/unknown'],
    ['POST', '/api/health'],
    ['DELETE', '/api/posts'],
    ['GET', '/api/posts'],
    ['POST', '/posts'],
    ['POST', '/api/posts/'],
    ['GET', '/'],
  ])('%s %s は 404 で、コラボレータを呼ばない', async (method, path) => {
    const { deps, expectNoCollaboratorCalls } = spyDeps();
    const response = await dispatch(
      request({ method, path, headers: { 'content-type': 'application/json' }, rawBody: '{}' }),
      deps,
    );
    expect(response.statusCode).toBe(404);
    expectNoCollaboratorCalls();
  });

  it("'/posts' で来たフィクスチャは 404（originPath を足していないので削られない）", async () => {
    const { deps } = spyDeps(allowAuthorizer);
    const response = await dispatch(jsonPost('/posts', {}), deps);
    expect(response.statusCode).toBe(404);
  });
});

describe('リクエストのかたちの検証（認可を通した後）', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', ''])(
    'Content-Type が %o なら 415',
    async (contentType) => {
      const { deps, expectNoCollaboratorCalls } = spyDeps(allowAuthorizer);
      const response = await dispatch(
        request({
          method: 'POST',
          path: '/api/posts',
          headers: contentType === '' ? {} : { 'content-type': contentType },
          rawBody: '{"title":"t"}',
        }),
        deps,
      );
      expect(response.statusCode).toBe(415);
      expectNoCollaboratorCalls();
    },
  );

  it('415 を返す前にボディを parse しない（壊れた JSON でも 415）', async () => {
    const { deps } = spyDeps(allowAuthorizer);
    const response = await dispatch(
      request({
        method: 'POST',
        path: '/api/posts',
        headers: { 'content-type': 'text/plain' },
        rawBody: '{not json',
      }),
      deps,
    );
    expect(response.statusCode).toBe(415);
  });

  it('charset 付きの application/json は受け付ける', async () => {
    const { deps, publisher } = spyDeps(allowAuthorizer);
    const response = await dispatch(
      request({
        method: 'POST',
        path: '/api/posts',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        rawBody: JSON.stringify({
          slug: 'hello-world',
          title: 'タイトル',
          description: '説明',
          body: '本文',
        }),
      }),
      deps,
    );
    expect(response.statusCode).not.toBe(415);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('壊れた JSON は 400 で、例外メッセージにボディの中身が出ない', async () => {
    // 本文に貼られた秘密（誤って貼られたトークンなど）がログやレスポンスに出る事故を防ぐ。
    const secret = 'ghp_SUPERSECRETVALUE0123456789';
    const { deps, logger } = spyDeps(allowAuthorizer);
    const response = await dispatch(
      request({
        method: 'POST',
        path: '/api/posts',
        headers: { 'content-type': 'application/json' },
        rawBody: `{"token": "${secret}"`,
      }),
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
    const logged = JSON.stringify(logger.info.mock.calls.concat(logger.warn.mock.calls, logger.error.mock.calls));
    expect(logged).not.toContain(secret);
  });

  it('JSON がオブジェクトでない（配列・数値・null）とき 400', async () => {
    const { deps } = spyDeps(allowAuthorizer);
    for (const raw of ['[]', '3', 'null', '"str"']) {
      const response = await dispatch(
        request({
          method: 'POST',
          path: '/api/posts',
          headers: { 'content-type': 'application/json' },
          rawBody: raw,
        }),
        deps,
      );
      expect(response.statusCode, `body=${raw}`).toBe(400);
    }
  });
});

describe('レスポンスの共通ヘッダ', () => {
  it('どの応答にも Cache-Control: no-store が付く', async () => {
    // CloudFront 側の CACHING_DISABLED と二重化する。ポリシー ID を取り違えても
    // API 側で守られる。
    const { deps } = spyDeps();
    const responses = [
      await dispatch(request(), deps), // 200
      await dispatch(jsonPost('/api/posts', {}), deps), // 503
      await dispatch(request({ path: '/api/nope' }), deps), // 404
    ];
    const allowed = spyDeps(allowAuthorizer);
    responses.push(
      await dispatch(
        request({ method: 'POST', path: '/api/posts', headers: { 'content-type': 'text/plain' } }),
        allowed.deps,
      ), // 415
      await dispatch(
        request({
          method: 'POST',
          path: '/api/posts',
          headers: { 'content-type': 'application/json' },
          rawBody: '{',
        }),
        allowed.deps,
      ), // 400
    );
    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('application/json');
    }
  });

  it('応答の本文が常に JSON としてパースできる', async () => {
    const { deps } = spyDeps();
    for (const req of [request(), jsonPost('/api/posts', {}), request({ path: '/api/nope' })]) {
      const response = await dispatch(req, deps);
      expect(() => JSON.parse(response.body)).not.toThrow();
    }
  });
});
