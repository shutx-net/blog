import { describe, expect, it } from 'vitest';

import { ROUTES } from '@blog/api/src/router.ts';
import { API_OPERATIONS, ApiError, createApiClient } from '../../src/api/client.ts';
import type { ApiOperation } from '../../src/api/client.ts';
import { sha256Hex } from '../../src/api/sha256.ts';
import type { Bytes } from '../../src/api/sha256.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

/** テスト用の偽 transport。実装が決まっていないことに他のテストを依存させない。 */
const fakeAuth = (overrides: Partial<AuthTransport> = {}): AuthTransport => ({
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => true,
  ...overrides,
});

interface Captured {
  url: string;
  init: RequestInit;
}

/** fetch のスパイ。**注入するので、テストがネットワークに触れない。** */
const spyFetch = (response: () => Response): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { calls, impl };
};

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const headersOf = (captured: Captured): Record<string, string> => {
  const raw = captured.init.headers ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
};

/** 経路ごとの最小のボディ。bodyKind: 'json' の経路だけ中身が要る。 */
const bodyFor = (operation: ApiOperation): Record<string, unknown> | undefined =>
  operation.method === 'POST' ? { slug: 'x', nested: { 日本語: '🎉\r\n' } } : undefined;

const invoke = async (
  operation: ApiOperation,
  fetchImpl: ReturnType<typeof spyFetch>['impl'],
  auth: AuthTransport = fakeAuth(),
): Promise<unknown> =>
  createApiClient({ origin: 'https://example.invalid', auth, fetchImpl }).call(
    operation,
    bodyFor(operation),
  );

describe('API_OPERATIONS が api のルート表と一致する', () => {
  it('空でない', () => {
    expect(API_OPERATIONS.length).toBeGreaterThan(0);
  });

  it('**method + path の集合として ROUTES と完全一致する**', () => {
    // api に経路が増えたら admin 側の表も赤くなる。**admin が古い表のまま
    // 新しい経路を素の fetch で叩く**という壊れ方を構造的に塞ぐ。
    const key = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;
    expect([...API_OPERATIONS].map(key).sort()).toEqual([...ROUTES].map(key).sort());
  });

  it('ROUTES 側も空でない（比較が空集合同士で緑にならない）', () => {
    expect(ROUTES.length).toBeGreaterThan(0);
  });
});

describe('x-amz-content-sha256 を構造的に外せない', () => {
  it.each(API_OPERATIONS)(
    '$method $path に body のバイト列と一致する x-amz-content-sha256 が付く',
    async (operation) => {
      const fetchSpy = spyFetch(() => jsonResponse(200, { ok: true }));
      await invoke(operation, fetchSpy.impl);

      expect(fetchSpy.calls.length).toBe(1);
      const captured = fetchSpy.calls[0];
      expect(captured).toBeDefined();
      if (captured === undefined) return;

      const headers = headersOf(captured);
      const sent = headers['x-amz-content-sha256'];
      expect(sent, `${operation.path} に x-amz-content-sha256 が無い`).toBeDefined();
      expect(sent).toMatch(/^[0-9a-f]{64}$/);

      // **ヘッダだけ見て緑にしない。** 実際に body として渡されたバイト列を
      // ハッシュし直して突き合わせる。
      const body = captured.init.body;
      const bytes = body === undefined ? new Uint8Array(0) : (body as Bytes);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(sent).toBe(await sha256Hex(bytes));
    },
  );

  it.each(API_OPERATIONS)('$method $path のメソッドと URL が表どおりである', async (operation) => {
    const fetchSpy = spyFetch(() => jsonResponse(200, {}));
    await invoke(operation, fetchSpy.impl);
    expect(fetchSpy.calls[0]?.init.method).toBe(operation.method);
    expect(fetchSpy.calls[0]?.url).toBe(`https://example.invalid${operation.path}`);
  });

  it.each(API_OPERATIONS.filter((operation) => operation.method === 'POST'))(
    '$method $path が content-type: application/json を明示する',
    async (operation) => {
      // fetch は Uint8Array の body に Content-Type を付けない。無いと API が
      // 415 unsupported_media_type を返す。
      const fetchSpy = spyFetch(() => jsonResponse(200, {}));
      await invoke(operation, fetchSpy.impl);
      expect(headersOf(fetchSpy.calls[0]!)['content-type']).toBe('application/json');
    },
  );

  it('GET には空ペイロードの定数が付く（body の有無で分岐しない）', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(200, {}));
    await invoke({ method: 'GET', path: '/api/health' }, fetchSpy.impl);
    expect(headersOf(fetchSpy.calls[0]!)['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('GET に body を渡さない', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(200, {}));
    await invoke({ method: 'GET', path: '/api/health' }, fetchSpy.impl);
    expect(fetchSpy.calls[0]?.init.body).toBeUndefined();
  });

  it('非 ASCII と CRLF を含む body でもバイト列とハッシュが一致する', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(201, {}));
    const auth = fakeAuth();
    const client = createApiClient({ origin: 'https://example.invalid', auth, fetchImpl: fetchSpy.impl });
    const body = { title: '日本語のタイトル 🎉', body: 'a\r\nb\r\n' };
    await client.call({ method: 'POST', path: '/api/posts' }, body);

    const captured = fetchSpy.calls[0]!;
    const bytes = captured.init.body as Bytes;
    // 送られたバイト列を復号すると、JSON.stringify の結果とちょうど一致する
    // （= 文字列を 2 回エンコードしていない）。
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(body));
    expect(headersOf(captured)['x-amz-content-sha256']).toBe(await sha256Hex(bytes));
  });
});

describe('エラーの扱い', () => {
  it('非 2xx で ApiError に status / code / field が入る', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(400, { error: 'invalid_post', field: 'slug' }));
    await expect(invoke({ method: 'POST', path: '/api/posts' }, fetchSpy.impl)).rejects.toThrow(
      ApiError,
    );

    const error = await invoke({ method: 'POST', path: '/api/posts' }, fetchSpy.impl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('invalid_post');
    expect((error as ApiError).field).toBe('slug');
  });

  it('503 auth_not_configured がそのまま読める', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(503, { error: 'auth_not_configured' }));
    const error = await invoke({ method: 'POST', path: '/api/posts' }, fetchSpy.impl).catch(
      (caught: unknown) => caught,
    );
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe('auth_not_configured');
    expect((error as ApiError).field).toBeUndefined();
  });

  it('**JSON でないボディ（CloudFront の 404 HTML）でも例外にならない**', async () => {
    // 署名が失敗すると 403 が CustomErrorResponses で 404 の HTML に化ける。
    // ここで JSON.parse が投げると「何が起きたか分からない例外」になる。
    const html = '<!DOCTYPE html><html><body>404 Not Found</body></html>';
    const fetchSpy = spyFetch(
      () => new Response(html, { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    const error = await invoke({ method: 'POST', path: '/api/posts' }, fetchSpy.impl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('non_json_response');
  });

  it('空ボディの非 2xx でも non_json_response になる', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 502 }));
    const error = await invoke({ method: 'GET', path: '/api/health' }, fetchSpy.impl).catch(
      (caught: unknown) => caught,
    );
    expect((error as ApiError).code).toBe('non_json_response');
  });

  it('ApiError のメッセージに入力値を含めない', () => {
    // api 側の PostValidationError と同じ規律。400 応答やログに出る前提で書く。
    const error = new ApiError(400, 'invalid_post', 'slug');
    expect(error.message).not.toContain('undefined');
    expect(error.name).toBe('ApiError');
  });

  it('2xx では JSON を返す', async () => {
    const fetchSpy = spyFetch(() => jsonResponse(201, { commitSha: 'abc', path: 'p.md' }));
    const result = await invoke({ method: 'POST', path: '/api/posts' }, fetchSpy.impl);
    expect(result).toEqual({ commitSha: 'abc', path: 'p.md' });
  });
});
