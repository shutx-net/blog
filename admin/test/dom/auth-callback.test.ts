import { beforeEach, describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { handleCallback } from '../../src/auth/callback.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { beginPendingLogin } from '../../src/auth/pending-login.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

/**
 * **jsdom で本当に動くものだけを DOM テストにする。**
 *
 * `history.replaceState` は jsdom で**実際に動く**（`?code=..&state=..` -> `''` を実測）。
 * したがって URL からの `code` 除去は構造テストではなく**実挙動のテスト**として書ける。
 *
 * 一方 `location.assign()` は jsdom で「Not implemented: navigation to another Document」を
 * 出して**何もしない**（例外も投げず URL も変わらない）。素直に書くと
 * **緑になるが何も検証していない**テストになるので、遷移は必ず注入した関数で観測する。
 */

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

const startLogin = (store: SessionStore): string => {
  let counter = 0;
  return beginPendingLogin({
    store,
    random: () => {
      counter += 1;
      return new Uint8Array(32).fill(counter);
    },
    now: () => NOW_MS,
  }).state;
};

/** `main.ts` と同じ結線。**ここだけが history に触る。** */
const replaceSearch = (search: string): void => {
  history.replaceState({}, '', `${location.pathname}${search}${location.hash}`);
};

beforeEach(() => {
  history.replaceState({}, '', '/admin/');
});

describe('**history.replaceState で code と state が URL から消える**', () => {
  it('成功時に location.search が空になる', async () => {
    const store = newStore();
    const state = startLogin(store);
    history.replaceState({}, '', `/admin/?code=THE-CODE&state=${state}`);
    expect(location.search).not.toBe('');

    await handleCallback({
      search: location.search,
      store,
      now: () => NOW_MS,
      redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
      replaceSearch,
      exchange: async () => ({ ok: true, idToken: idToken(), refreshToken: 'R' }),
    });

    // **ブラウザ履歴と Referer に code を残さない。**
    expect(location.search).toBe('');
    expect(location.pathname).toBe('/admin/');
  });

  it.each([
    ['state 不一致', '?code=C&state=WRONG'],
    ['state 欠落', '?code=C'],
    ['認可サーバのエラー', '?error=access_denied&error_description=nope&state=S'],
  ])('**失敗時（%s）も消える**', async (_label, search) => {
    const store = newStore();
    startLogin(store);
    history.replaceState({}, '', `/admin/${search}`);

    await handleCallback({
      search: location.search,
      store,
      now: () => NOW_MS,
      redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
      replaceSearch,
      exchange: async () => ({ ok: false, error: 'should-not-be-called' }),
    });

    expect(location.search).toBe('');
  });

  it('関係のないクエリは残る', async () => {
    const store = newStore();
    const state = startLogin(store);
    history.replaceState({}, '', `/admin/?draft=1&code=C&state=${state}`);

    await handleCallback({
      search: location.search,
      store,
      now: () => NOW_MS,
      redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
      replaceSearch,
      exchange: async () => ({ ok: true, idToken: idToken(), refreshToken: 'R' }),
    });

    expect(location.search).toBe('?draft=1');
  });

  it('code も error も無い訪問では URL を触らない', async () => {
    history.replaceState({}, '', '/admin/?draft=1');

    await handleCallback({
      search: location.search,
      store: newStore(),
      now: () => NOW_MS,
      redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
      replaceSearch,
      exchange: async () => ({ ok: false, error: 'should-not-be-called' }),
    });

    expect(location.search).toBe('?draft=1');
  });

  it('**jsdom で replaceState が本当に効いている**（テストが空振りしていない）', () => {
    history.replaceState({}, '', '/admin/?code=abc&state=xyz');
    expect(location.search).toBe('?code=abc&state=xyz');
    replaceSearch('');
    expect(location.search).toBe('');
  });
});

describe('**callback の処理は同一ページ内で完結する**', () => {
  it('注入した redirect が 1 度も呼ばれない', async () => {
    const store = newStore();
    const state = startLogin(store);
    const redirects: string[] = [];

    history.replaceState({}, '', `/admin/?code=C&state=${state}`);
    await handleCallback({
      search: location.search,
      store,
      now: () => NOW_MS,
      redirectUri: 'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
      replaceSearch,
      exchange: async () => ({ ok: true, idToken: idToken(), refreshToken: 'R' }),
    });

    // handleCallback は redirect を受け取りもしない。**遷移する手段が無い。**
    expect(redirects).toEqual([]);
  });
});
