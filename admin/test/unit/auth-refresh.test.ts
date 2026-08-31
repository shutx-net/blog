import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { DEFAULT_SKEW_MS, createTokenSource, needsRefresh } from '../../src/auth/refresh.ts';
import { loadSession, saveSession } from '../../src/auth/session-state.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const REFRESH_SOURCE = fileURLToPath(new URL('../../src/auth/refresh.ts', import.meta.url));

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

/** `expSeconds` はミリ秒ではなく**秒**。 */
const idTokenExpiringAt = (expSeconds: number, overrides: Record<string, unknown> = {}): string =>
  [
    'eyJhbGciOiJSUzI1NiJ9',
    base64UrlEncode(
      utf8Bytes(
        JSON.stringify({
          exp: expSeconds,
          aud: AUTH_CONFIG.clientId,
          iss: AUTH_CONFIG.issuer,
          token_use: 'id',
          'cognito:username': 'shutx',
          ...overrides,
        }),
      ),
    ),
    'sig',
  ].join('.');

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

/** 期限まで `seconds` 秒あるセッションを store に入れる。 */
const seedSession = (store: SessionStore, seconds: number, refreshToken = 'R-TOKEN'): string => {
  const idToken = idTokenExpiringAt(NOW_S + seconds);
  const saved = saveSession(store, { ok: true, idToken, refreshToken }, EXPECTED);
  expect(saved, 'テストの前提としてセッションが保存できていること').toBeDefined();
  return idToken;
};

interface Spy {
  calls: number;
  impl: typeof fetch;
}

const respondingFetch = (responder: () => Response): Spy => {
  const spy: Spy = {
    calls: 0,
    impl: async () => {
      spy.calls += 1;
      return responder();
    },
  };
  return spy;
};

const jsonBody = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('needsRefresh', () => {
  it('skew が 120 秒である', () => {
    // ID トークンは 60 分。実質「残り 2 分を切ったら先に更新する」。
    expect(DEFAULT_SKEW_MS).toBe(120_000);
  });

  it.each([
    ['残り 10 分', 600_000, false],
    ['残り 121 秒', 121_000, false],
    ['残り 120 秒ちょうど', 120_000, true],
    ['残り 60 秒', 60_000, true],
    ['期限切れ', -1_000, true],
  ])('%s -> %s', (_label, remaining, expected) => {
    expect(
      needsRefresh({ idToken: 'x', refreshToken: 'r', expiresAtMs: NOW_MS + remaining }, NOW_MS, DEFAULT_SKEW_MS),
    ).toBe(expected);
  });
});

describe('**期限内は fetch を 1 度も呼ばない**', () => {
  it('残り 10 分なら token エンドポイントを呼ばず、そのまま返す', async () => {
    const store = newStore();
    const idToken = seedSession(store, 600);
    const spy = respondingFetch(() => jsonBody(200, {}));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await expect(source.currentIdToken()).resolves.toBe(idToken);
    expect(spy.calls).toBe(0);
  });

  it('セッションが無ければ undefined を返し、fetch も呼ばない', async () => {
    const spy = respondingFetch(() => jsonBody(200, {}));
    const source = createTokenSource({ store: newStore(), now: () => NOW_MS, fetchImpl: spy.impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();
    expect(spy.calls).toBe(0);
    expect(source.isAuthenticated()).toBe(false);
  });
});

describe('**攻撃 7 (a): 期限切れの前に先回りしてリフレッシュする**', () => {
  it('残り 60 秒なら refresh_token grant が 1 回呼ばれ、新しい ID トークンが使われる', async () => {
    const store = newStore();
    const oldToken = seedSession(store, 60);
    const newToken = idTokenExpiringAt(NOW_S + 3600);
    const spy = respondingFetch(() => jsonBody(200, { id_token: newToken }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    const got = await source.currentIdToken();

    expect(spy.calls).toBe(1);
    expect(got).toBe(newToken);
    expect(got).not.toBe(oldToken);
    // **401 を受けてから直すのではなく、その前に直す。**
    expect(loadSession(store)?.idToken).toBe(newToken);
  });

  it('リフレッシュ後も refresh トークンは保持される（応答に含まれないため）', async () => {
    const store = newStore();
    seedSession(store, 60, 'KEEP-ME');
    const spy = respondingFetch(() => jsonBody(200, { id_token: idTokenExpiringAt(NOW_S + 3600) }));

    await createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl }).currentIdToken();
    expect(loadSession(store)?.refreshToken).toBe('KEEP-ME');
  });

  it('refresh トークンを持たないセッションはリフレッシュを試みず、セッションを捨てる', async () => {
    const store = newStore();
    const idToken = idTokenExpiringAt(NOW_S + 60);
    saveSession(store, { ok: true, idToken, refreshToken: undefined }, EXPECTED);
    const spy = respondingFetch(() => jsonBody(200, {}));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();
    expect(spy.calls).toBe(0);
    expect(loadSession(store)).toBeUndefined();
  });
});

describe('**攻撃 7 (b): 多重リフレッシュを 1 本に畳む**', () => {
  it('同時に 3 本走らせてもリフレッシュは 1 回だけで、3 本とも同じ新トークンを受け取る', async () => {
    const store = newStore();
    seedSession(store, 60);
    const newToken = idTokenExpiringAt(NOW_S + 3600);

    let resolveResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    let calls = 0;
    const impl: typeof fetch = async () => {
      calls += 1;
      await gate;
      return jsonBody(200, { id_token: newToken });
    };

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: impl });
    const all = Promise.all([
      source.currentIdToken(),
      source.currentIdToken(),
      source.currentIdToken(),
    ]);
    resolveResponse?.();

    expect(await all).toEqual([newToken, newToken, newToken]);
    expect(calls, 'in-flight promise を共有していない').toBe(1);
  });

  it('1 回目が終わったあとの 2 回目は新しいリフレッシュを始めない（期限が延びている）', async () => {
    const store = newStore();
    seedSession(store, 60);
    const spy = respondingFetch(() => jsonBody(200, { id_token: idTokenExpiringAt(NOW_S + 3600) }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await source.currentIdToken();
    await source.currentIdToken();
    expect(spy.calls).toBe(1);
  });
});

describe('**攻撃 7 (c): refresh トークンの失効を編集中に踏む**', () => {
  it('invalid_grant を受けたらセッションを捨て、undefined を返す', async () => {
    const store = newStore();
    seedSession(store, 60);
    const spy = respondingFetch(() => jsonBody(400, { error: 'invalid_grant' }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });

    await expect(source.currentIdToken()).resolves.toBeUndefined();
    // (1) セッションが store から消える
    expect(loadSession(store)).toBeUndefined();
    // (2) isAuthenticated() が false
    expect(source.isAuthenticated()).toBe(false);
    // (3) **古いトークンを送り続けない**
    await expect(source.currentIdToken()).resolves.toBeUndefined();
  });

  it('**リフレッシュのモジュールは画面遷移を持たない**（自動リダイレクトしない）', () => {
    // (4) 注入した redirect が呼ばれないことの構造的な保証:
    // このモジュールには遷移する手段が 1 つも無い。
    const source = readFileSync(REFRESH_SOURCE, 'utf8');
    expect(source).not.toMatch(/\blocation\b/);
    expect(source).not.toMatch(/\bredirect\b/i);
    expect(source).not.toMatch(/\bassign\s*\(/);
    expect(source).not.toMatch(/\bhistory\b/);
  });

  it('遷移の検出規則そのものが機能する', () => {
    expect(/\blocation\b/.test('location.assign(url);')).toBe(true);
    expect(/\bredirect\b/i.test('deps.redirect(url);')).toBe(true);
  });
});

describe('**攻撃 7 (d): リフレッシュの連打が 401 ループにならない**', () => {
  it('invalid_grant のあと 3 回呼んでも token エンドポイントの呼び出しは 1 回', async () => {
    const store = newStore();
    seedSession(store, 60);
    const spy = respondingFetch(() => jsonBody(400, { error: 'invalid_grant' }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await source.currentIdToken();
    await source.currentIdToken();
    await source.currentIdToken();

    // セッションが消えた後は呼びに行かない。**これが 401 ループの構造的な不成立。**
    expect(spy.calls).toBe(1);
  });
});

describe('**ネットワーク失敗はセッションを消さない**', () => {
  it('fetch が reject してもセッションを保持し、undefined を返す', async () => {
    const store = newStore();
    seedSession(store, 60);
    const impl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();

    // **一時的な障害で 24 時間のセッションを捨てない。**
    expect(loadSession(store)).toBeDefined();
    expect(source.isAuthenticated()).toBe(true);
  });

  it('ネットワーク失敗のあとは再試行できる（in-flight が残っていない）', async () => {
    const store = newStore();
    seedSession(store, 60);
    const newToken = idTokenExpiringAt(NOW_S + 3600);
    let calls = 0;
    const impl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return jsonBody(200, { id_token: newToken });
    };

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();
    // **戻し忘れると失敗した 1 回が永久にキャッシュされる。**
    await expect(source.currentIdToken()).resolves.toBe(newToken);
    expect(calls).toBe(2);
  });

  it('invalid_grant とネットワーク失敗で扱いが違う（この 2 件が対）', async () => {
    const invalidStore = newStore();
    seedSession(invalidStore, 60);
    await createTokenSource({
      store: invalidStore,
      now: () => NOW_MS,
      fetchImpl: respondingFetch(() => jsonBody(400, { error: 'invalid_grant' })).impl,
    }).currentIdToken();

    const networkStore = newStore();
    seedSession(networkStore, 60);
    await createTokenSource({
      store: networkStore,
      now: () => NOW_MS,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }).currentIdToken();

    expect(loadSession(invalidStore), 'invalid_grant はセッションを捨てる').toBeUndefined();
    expect(loadSession(networkStore), 'network はセッションを保つ').toBeDefined();
  });
});

describe('リフレッシュ応答も isAcceptable を通す', () => {
  it.each([
    ['aud が違う', { aud: 'anotherclientid0000000000x' }],
    ['iss が違う', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x' }],
    ['token_use が access', { token_use: 'access' }],
  ])('%s トークンが返ってきたら保存せずセッションを捨てる', async (_label, overrides) => {
    const store = newStore();
    seedSession(store, 60);
    const bogus = idTokenExpiringAt(NOW_S + 3600, overrides);
    const spy = respondingFetch(() => jsonBody(200, { id_token: bogus }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();
    expect(loadSession(store)).toBeUndefined();
  });

  it('id_token を含まない 200 応答でもセッションを捨てる', async () => {
    const store = newStore();
    seedSession(store, 60);
    const spy = respondingFetch(() => jsonBody(200, { access_token: 'A' }));

    const source = createTokenSource({ store, now: () => NOW_MS, fetchImpl: spy.impl });
    await expect(source.currentIdToken()).resolves.toBeUndefined();
    expect(loadSession(store)).toBeUndefined();
  });
});

describe('**タイマーを使わない**', () => {
  it('refresh.ts に setTimeout / setInterval が現れない', () => {
    // (a) タブを一晩開いたままにすると無意味に発火し続ける
    // (b) スリープ復帰でタイマーがずれる
    // (c) テストが時計依存になる（bind.ts がデバウンスを避けたのと同じ理由）
    const source = readFileSync(REFRESH_SOURCE, 'utf8');
    expect(source).not.toMatch(/setTimeout|setInterval|requestIdleCallback/);
  });

  it('refresh.ts が Date.now を直接読まない（クロックは注入する）', () => {
    expect(readFileSync(REFRESH_SOURCE, 'utf8')).not.toMatch(/Date\s*\.\s*now/);
  });
});
