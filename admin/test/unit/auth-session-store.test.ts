import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import {
  SESSION_KEY,
  clearSession,
  loadSession,
  saveSession,
} from '../../src/auth/session-state.ts';
import type { StoredSession } from '../../src/auth/session-state.ts';
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

const EXPECTED = { clientId: AUTH_CONFIG.clientId, issuer: AUTH_CONFIG.issuer };

/** `exp` は**秒**。ここで作るトークンの exp から expiresAtMs が決まる。 */
const idTokenWith = (overrides: Record<string, unknown> = {}): string =>
  [
    'eyJhbGciOiJSUzI1NiJ9',
    base64UrlEncode(
      utf8Bytes(
        JSON.stringify({
          exp: 1_800_003_600,
          aud: AUTH_CONFIG.clientId,
          iss: AUTH_CONFIG.issuer,
          token_use: 'id',
          'cognito:username': 'shutx',
          ...overrides,
        }),
      ),
    ),
    'signature-not-checked',
  ].join('.');

describe('saveSession', () => {
  it('idToken / refreshToken / expiresAtMs を保存する', () => {
    const store = newStore();
    const idToken = idTokenWith();
    const saved = saveSession(
      store,
      { ok: true, idToken, refreshToken: 'R-TOKEN' },
      EXPECTED,
    );

    expect(saved).toEqual({ idToken, refreshToken: 'R-TOKEN', expiresAtMs: 1_800_003_600_000 });
    expect(loadSession(store)).toEqual(saved);
  });

  it('**expiresAtMs は ID トークンの exp から作る**（応答の expires_in からではない）', () => {
    // expires_in を信じると、時計のずれや応答の作りで実際の期限とずれる。
    const store = newStore();
    const saved = saveSession(
      store,
      { ok: true, idToken: idTokenWith({ exp: 1_234_567 }), refreshToken: 'R' },
      EXPECTED,
    );
    expect(saved?.expiresAtMs).toBe(1_234_567_000);
  });

  it.each([
    ['exp が読めない', { exp: 'not-a-number' }],
    ['aud が違う', { aud: 'anotherclientid0000000000x' }],
    ['iss が違う', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x' }],
    ['token_use が access', { token_use: 'access' }],
  ])('**%s トークンは保存しない**', (_label, overrides) => {
    const store = newStore();
    expect(
      saveSession(store, { ok: true, idToken: idTokenWith(overrides), refreshToken: 'R' }, EXPECTED),
    ).toBeUndefined();
    expect(loadSession(store)).toBeUndefined();
  });

  it('壊れた JWT も保存しない（投げない）', () => {
    const store = newStore();
    expect(() =>
      saveSession(store, { ok: true, idToken: 'not.a.jwt', refreshToken: 'R' }, EXPECTED),
    ).not.toThrow();
    expect(loadSession(store)).toBeUndefined();
  });

  it('**refresh_token が応答に無ければ、既存の refresh トークンを保持する**', () => {
    // Cognito は既定でローテートしないので、リフレッシュの応答に refresh_token は
    // 含まれない。undefined で上書き保存すると**次のリフレッシュができなくなる。**
    const store = newStore();
    const previous: StoredSession = {
      idToken: 'OLD',
      refreshToken: 'KEEP-ME',
      expiresAtMs: 1,
    };
    const saved = saveSession(
      store,
      { ok: true, idToken: idTokenWith(), refreshToken: undefined },
      EXPECTED,
      previous,
    );
    expect(saved?.refreshToken).toBe('KEEP-ME');
    expect(loadSession(store)?.refreshToken).toBe('KEEP-ME');
  });

  it('応答に refresh_token があれば新しいほうで上書きする', () => {
    const store = newStore();
    const previous: StoredSession = { idToken: 'OLD', refreshToken: 'OLD-R', expiresAtMs: 1 };
    const saved = saveSession(
      store,
      { ok: true, idToken: idTokenWith(), refreshToken: 'NEW-R' },
      EXPECTED,
      previous,
    );
    expect(saved?.refreshToken).toBe('NEW-R');
  });

  it('前のセッションも無く応答にも refresh_token が無ければ undefined のまま保存する', () => {
    const store = newStore();
    const saved = saveSession(
      store,
      { ok: true, idToken: idTokenWith(), refreshToken: undefined },
      EXPECTED,
    );
    expect(saved?.refreshToken).toBeUndefined();
    expect(loadSession(store)).toBeDefined();
  });
});

describe('loadSession', () => {
  it('空の store では undefined', () => {
    expect(loadSession(newStore())).toBeUndefined();
  });

  it.each([
    ['壊れたレコード', { idToken: 123 }],
    ['expiresAtMs が無い', { idToken: 'x', refreshToken: 'r' }],
    ['idToken が空文字', { idToken: '', refreshToken: 'r', expiresAtMs: 1 }],
    ['空オブジェクト', {}],
    ['配列', [1, 2]],
  ])('%s は undefined（投げない）', (_label, record) => {
    const store = newStore();
    store.set(SESSION_KEY, record);
    expect(() => loadSession(store)).not.toThrow();
    expect(loadSession(store)).toBeUndefined();
  });
});

describe('clearSession', () => {
  it('保存したセッションを消す', () => {
    const store = newStore();
    saveSession(store, { ok: true, idToken: idTokenWith(), refreshToken: 'R' }, EXPECTED);
    expect(loadSession(store)).toBeDefined();
    clearSession(store);
    expect(loadSession(store)).toBeUndefined();
  });

  it('セッションが無くても投げない', () => {
    expect(() => clearSession(newStore())).not.toThrow();
  });
});
