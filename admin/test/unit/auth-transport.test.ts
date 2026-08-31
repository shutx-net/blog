import { describe, expect, it } from 'vitest';

import * as apiTransport from '@blog/api/src/auth/transport.ts';
import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import {
  AUTH_HEADER,
  AUTH_SCHEME,
  beginSignIn,
  completeCallback,
  createCognitoAuthTransport,
  createStubAuthTransport,
} from '../../src/auth/session.ts';
import { PENDING_LOGIN_KEY } from '../../src/auth/pending-login.ts';
import { loadSession, saveSession } from '../../src/auth/session-state.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const memoryStorage = (): WebStorageLike => {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const newStore = (): SessionStore => createSessionStore(memoryStorage());

const NOW_MS = 1_800_000_000_000;
const ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';
const EXPECTED = { clientId: AUTH_CONFIG.clientId, issuer: AUTH_CONFIG.issuer };

const idTokenExpiringIn = (seconds: number): string =>
  [
    'eyJhbGciOiJSUzI1NiJ9',
    base64UrlEncode(
      utf8Bytes(
        JSON.stringify({
          exp: NOW_MS / 1000 + seconds,
          aud: AUTH_CONFIG.clientId,
          iss: AUTH_CONFIG.issuer,
          token_use: 'id',
          'cognito:username': 'shutx',
        }),
      ),
    ),
    'sig',
  ].join('.');

const neverFetch: typeof fetch = async () => {
  throw new Error('fetch を呼んではいけない');
};

const signedInStore = (idToken = idTokenExpiringIn(3600)): SessionStore => {
  const store = newStore();
  const saved = saveSession(store, { ok: true, idToken, refreshToken: 'R-TOKEN' }, EXPECTED);
  expect(saved, 'テストの前提としてセッションが保存できていること').toBeDefined();
  return store;
};

const transportFor = (store: SessionStore, fetchImpl: typeof fetch = neverFetch) =>
  createCognitoAuthTransport({ store, now: () => NOW_MS, fetchImpl });

describe('**AuthTransport の 3 メンバを変えない**', () => {
  it('メンバがちょうど 3 つである', () => {
    // 継ぎ目の契約。増やすと api/client.ts と全 DOM テストに波及する。
    expect(Object.keys(transportFor(newStore())).sort()).toEqual([
      'authHeaders',
      'credentials',
      'isAuthenticated',
    ]);
  });

  it('スタブと同じメンバ集合である', () => {
    expect(Object.keys(transportFor(newStore())).sort()).toEqual(
      Object.keys(createStubAuthTransport()).sort(),
    );
  });

  it('**createStubAuthTransport が export として残っている**（smoke が import する）', () => {
    const stub = createStubAuthTransport();
    expect(stub.isAuthenticated()).toBe(false);
    expect(stub.credentials).toBe('same-origin');
  });

  it("credentials が 'same-origin' である（Cookie を使わないので include にしない）", () => {
    expect(transportFor(newStore()).credentials).toBe('same-origin');
  });
});

describe('認証済みのとき', () => {
  it('**ヘッダがちょうど 1 個**で、`<AUTH_HEADER>: Bearer <idToken>` である', async () => {
    const idToken = idTokenExpiringIn(3600);
    const headers = await transportFor(signedInStore(idToken)).authHeaders();

    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers[AUTH_HEADER]).toBe(`${AUTH_SCHEME} ${idToken}`);
  });

  it('**ヘッダ名を api から import した値で組み立てている**（綴りを書き写さない）', async () => {
    const headers = await transportFor(signedInStore()).authHeaders();
    expect(Object.keys(headers)[0]).toBe(apiTransport.AUTH_HEADER);
    expect(Object.keys(headers)[0]).toBe('x-blog-authorization');
  });

  it('isAuthenticated() が true', () => {
    expect(transportFor(signedInStore()).isAuthenticated()).toBe(true);
  });

  it('**access トークンではなく ID トークンを送る**', async () => {
    // api は token_use:"id" を要求する。access トークンは 401 で弾かれる。
    const idToken = idTokenExpiringIn(3600);
    const accessToken = 'ACCESS-TOKEN-MUST-NOT-BE-SENT';
    const store = newStore();
    saveSession(store, { ok: true, idToken, refreshToken: accessToken }, EXPECTED);
    // refreshToken にわざと access っぽい値を入れても、送られるのは idToken だけ。
    const headers = await transportFor(store).authHeaders();

    expect(headers[AUTH_HEADER]).toBe(`${AUTH_SCHEME} ${idToken}`);
    expect(JSON.stringify(headers)).not.toContain(accessToken);
  });
});

describe('未認証のとき（**スタブと同じ振る舞い**）', () => {
  it('authHeaders() が {} を返す', async () => {
    await expect(transportFor(newStore()).authHeaders()).resolves.toEqual({});
  });

  it('isAuthenticated() が false', () => {
    expect(transportFor(newStore()).isAuthenticated()).toBe(false);
  });

  it('リフレッシュ不能でセッションが捨てられたあとも {} を返す（古いトークンを送り続けない）', async () => {
    const store = signedInStore(idTokenExpiringIn(60));
    const failing: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    const transport = transportFor(store, failing);
    await expect(transport.authHeaders()).resolves.toEqual({});
    await expect(transport.authHeaders()).resolves.toEqual({});
    expect(transport.isAuthenticated()).toBe(false);
    expect(loadSession(store)).toBeUndefined();
  });
});

describe('**危険なヘッダを返す経路が存在しない**', () => {
  it.each([
    ['authorization', 'authorization'],
    ['x-amz-content-sha256', 'x-amz-content-sha256'],
  ])('%s を返さない', async (_label, name) => {
    const headers = await transportFor(signedInStore()).authHeaders();
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(name);
  });

  it('AUTH_HEADER が authorization ではない（CloudFront が上書きするため使えない）', () => {
    expect(AUTH_HEADER).not.toBe('authorization');
    expect(AUTH_HEADER).toBe(apiTransport.AUTH_HEADER);
  });
});

describe('beginSignIn', () => {
  it('redirect が **1 回だけ** 呼ばれ、authorize URL の形をしている', async () => {
    const store = newStore();
    const redirects: string[] = [];

    await beginSignIn({
      store,
      now: () => NOW_MS,
      random: () => new Uint8Array(32).fill(3),
      origin: ORIGIN,
      redirect: (url) => {
        redirects.push(url);
      },
    });

    expect(redirects).toHaveLength(1);
    const url = new URL(redirects[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${AUTH_CONFIG.loginDomain}/oauth2/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/admin/`);
  });

  it('**リダイレクトの時点で pending レコードが既に store に入っている**', async () => {
    const store = newStore();
    let seenAtRedirect: unknown;

    await beginSignIn({
      store,
      now: () => NOW_MS,
      random: () => new Uint8Array(32).fill(5),
      origin: ORIGIN,
      redirect: () => {
        // 偽 redirect の中から覗く。**順序ではなく観測で固定する。**
        seenAtRedirect = store.get(PENDING_LOGIN_KEY);
      },
    });

    expect(seenAtRedirect).toBeDefined();
  });

  it('state と code_challenge が保存した verifier と対応している', async () => {
    const store = newStore();
    let url = '';
    await beginSignIn({
      store,
      now: () => NOW_MS,
      random: () => new Uint8Array(32).fill(7),
      origin: ORIGIN,
      redirect: (next) => {
        url = next;
      },
    });

    const record = store.get<{ state: string; verifier: string }>(PENDING_LOGIN_KEY);
    expect(new URL(url).searchParams.get('state')).toBe(record?.state);

    const { challengeFor } = await import('../../src/auth/pkce.ts');
    expect(new URL(url).searchParams.get('code_challenge')).toBe(
      await challengeFor(record?.verifier ?? ''),
    );
  });

  it('returnTo を渡すと pending レコードに入る', async () => {
    const store = newStore();
    await beginSignIn({
      store,
      now: () => NOW_MS,
      random: () => new Uint8Array(32).fill(9),
      origin: ORIGIN,
      returnTo: '/admin/?resume=1',
      redirect: () => {},
    });
    expect(store.get<{ returnTo: string }>(PENDING_LOGIN_KEY)?.returnTo).toBe('/admin/?resume=1');
  });
});

describe('completeCallback', () => {
  it('code も error も無ければ no_callback（**起動しただけでは何も起きない**）', async () => {
    await expect(
      completeCallback({
        search: '',
        store: newStore(),
        now: () => NOW_MS,
        origin: ORIGIN,
        replaceSearch: () => {},
        fetchImpl: neverFetch,
      }),
    ).resolves.toEqual({ kind: 'no_callback' });
  });

  it('正常系でセッションが保存される', async () => {
    const store = newStore();
    let url = '';
    await beginSignIn({
      store,
      now: () => NOW_MS,
      random: () => new Uint8Array(32).fill(11),
      origin: ORIGIN,
      redirect: (next) => {
        url = next;
      },
    });
    const state = new URL(url).searchParams.get('state') ?? '';
    const idToken = idTokenExpiringIn(3600);

    const result = await completeCallback({
      search: `?code=C&state=${state}`,
      store,
      now: () => NOW_MS,
      origin: ORIGIN,
      replaceSearch: () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ id_token: idToken, refresh_token: 'R' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    expect(result).toEqual({ kind: 'signed_in', returnTo: '/admin/' });
    expect(loadSession(store)?.idToken).toBe(idToken);
  });
});

describe('**リアクティブな 401 リトライを実装しない**', () => {
  it('session.ts に再送のための分岐が無い', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../src/auth/session.ts', import.meta.url)),
      'utf8',
    );
    // AuthTransport は応答を見られない（3 メンバに onUnauthorized は無い）。
    // **リトライを持たないことが 401 ループの不成立を構造的に保証している。**
    expect(source).not.toMatch(/\bretry\b/i);
    expect(source).not.toMatch(/\bonUnauthorized\b/);
    expect(source).not.toMatch(/\b401\b/);
  });
});
