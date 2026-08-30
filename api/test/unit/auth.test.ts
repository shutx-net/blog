import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_FAILURE_REASONS,
  AUTH_FAILURE_RESPONSES,
  AUTH_NOT_CONFIGURED,
  createAuthorizer,
  denyAllAuthorizer,
} from '../../src/auth.ts';
import type { ApiRequest } from '../../src/http.ts';

const request = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: 'POST',
  path: '/api/posts',
  headers: {},
  query: {},
  rawBody: '{}',
  ...overrides,
});

describe('deny-all の Authorizer', () => {
  it('常に拒否し、理由が auth-not-configured である', async () => {
    const result = await denyAllAuthorizer.authorize(request());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('auth-not-configured');
  });

  it.each([
    ['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'],
    ['x-blog-id-token', 'eyJhbGciOiJIUzI1NiJ9.e30.x'],
    ['cookie', 'session=admin'],
    ['x-amz-security-token', 'anything'],
    ['x-forwarded-user', 'admin'],
  ])('%s ヘッダを付けても拒否される', async (name, value) => {
    // **どんなヘッダも deny-all を開けられないこと。** エンドユーザ認証は本フェーズの
    // 範囲外なので、「それらしいヘッダがあれば通す」という抜け道を作らない。
    const result = await denyAllAuthorizer.authorize(request({ headers: { [name]: value } }));
    expect(result.ok).toBe(false);
  });

  it('subject を返さない（通っていないので主体が存在しない）', async () => {
    const result = await denyAllAuthorizer.authorize(request());
    expect(result).not.toHaveProperty('subject');
  });
});

describe('createAuthorizer', () => {
  const deps = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

  it('deny-all で denyAllAuthorizer を返す', () => {
    expect(createAuthorizer({ mode: 'deny-all' }, deps)).toBe(denyAllAuthorizer);
  });

  it('cognito で Authorizer を返す', () => {
    const authorizer = createAuthorizer(
      {
        mode: 'cognito',
        userPoolId: 'ap-northeast-1_TESTPOOL1',
        clientId: '1example23456789testclientid',
        allowedUsername: 'shutx',
      },
      deps,
    );
    expect(typeof authorizer.authorize).toBe('function');
    expect(authorizer).not.toBe(denyAllAuthorizer);
  });

  it.each(['off', 'none', '', 'allow-all', 'Cognito', 'COGNITO', ' cognito', 'cognito '])(
    '未知のモード %o では例外を投げる',
    (mode) => {
      // **大文字小文字と空白を寛容に扱わない。** Phase 3 は deny-all についてしか
      // 見ていなかったので、新しいモードについても同じ厳しさを固定する。
      expect(() => createAuthorizer({ mode } as never, deps)).toThrow(/AUTH_MODE/);
    },
  );

  it('**網羅性がコンパイル時に固定されている**（default 節が never を受け取る）', () => {
    // ランタイムでも throw して二重化してある。モードを足して分岐を書き忘れると
    // 型検査が落ちる（exhaustive(auth) に AuthConfig が渡らなくなる）。
    expect(() => createAuthorizer({ mode: 'brand-new-mode' } as never, deps)).toThrow(
      /AUTH_MODE has no authorizer implementation/,
    );
  });
});

describe('拒否理由から HTTP への写像', () => {
  it('AUTH_FAILURE_REASONS がちょうど 5 つの閉じた集合である', () => {
    // **集合等価で書く。**反例列挙だけだと、理由を足しても緑のまま滑る。
    expect([...AUTH_FAILURE_REASONS].sort()).toEqual([
      'auth-not-configured',
      'invalid-token',
      'not-authorized',
      'unauthenticated',
      'unavailable',
    ]);
  });

  it('写像表が全理由を漏れなく覆っている', () => {
    expect(Object.keys(AUTH_FAILURE_RESPONSES).sort()).toEqual([...AUTH_FAILURE_REASONS].sort());
  });

  it.each([...AUTH_FAILURE_REASONS])(
    '%s: **401 か 503 のどちらかである**',
    (reason) => {
      // 網羅ループなので、理由を足したら自動的にこのテストに落ちる。
      expect([401, 503]).toContain(AUTH_FAILURE_RESPONSES[reason].statusCode);
    },
  );

  it.each([...AUTH_FAILURE_REASONS])('%s: **403 を返さない**', (reason) => {
    // CloudFront の CustomErrorResponses は **origin の 403 も** /404.html の HTML に
    // 差し替える（実測: GET /api/nope -> 404 / text/html / x-cache: Error from cloudfront）。
    // 403 を使うと admin から「エンドポイントが無い」と区別が付かなくなる。
    expect(AUTH_FAILURE_RESPONSES[reason].statusCode).not.toBe(403);
  });

  it.each([...AUTH_FAILURE_REASONS])('%s: **404 を返さない**', (reason) => {
    expect(AUTH_FAILURE_RESPONSES[reason].statusCode).not.toBe(404);
  });

  it.each([
    ['auth-not-configured', 503, 'auth_not_configured'],
    ['unauthenticated', 401, 'unauthenticated'],
    ['invalid-token', 401, 'invalid_token'],
    ['not-authorized', 401, 'not_authorized'],
    ['unavailable', 503, 'auth_unavailable'],
  ] as const)('%s -> %i %s', (reason, statusCode, error) => {
    expect(AUTH_FAILURE_RESPONSES[reason]).toEqual({ statusCode, error });
  });

  it('**not-authorized は 403 ではなく 401 である**（意味論的な妥協。理由はコメント参照）', () => {
    // 本来 403 が素直だが、CloudFront に食われるので使えない。妥協する代わりに
    // 機械可読な error コード（not_authorized）で admin 側が区別できるようにしてある。
    // **「素直に 403 にしよう」と直さないこと。**
    expect(AUTH_FAILURE_RESPONSES['not-authorized'].statusCode).toBe(401);
    expect(AUTH_FAILURE_RESPONSES['not-authorized'].error).toBe('not_authorized');
  });

  it('error コードが 5 つとも相異なる（admin が理由を識別できる）', () => {
    const codes = [...AUTH_FAILURE_REASONS].map((r) => AUTH_FAILURE_RESPONSES[r].error);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('deny-all の拒否理由が写像表に載っている', () => {
    expect(AUTH_FAILURE_REASONS).toContain(AUTH_NOT_CONFIGURED);
  });
});
