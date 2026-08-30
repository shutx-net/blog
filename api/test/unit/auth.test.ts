import { describe, expect, it } from 'vitest';
import { createAuthorizer, denyAllAuthorizer } from '../../src/auth.ts';
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
  it('deny-all で denyAllAuthorizer を返す', () => {
    expect(createAuthorizer('deny-all')).toBe(denyAllAuthorizer);
  });

  it.each(['off', 'none', '', 'allow-all', 'cognito'])(
    '未知のモード %o では例外を投げる（Cognito フェーズが来るまで許容値は増えない）',
    (mode) => {
      expect(() => createAuthorizer(mode as never)).toThrow(/AUTH_MODE/);
    },
  );
});
