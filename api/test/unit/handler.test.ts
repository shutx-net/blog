import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler, toApiRequest } from '../../src/event.ts';

/** Function URL の実イベントに近いフィクスチャ。 */
const event = (overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent =>
  ({
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/health',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', host: 'example.lambda-url.ap-northeast-1.on.aws' },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abcdefgh',
      domainName: 'abcdefgh.lambda-url.ap-northeast-1.on.aws',
      domainPrefix: 'abcdefgh',
      http: {
        method: 'GET',
        path: '/api/health',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'test',
      },
      requestId: 'id',
      routeKey: '$default',
      stage: '$default',
      time: '30/Aug/2026:00:00:00 +0000',
      timeEpoch: 1_787_000_000_000,
    },
    isBase64Encoded: false,
    ...overrides,
  }) as LambdaFunctionURLEvent;

describe('イベントの変換', () => {
  it('method / path / headers / body を取り出す', () => {
    const request = toApiRequest(
      event({
        rawPath: '/api/posts',
        body: '{"a":1}',
        requestContext: {
          ...event().requestContext,
          http: { ...event().requestContext.http, method: 'POST', path: '/api/posts' },
        },
      }),
    );
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/posts');
    expect(request.rawBody).toBe('{"a":1}');
  });

  it('**rawPath は /api/posts のまま届く**（originPath を設定していない）', () => {
    // CloudFront の /api/* ビヘイビアに originPath を足していないので、パスは削られない。
    // '/posts' で来たフィクスチャが 404 になることは router.test.ts が主張している。
    expect(toApiRequest(event({ rawPath: '/api/posts' })).path).toBe('/api/posts');
  });

  it('ヘッダ名を小文字化する', () => {
    const request = toApiRequest(
      event({ headers: { 'Content-Type': 'application/json', 'X-Custom': 'v' } }),
    );
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-custom']).toBe('v');
  });

  it('メソッドを大文字化する', () => {
    const base = event();
    const request = toApiRequest({
      ...base,
      requestContext: { ...base.requestContext, http: { ...base.requestContext.http, method: 'post' } },
    });
    expect(request.method).toBe('POST');
  });

  it('isBase64Encoded: true のとき body を base64 デコードする', () => {
    // Function URL はバイナリ判定で body を base64 にすることがある。
    const payload = '{"title":"日本語のタイトル"}';
    const request = toApiRequest(
      event({ body: Buffer.from(payload, 'utf8').toString('base64'), isBase64Encoded: true }),
    );
    expect(request.rawBody).toBe(payload);
  });

  it('isBase64Encoded: false のとき body をそのまま使う', () => {
    expect(toApiRequest(event({ body: '{"a":1}', isBase64Encoded: false })).rawBody).toBe('{"a":1}');
  });

  it('body が無いとき rawBody は undefined', () => {
    expect(toApiRequest(event()).rawBody).toBeUndefined();
  });

  it('クエリ文字列を取り出す', () => {
    const request = toApiRequest(
      event({ rawPath: '/api/health/github-app', rawQueryString: 'versionStage=AWSPENDING' }),
    );
    expect(request.query['versionStage']).toBe('AWSPENDING');
  });

  it('クエリが無いとき空オブジェクト', () => {
    expect(toApiRequest(event()).query).toEqual({});
  });

  it('rawPath のクエリ部分をパスに混ぜない', () => {
    expect(toApiRequest(event({ rawPath: '/api/health', rawQueryString: 'a=1' })).path).toBe(
      '/api/health',
    );
  });
});

describe('handler の応答', () => {
  const ENV = {
    AUTH_MODE: 'deny-all',
    GITHUB_APP_CLIENT_ID: 'Iv23liTEST',
    GITHUB_OWNER: 'shutx-net',
    GITHUB_REPO: 'blog',
    GITHUB_APP_SECRET_ID: 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:x-AbCdEf',
    MEDIA_BUCKET: 'blogsitestack-mediabucket-example',
    AWS_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const handler = async () => (await import('../../src/index.ts')).handler;

  it('GET /api/health が 200 を返す', async () => {
    const response = await (await handler())(event());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')['authMode']).toBe('deny-all');
    expect(response.headers?.['cache-control']).toBe('no-store');
  });

  it('POST /api/posts が deny-all で 503 になる（結線しても fail-closed のまま）', async () => {
    const base = event();
    const response = await (await handler())({
      ...base,
      rawPath: '/api/posts',
      body: JSON.stringify({ slug: 'x', title: 't', description: 'd', body: 'b' }),
      requestContext: {
        ...base.requestContext,
        http: { ...base.requestContext.http, method: 'POST', path: '/api/posts' },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body ?? '')['error']).toBe('auth_not_configured');
  });

  it('AUTH_MODE が未設定ならモジュール初期化で例外になる', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.resetModules();
    await expect(import('../../src/index.ts')).rejects.toThrow(/AUTH_MODE/);
  });

  it.each(['cognito-ish', 'allow-all', 'COGNITO', 'cognito '])(
    'AUTH_MODE=%o でもモジュール初期化で例外になる（黙って書き込みを許さない）',
    async (mode) => {
      vi.stubEnv('AUTH_MODE', mode);
      vi.resetModules();
      await expect(import('../../src/index.ts')).rejects.toThrow(/AUTH_MODE/);
    },
  );
});

describe('AUTH_MODE=cognito で結線されている', () => {
  const ENV = {
    AUTH_MODE: 'cognito',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_TESTPOOL1',
    COGNITO_CLIENT_ID: '1example23456789testclientid',
    COGNITO_ALLOWED_USERNAME: 'shutx',
    GITHUB_APP_CLIENT_ID: 'Iv23liTEST',
    GITHUB_OWNER: 'shutx-net',
    GITHUB_REPO: 'blog',
    GITHUB_APP_SECRET_ID: 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:x-AbCdEf',
    MEDIA_BUCKET: 'blogsitestack-mediabucket-example',
    AWS_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const handler = async () => (await import('../../src/index.ts')).handler;

  it('**GET /api/health が 200 で authMode が cognito**（無認証で確認できることが要件）', async () => {
    // 運用者がデプロイ後に「いまどちらのモードで動いているか」を確認できること自体が要件。
    // 4.13 の受け入れ確認の一番外側の輪になる。
    const response = await (await handler())(event());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')['authMode']).toBe('cognito');
  });

  it.each([
    ['/api/posts', 'POST'],
    ['/api/media/presign', 'POST'],
  ])('%s にトークン無しで 401 unauthenticated', async (path, method) => {
    const base = event();
    const response = await (await handler())({
      ...base,
      rawPath: path,
      body: JSON.stringify({}),
      requestContext: {
        ...base.requestContext,
        http: { ...base.requestContext.http, method, path },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body ?? '')['error']).toBe('unauthenticated');
  });

  it('**401 であって 403 でも 404 でもない**（CloudFront に食われないため）', async () => {
    const base = event();
    const response = await (await handler())({
      ...base,
      rawPath: '/api/posts',
      body: '{}',
      requestContext: {
        ...base.requestContext,
        http: { ...base.requestContext.http, method: 'POST', path: '/api/posts' },
      },
    });
    expect(response.statusCode).not.toBe(403);
    expect(response.statusCode).not.toBe(404);
    expect(response.headers?.['cache-control']).toBe('no-store');
  });

  it('でたらめなトークンでも 401 で、**JWKS を取りに行っても 401 か 503 に収まる**', async () => {
    const base = event();
    const response = await (await handler())({
      ...base,
      rawPath: '/api/posts',
      body: '{}',
      headers: { ...base.headers, 'x-blog-authorization': 'Bearer not.a.jwt' },
      requestContext: {
        ...base.requestContext,
        http: { ...base.requestContext.http, method: 'POST', path: '/api/posts' },
      },
    });
    expect([401, 503]).toContain(response.statusCode);
  });

  it.each(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_ALLOWED_USERNAME'])(
    '%s が空ならモジュール初期化で例外になる',
    async (name) => {
      vi.stubEnv(name, '');
      vi.resetModules();
      await expect(import('../../src/index.ts')).rejects.toThrow(new RegExp(name));
    },
  );
});

describe('想定外の例外', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('500 になり、本文にスタックも例外メッセージも載らない', async () => {
    const secret = 'INTERNAL_DETAIL_THAT_MUST_NOT_LEAK';
    const response = await createHandler(() => {
      throw new Error(secret);
    }, logger())(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('at ');
    expect(JSON.parse(response.body ?? '')['error']).toBe('internal_error');
    expect(response.headers?.['cache-control']).toBe('no-store');
  });

  it('ログにも例外メッセージを出さない（名前だけ）', async () => {
    const secret = 'INTERNAL_DETAIL_THAT_MUST_NOT_LEAK';
    const log = logger();
    await createHandler(() => {
      throw new Error(secret);
    }, log)(event());
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain(secret);
  });

  it('非同期の拒否も 500 になる', async () => {
    const response = await createHandler(
      async () => Promise.reject(new Error('async boom')),
      logger(),
    )(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('async boom');
  });
});
