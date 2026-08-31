import { describe, expect, it } from 'vitest';

import { AUTH_CONFIG } from '../../src/auth/config.ts';
import {
  MISSING_ID_TOKEN,
  NETWORK_ERROR,
  NON_JSON_RESPONSE,
  exchangeCode,
  refreshTokens,
  revokeRefreshToken,
} from '../../src/auth/token-endpoint.ts';

interface Captured {
  url: string;
  init: RequestInit;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const spy = (
  responder: (call: Captured) => Response | Promise<Response>,
): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  };
  return { calls, impl };
};

const okTokens = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id_token: 'ID.TOKEN.VALUE',
  access_token: 'ACCESS.TOKEN.VALUE',
  refresh_token: 'REFRESH-TOKEN-VALUE',
  expires_in: 3600,
  token_type: 'Bearer',
  ...overrides,
});

const headersOf = (call: Captured | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((call?.init.headers ?? {}) as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
};

const bodyOf = (call: Captured | undefined): URLSearchParams => {
  expect(call?.init.body, 'body が URLSearchParams であること').toBeInstanceOf(URLSearchParams);
  return new URLSearchParams(String(call?.init.body));
};

const EXCHANGE = {
  code: 'AUTHORIZATION-CODE',
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
};

describe('exchangeCode — 送信の形', () => {
  it('POST で <domain>/oauth2/token を叩く', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);

    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0]?.url).toBe(`${AUTH_CONFIG.loginDomain}/oauth2/token`);
    expect(fetchSpy.calls[0]?.init.method).toBe('POST');
  });

  it('**ヘッダが content-type ちょうど 1 個**である', async () => {
    // 実測で preflight の access-control-allow-headers は content-type。
    // 要求したヘッダを反映する挙動も観測したが、**実装依存に寄りかからない。**
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);

    const headers = headersOf(fetchSpy.calls[0]);
    expect(Object.keys(headers)).toEqual(['content-type']);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('**credentials が omit** である', async () => {
    // 実測で認可サーバは応答に Set-Cookie: XSRF-TOKEN=... を返す。要らない。
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);
    expect(fetchSpy.calls[0]?.init.credentials).toBe('omit');
  });

  it('**body のキーがちょうど 5 個**である', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);
    expect([...bodyOf(fetchSpy.calls[0]).keys()].sort()).toEqual([
      'client_id',
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ]);
  });

  it('body の値が渡したものと一致する', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);

    const body = bodyOf(fetchSpy.calls[0]);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(AUTH_CONFIG.clientId);
    expect(body.get('code')).toBe(EXCHANGE.code);
    expect(body.get('code_verifier')).toBe(EXCHANGE.verifier);
    expect(body.get('redirect_uri')).toBe(EXCHANGE.redirectUri);
  });

  it('**client_secret を含まない**（public client）', async () => {
    // 実測で secret 無しでも invalid_client にならない（= public client として受理）。
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await exchangeCode(EXCHANGE, fetchSpy.impl);
    expect(bodyOf(fetchSpy.calls[0]).get('client_secret')).toBeNull();
    expect(String(fetchSpy.calls[0]?.init.body)).not.toContain('secret');
  });
});

describe('exchangeCode — 応答の扱い（**投げない**）', () => {
  it('成功時に id_token を返す', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    const result = await exchangeCode(EXCHANGE, fetchSpy.impl);

    expect(result.ok).toBe(true);
    expect(result.ok && result.idToken).toBe('ID.TOKEN.VALUE');
    expect(result.ok && result.refreshToken).toBe('REFRESH-TOKEN-VALUE');
  });

  it('**400 invalid_grant を {ok:false, error:"invalid_grant"} で返す**（投げない）', async () => {
    // 実測でこれが実際に返る文字列。呼び出し側が「再ログインが要る」と
    // 判断できる必要がある。例外だと分岐が error.message の文字列一致になる。
    const fetchSpy = spy(() => jsonResponse(400, { error: 'invalid_grant' }));
    await expect(exchangeCode(EXCHANGE, fetchSpy.impl)).resolves.toEqual({
      ok: false,
      error: 'invalid_grant',
    });
  });

  it.each(['invalid_request', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type'])(
    '400 %s をそのままコードとして返す',
    async (error) => {
      const fetchSpy = spy(() => jsonResponse(400, { error }));
      await expect(exchangeCode(EXCHANGE, fetchSpy.impl)).resolves.toEqual({ ok: false, error });
    },
  );

  it('**JSON でない応答**（HTML など）でも投げず non_json_response', async () => {
    const fetchSpy = spy(
      () => new Response('<html>gateway timeout</html>', { status: 504 }),
    );
    await expect(exchangeCode(EXCHANGE, fetchSpy.impl)).resolves.toEqual({
      ok: false,
      error: NON_JSON_RESPONSE,
    });
  });

  it('200 だが JSON でない応答も non_json_response', async () => {
    const fetchSpy = spy(() => new Response('not json', { status: 200 }));
    await expect(exchangeCode(EXCHANGE, fetchSpy.impl)).resolves.toEqual({
      ok: false,
      error: NON_JSON_RESPONSE,
    });
  });

  it('**ネットワーク例外**でも投げず network', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(exchangeCode(EXCHANGE, impl)).resolves.toEqual({
      ok: false,
      error: NETWORK_ERROR,
    });
  });

  it('**id_token が無い応答を成功として扱わない**', async () => {
    // access_token しか返らない応答は失敗。**api は token_use:"id" を要求する。**
    const fetchSpy = spy(() => jsonResponse(200, { access_token: 'A', expires_in: 3600 }));
    await expect(exchangeCode(EXCHANGE, fetchSpy.impl)).resolves.toEqual({
      ok: false,
      error: MISSING_ID_TOKEN,
    });
  });

  it.each([
    ['id_token が空文字', { id_token: '' }],
    ['id_token が数値', { id_token: 123 }],
    ['id_token が null', { id_token: null }],
  ])('%s も失敗として扱う', async (_label, overrides) => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens(overrides)));
    const result = await exchangeCode(EXCHANGE, fetchSpy.impl);
    expect(result.ok).toBe(false);
  });

  it('refresh_token が無い成功応答でも ok（refreshToken は undefined）', async () => {
    const body = okTokens();
    delete body['refresh_token'];
    const fetchSpy = spy(() => jsonResponse(200, body));
    const result = await exchangeCode(EXCHANGE, fetchSpy.impl);
    expect(result.ok).toBe(true);
    expect(result.ok && result.refreshToken).toBeUndefined();
  });
});

describe('refreshTokens', () => {
  it('grant_type=refresh_token を **3 キーちょうど**で送る', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await refreshTokens({ refreshToken: 'R-TOKEN' }, fetchSpy.impl);

    const body = bodyOf(fetchSpy.calls[0]);
    expect([...body.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(AUTH_CONFIG.clientId);
    expect(body.get('refresh_token')).toBe('R-TOKEN');
  });

  it('**redirect_uri も code_verifier も送らない**', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await refreshTokens({ refreshToken: 'R-TOKEN' }, fetchSpy.impl);

    const body = bodyOf(fetchSpy.calls[0]);
    expect(body.get('redirect_uri')).toBeNull();
    expect(body.get('code_verifier')).toBeNull();
  });

  it('同じエンドポイントを POST で叩く', async () => {
    const fetchSpy = spy(() => jsonResponse(200, okTokens()));
    await refreshTokens({ refreshToken: 'R-TOKEN' }, fetchSpy.impl);
    expect(fetchSpy.calls[0]?.url).toBe(`${AUTH_CONFIG.loginDomain}/oauth2/token`);
    expect(fetchSpy.calls[0]?.init.method).toBe('POST');
  });

  it('invalid_grant を {ok:false, error:"invalid_grant"} で返す（**失効の唯一の合図**）', async () => {
    // refresh トークンは不透明文字列で exp を持たない。失効は
    // invalid_grant を受け取って初めて分かる。
    const fetchSpy = spy(() => jsonResponse(400, { error: 'invalid_grant' }));
    await expect(refreshTokens({ refreshToken: 'R' }, fetchSpy.impl)).resolves.toEqual({
      ok: false,
      error: 'invalid_grant',
    });
  });

  it('ネットワーク例外は network（invalid_grant と区別できる）', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(refreshTokens({ refreshToken: 'R' }, impl)).resolves.toEqual({
      ok: false,
      error: NETWORK_ERROR,
    });
  });
});

describe('revokeRefreshToken', () => {
  it('<domain>/oauth2/revoke に client_id と token を送る', async () => {
    const fetchSpy = spy(() => new Response('', { status: 200 }));
    await revokeRefreshToken({ refreshToken: 'R-TOKEN' }, fetchSpy.impl);

    expect(fetchSpy.calls[0]?.url).toBe(`${AUTH_CONFIG.loginDomain}/oauth2/revoke`);
    const body = bodyOf(fetchSpy.calls[0]);
    expect([...body.keys()].sort()).toEqual(['client_id', 'token']);
    expect(body.get('token')).toBe('R-TOKEN');
    expect(body.get('client_id')).toBe(AUTH_CONFIG.clientId);
  });

  it.each([
    ['200（存在しないトークンでも 200 が返る。RFC 7009）', 200],
    ['400', 400],
    ['500', 500],
  ])('%s でも投げない', async (_label, status) => {
    const fetchSpy = spy(() => new Response('', { status }));
    await expect(revokeRefreshToken({ refreshToken: 'R' }, fetchSpy.impl)).resolves.toBeUndefined();
  });

  it('ネットワーク例外でも投げない（**サインアウトを止めない**）', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(revokeRefreshToken({ refreshToken: 'R' }, impl)).resolves.toBeUndefined();
  });
});

describe('**トークンを 1 度もログに出さない**', () => {
  it('token-endpoint.ts が logger を受け取らず、console にも触らない', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../src/auth/token-endpoint.ts', import.meta.url)),
      'utf8',
    );
    // api/src/auth/transport.ts が Logger を受け取らない設計にした理由と同じで、
    // **トークンをログに出す経路を構造的に持たない。**
    expect(source).not.toMatch(/\bconsole\s*\./);
    expect(source).not.toMatch(/\blogger\b/i);
  });
});
