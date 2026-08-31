import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { PENDING_LOGIN_KEY, beginPendingLogin } from '../../src/auth/pending-login.ts';
import { SESSION_KEY, loadSession, saveSession } from '../../src/auth/session-state.ts';
import { createCognitoAuthTransport, signOut } from '../../src/auth/session.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const NOW_MS = 1_800_000_000_000;
const ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';
const EXPECTED = { clientId: AUTH_CONFIG.clientId, issuer: AUTH_CONFIG.issuer };

/** 実キーを覗ける偽ストレージ。 */
const backing = (): WebStorageLike & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const idToken = (): string =>
  [
    'eyJhbGciOiJSUzI1NiJ9',
    base64UrlEncode(
      utf8Bytes(
        JSON.stringify({
          exp: NOW_MS / 1000 + 3600,
          aud: AUTH_CONFIG.clientId,
          iss: AUTH_CONFIG.issuer,
          token_use: 'id',
          'cognito:username': 'shutx',
        }),
      ),
    ),
    'sig',
  ].join('.');

interface Scene {
  store: SessionStore;
  entries: Map<string, string>;
  revokeCalls: Array<{ url: string; body: URLSearchParams }>;
  redirects: string[];
  /** `redirect` が呼ばれた瞬間の store の中身。**順序を観測で固定するための窓。** */
  seenAtRedirect: { session: unknown; pending: unknown; draft: unknown } | undefined;
  run(): Promise<void>;
}

const scene = (options: { refreshToken?: string; revoke?: () => Response } = {}): Scene => {
  const storage = backing();
  const store = createSessionStore(storage);

  const refreshToken = 'refreshToken' in options ? options.refreshToken : 'R-TOKEN';
  saveSession(
    store,
    { ok: true, idToken: idToken(), refreshToken },
    EXPECTED,
  );
  beginPendingLogin({ store, random: () => new Uint8Array(32).fill(4), now: () => NOW_MS });
  // **下書きと無関係のキー。** サインアウトで消えてはいけない。
  store.set('draft', { title: '書きかけ', body: '本文' });
  store.set('unrelated', { anything: true });

  const result: Scene = {
    store,
    entries: storage.entries,
    revokeCalls: [],
    redirects: [],
    seenAtRedirect: undefined,
    run: () =>
      signOut({
        store,
        origin: ORIGIN,
        redirect: (url) => {
          result.redirects.push(url);
          result.seenAtRedirect = {
            session: store.get(SESSION_KEY),
            pending: store.get(PENDING_LOGIN_KEY),
            draft: store.get('draft'),
          };
        },
        fetchImpl: async (input, init) => {
          result.revokeCalls.push({
            url: String(input),
            body: new URLSearchParams(String(init?.body ?? '')),
          });
          return (options.revoke ?? (() => new Response('', { status: 200 })))();
        },
      }),
  };
  return result;
};

describe('revoke の呼び出し', () => {
  it('<domain>/oauth2/revoke を 1 回だけ叩く', async () => {
    const s = scene();
    await s.run();

    expect(s.revokeCalls).toHaveLength(1);
    expect(s.revokeCalls[0]?.url).toBe(`${AUTH_CONFIG.loginDomain}/oauth2/revoke`);
  });

  it('**ID トークンではなく refresh トークンを失効させる**', async () => {
    // 長いほう（24 時間）を止めないと生き残る。ID トークンは 60 分で自然に切れる。
    const s = scene();
    await s.run();

    const body = s.revokeCalls[0]?.body;
    expect([...(body?.keys() ?? [])].sort()).toEqual(['client_id', 'token']);
    expect(body?.get('token')).toBe('R-TOKEN');
    expect(body?.get('client_id')).toBe(AUTH_CONFIG.clientId);
    expect(body?.get('token')).not.toBe(idToken());
  });

  it('**refresh トークンが無ければ revoke を呼ばない**（投げもしない）', async () => {
    const s = scene({ refreshToken: undefined });
    await expect(s.run()).resolves.toBeUndefined();

    expect(s.revokeCalls).toHaveLength(0);
    expect(s.redirects).toHaveLength(1);
    expect(loadSession(s.store)).toBeUndefined();
  });
});

describe('**順序: 消去 -> リダイレクト**', () => {
  it('redirect が呼ばれた時点でセッションは既に消えている', async () => {
    // **リダイレクトしてから消す実装は、遷移が起きた瞬間に消去コードが走らないので
    // 必ず取りこぼす。** 順序ではなく観測で固定する。
    const s = scene();
    await s.run();

    expect(s.redirects).toHaveLength(1);
    expect(s.seenAtRedirect?.session).toBeUndefined();
  });

  it('redirect の時点で pending login も消えている', async () => {
    const s = scene();
    await s.run();
    expect(s.seenAtRedirect?.pending).toBeUndefined();
  });

  it('**redirect の時点でも下書きは残っている**', async () => {
    // **サインアウトは「書きかけを捨てる」操作ではない。**
    const s = scene();
    await s.run();
    expect(s.seenAtRedirect?.draft).toEqual({ title: '書きかけ', body: '本文' });
  });

  it('サインアウト後に残るキーが下書きと無関係のものだけである', async () => {
    const s = scene();
    await s.run();
    expect([...s.entries.keys()].sort()).toEqual(['blog.admin.draft', 'blog.admin.unrelated']);
  });
});

describe('**revoke が失敗してもサインアウトを続行する**', () => {
  it.each([
    ['500', () => new Response('', { status: 500 })],
    ['400', () => new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })],
  ])('revoke が %s でも store は消え、redirect は呼ばれる', async (_label, revoke) => {
    const s = scene({ revoke });
    await expect(s.run()).resolves.toBeUndefined();

    expect(loadSession(s.store)).toBeUndefined();
    expect(s.redirects).toHaveLength(1);
  });

  it('revoke がネットワークエラーでも続行する', async () => {
    // **ローカルのログアウトが認可サーバの都合で止まってはいけない。**
    const storage = backing();
    const store = createSessionStore(storage);
    saveSession(store, { ok: true, idToken: idToken(), refreshToken: 'R' }, EXPECTED);
    const redirects: string[] = [];

    await expect(
      signOut({
        store,
        origin: ORIGIN,
        redirect: (url) => {
          redirects.push(url);
        },
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).resolves.toBeUndefined();

    expect(loadSession(store)).toBeUndefined();
    expect(redirects).toHaveLength(1);
  });
});

describe('リダイレクト先', () => {
  it('<domain>/logout?client_id=...&logout_uri=... の形である', async () => {
    const s = scene();
    await s.run();

    const url = new URL(s.redirects[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${AUTH_CONFIG.loginDomain}/logout`);
    expect(url.searchParams.get('client_id')).toBe(AUTH_CONFIG.clientId);
    expect(url.searchParams.get('logout_uri')).toBe(`${ORIGIN}/admin/`);
  });

  it('logout_uri が redirect_uri と同じ導出（CallbackURLs と LogoutURLs は同値）', async () => {
    const { resolveRedirectUri } = await import('../../src/auth/config.ts');
    const s = scene();
    await s.run();
    expect(new URL(s.redirects[0] as string).searchParams.get('logout_uri')).toBe(
      resolveRedirectUri(ORIGIN),
    );
  });

  it('別のオリジンなら logout_uri も追随する（定数に焼いていない）', async () => {
    const storage = backing();
    const store = createSessionStore(storage);
    const redirects: string[] = [];
    await signOut({
      store,
      origin: 'https://blog.example.com',
      redirect: (url) => {
        redirects.push(url);
      },
      fetchImpl: async () => new Response('', { status: 200 }),
    });
    expect(new URL(redirects[0] as string).searchParams.get('logout_uri')).toBe(
      'https://blog.example.com/admin/',
    );
  });
});

describe('サインアウト後の transport', () => {
  it('isAuthenticated() が false、authHeaders() が {}', async () => {
    const s = scene();
    const transport = createCognitoAuthTransport({
      store: s.store,
      now: () => NOW_MS,
      fetchImpl: async () => {
        throw new Error('呼ばれないはず');
      },
    });
    expect(transport.isAuthenticated()).toBe(true);

    await s.run();

    expect(transport.isAuthenticated()).toBe(false);
    await expect(transport.authHeaders()).resolves.toEqual({});
  });
});
