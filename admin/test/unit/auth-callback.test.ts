import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { handleCallback } from '../../src/auth/callback.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import {
  PENDING_LOGIN_KEY,
  beginPendingLogin,
  consumePendingLogin,
} from '../../src/auth/pending-login.ts';
import type { PendingLogin } from '../../src/auth/pending-login.ts';
import { loadSession } from '../../src/auth/session-state.ts';
import { exchangeCode } from '../../src/auth/token-endpoint.ts';
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
const REDIRECT_URI = 'https://d8gsxbwzr6ft8.cloudfront.net/admin/';

const idTokenWith = (overrides: Record<string, unknown> = {}): string =>
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
          ...overrides,
        }),
      ),
    ),
    'sig',
  ].join('.');

interface Harness {
  store: SessionStore;
  tokenCalls: URLSearchParams[];
  replaced: string[];
  run(search: string): ReturnType<typeof handleCallback>;
}

/**
 * **交換は実物の `exchangeCode` を通す。** 偽 fetch を刺して body を読むので、
 * 「token エンドポイントに何が届いたか」まで観測できる。
 */
const harness = (
  responder: () => Response = () => tokenResponse(),
  store: SessionStore = newStore(),
): Harness => {
  const tokenCalls: URLSearchParams[] = [];
  const replaced: string[] = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    tokenCalls.push(new URLSearchParams(String(init?.body ?? '')));
    return responder();
  };

  return {
    store,
    tokenCalls,
    replaced,
    run: (search: string) =>
      handleCallback({
        search,
        store,
        now: () => NOW_MS,
        redirectUri: REDIRECT_URI,
        replaceSearch: (next) => {
          replaced.push(next);
        },
        exchange: (args) => exchangeCode({ ...args }, fetchImpl),
      }),
  };
};

const tokenResponse = (body: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({ id_token: idTokenWith(), refresh_token: 'R-TOKEN', ...body }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * ログインを開始する。
 *
 * **カウンタはこのモジュールで 1 本だけ持つ。** ヘルパの中で毎回 0 に戻すと、
 * 2 回呼んでも同じ state になってしまい「使い回し」のテストが空振りする。
 */
let randomCounter = 0;
const startLogin = (store: SessionStore, at = NOW_MS): PendingLogin =>
  beginPendingLogin({
    store,
    random: () => {
      randomCounter += 1;
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) bytes[i] = (randomCounter * 53 + i * 11) % 256;
      return bytes;
    },
    now: () => at,
  });

describe('正常系', () => {
  it('token エンドポイントが **1 回だけ** 呼ばれ、code と verifier が一致する', async () => {
    const h = harness();
    const begun = startLogin(h.store);

    const result = await h.run(`?code=THE-CODE&state=${begun.state}`);

    expect(result).toEqual({ kind: 'signed_in', returnTo: '/admin/' });
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.tokenCalls[0]?.get('code')).toBe('THE-CODE');
    expect(h.tokenCalls[0]?.get('code_verifier')).toBe(begun.verifier);
    expect(h.tokenCalls[0]?.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('セッションが保存される', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    await h.run(`?code=C&state=${begun.state}`);

    const session = loadSession(h.store);
    expect(session?.idToken).toBe(idTokenWith());
    expect(session?.refreshToken).toBe('R-TOKEN');
  });

  it('pending レコードが消える（単回使用）', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    await h.run(`?code=C&state=${begun.state}`);
    expect(h.store.get(PENDING_LOGIN_KEY)).toBeUndefined();
  });

  it('returnTo が保存した値で返る', async () => {
    const store = newStore();
    const h = harness(() => tokenResponse(), store);
    let counter = 0;
    const begun = beginPendingLogin({
      store,
      random: () => {
        counter += 1;
        return new Uint8Array(32).fill(counter);
      },
      now: () => NOW_MS,
      returnTo: '/admin/?resume=1',
    });
    await expect(h.run(`?code=C&state=${begun.state}`)).resolves.toEqual({
      kind: 'signed_in',
      returnTo: '/admin/?resume=1',
    });
  });
});

describe('**攻撃 1: code の再生**', () => {
  it('同じ callback を 2 回処理しても token エンドポイントの呼び出しは合計 1 回', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    const search = `?code=C&state=${begun.state}`;

    await h.run(search);
    const second = await h.run(search);

    // **認可サーバ側の code 単回使用に依存しない。** こちら側で閉じている。
    expect(h.tokenCalls).toHaveLength(1);
    expect(second).toEqual({ kind: 'failed', reason: 'no_pending_login' });
  });
});

describe('**攻撃 2: state 不一致（CSRF / session fixation）**', () => {
  it('token エンドポイントの呼び出しが **0 回**', async () => {
    const h = harness();
    startLogin(h.store);

    const result = await h.run('?code=ATTACKER-CODE&state=OTHER-STATE');

    // **0 回であることが load-bearing。** 攻撃者の code が 1 度でもエンドポイントに
    // 届けば、セッションが攻撃者のアカウントに固定される。
    expect(h.tokenCalls).toHaveLength(0);
    expect(result).toEqual({ kind: 'failed', reason: 'state_mismatch' });
    expect(loadSession(h.store)).toBeUndefined();
  });

  it('pending レコードは壊されない（正規の利用者はまだ完了できる）', async () => {
    const h = harness();
    const begun = startLogin(h.store);

    await h.run('?code=ATTACKER-CODE&state=OTHER');
    await expect(h.run(`?code=REAL&state=${begun.state}`)).resolves.toEqual({
      kind: 'signed_in',
      returnTo: '/admin/',
    });
  });
});

describe('**攻撃 3: state の欠落**', () => {
  it.each([
    ['state 無し', '?code=ATTACKER-CODE'],
    ['state が空', '?code=ATTACKER-CODE&state='],
  ])('%s -> state_missing、呼び出し 0 回', async (_label, search) => {
    const h = harness();
    startLogin(h.store);
    const result = await h.run(search);

    expect(h.tokenCalls).toHaveLength(0);
    expect(result).toEqual({ kind: 'failed', reason: 'state_missing' });
  });
});

describe('**攻撃 4: ログイン未開始での偽 callback**', () => {
  it('store が空なら no_pending_login、呼び出し 0 回', async () => {
    const h = harness();
    const result = await h.run('?code=ATTACKER-CODE&state=ANY-STATE');

    expect(h.tokenCalls).toHaveLength(0);
    expect(result).toEqual({ kind: 'failed', reason: 'no_pending_login' });
    expect(loadSession(h.store)).toBeUndefined();
  });
});

describe('**攻撃 5: 別 aud / iss / token_use のトークン**', () => {
  it.each([
    ['aud が違う', { aud: 'anotherclientid0000000000x' }],
    ['iss が違う', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x' }],
    ['token_use が access', { token_use: 'access' }],
    ['exp が読めない', { exp: 'soon' }],
  ])('%s -> セッションを保存しない', async (_label, overrides) => {
    const h = harness(() => tokenResponse({ id_token: idTokenWith(overrides) }));
    const begun = startLogin(h.store);

    const result = await h.run(`?code=C&state=${begun.state}`);

    expect(result).toEqual({ kind: 'failed', reason: 'unacceptable_token' });
    expect(loadSession(h.store)).toBeUndefined();
  });

  it('id_token を含まない応答も失敗（保存しない）', async () => {
    const h = harness(
      () =>
        new Response(JSON.stringify({ access_token: 'A' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const begun = startLogin(h.store);
    const result = await h.run(`?code=C&state=${begun.state}`);

    expect(result.kind).toBe('failed');
    expect(loadSession(h.store)).toBeUndefined();
  });

  it('交換が invalid_grant なら exchange_failed（保存しない）', async () => {
    const h = harness(
      () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const begun = startLogin(h.store);

    await expect(h.run(`?code=C&state=${begun.state}`)).resolves.toEqual({
      kind: 'failed',
      reason: 'exchange_failed',
      error: 'invalid_grant',
    });
    expect(loadSession(h.store)).toBeUndefined();
  });
});

describe('**攻撃 6: verifier の使い回し**', () => {
  it('begin を 2 回してから 1 回目の state で戻ると state_mismatch、呼び出し 0 回', async () => {
    const h = harness();
    const first = startLogin(h.store, NOW_MS);
    const second = startLogin(h.store, NOW_MS + 1000);
    expect(first.state).not.toBe(second.state);

    const result = await h.run(`?code=C&state=${first.state}`);

    expect(h.tokenCalls).toHaveLength(0);
    expect(result).toEqual({ kind: 'failed', reason: 'state_mismatch' });
  });
});

describe('認可サーバからのエラー返し', () => {
  it('**実測した形**（error + error_description + state）で入ると交換しない', async () => {
    const h = harness();
    startLogin(h.store);

    const result = await h.run(
      '?error=invalid_request&error_description=unsupported_code_challenge_method&state=S',
    );

    expect(h.tokenCalls).toHaveLength(0);
    expect(result).toEqual({
      kind: 'provider_error',
      error: 'invalid_request',
      description: 'unsupported_code_challenge_method',
    });
  });

  it('**pending レコードを削除する**（やり直しは最初から）', async () => {
    const h = harness();
    startLogin(h.store);
    await h.run('?error=access_denied&state=S');
    expect(h.store.get(PENDING_LOGIN_KEY)).toBeUndefined();
  });

  it('**code を見ない**（error があれば code があっても交換しない）', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    const result = await h.run(`?error=access_denied&code=C&state=${begun.state}`);

    expect(h.tokenCalls).toHaveLength(0);
    expect(result.kind).toBe('provider_error');
  });

  it('error_description が無くても投げない', async () => {
    const h = harness();
    await expect(h.run('?error=server_error')).resolves.toEqual({
      kind: 'provider_error',
      error: 'server_error',
      description: undefined,
    });
  });

  it('**error_description をそのまま返すだけで、解釈も整形もしない**', async () => {
    // 認可サーバが返す任意文字列である。DOM に入れるのは必ず textContent 経由
    // （UI 側の責任。test/dom/auth-ui.test.ts が固定している）。
    const h = harness();
    const nasty = '<img src=x onerror=alert(1)>';
    const result = await h.run(`?error=invalid_request&error_description=${encodeURIComponent(nasty)}`);
    expect(result).toEqual({ kind: 'provider_error', error: 'invalid_request', description: nasty });
  });
});

describe('**普通に開いただけでは何も起きない**', () => {
  it.each([
    ['クエリ無し', ''],
    ['? だけ', '?'],
    ['関係ないクエリ', '?draft=1&utm_source=x'],
    ['state だけ（code も error も無い）', '?state=S'],
  ])('%s -> no_callback', async (_label, search) => {
    const h = harness();
    startLogin(h.store);
    const before = h.store.get(PENDING_LOGIN_KEY);

    const result = await h.run(search);

    expect(result).toEqual({ kind: 'no_callback' });
    expect(h.tokenCalls).toHaveLength(0);
    // **副作用が無い。** pending レコードも URL も触らない。
    expect(h.store.get(PENDING_LOGIN_KEY)).toEqual(before);
    expect(h.replaced).toEqual([]);
  });
});

describe('**URL から code と state を消す（交換の前に）**', () => {
  it('成功時に replaceSearch が呼ばれ、code / state が消える', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    await h.run(`?code=C&state=${begun.state}`);
    expect(h.replaced).toEqual(['']);
  });

  it('**交換の前に呼ばれる**（リロードでの二重交換を防ぐ）', async () => {
    // 交換はネットワーク往復なので、その間にリロードされると ?code= が再送される。
    // 先に URL から消しておけば、リロードは「code 無しの通常訪問」になる。
    const order: string[] = [];
    const store = newStore();
    const begun = startLogin(store);

    await handleCallback({
      search: `?code=C&state=${begun.state}`,
      store,
      now: () => NOW_MS,
      redirectUri: REDIRECT_URI,
      replaceSearch: () => {
        order.push('replaceSearch');
      },
      exchange: async () => {
        order.push('exchange');
        return { ok: true, idToken: idTokenWith(), refreshToken: 'R' };
      },
    });

    expect(order).toEqual(['replaceSearch', 'exchange']);
  });

  it.each([
    ['state 不一致', '?code=C&state=WRONG'],
    ['state 欠落', '?code=C'],
    ['認可サーバのエラー', '?error=access_denied&state=S'],
  ])('**失敗時（%s）も消す**', async (_label, search) => {
    const h = harness();
    startLogin(h.store);
    await h.run(search);
    expect(h.replaced).toEqual(['']);
  });

  it('関係のないクエリは残す', async () => {
    const h = harness();
    const begun = startLogin(h.store);
    await h.run(`?draft=1&code=C&state=${begun.state}&utm_source=mail`);
    expect(h.replaced).toEqual(['?draft=1&utm_source=mail']);
  });

  it('error_description と error_uri も消す（Referer に残さない）', async () => {
    const h = harness();
    await h.run('?error=x&error_description=y&error_uri=https%3A%2F%2Fexample.com&keep=1');
    expect(h.replaced).toEqual(['?keep=1']);
  });
});

describe('**リダイレクトを一切行わない**', () => {
  it('callback.ts に画面遷移の手段が無い', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../src/auth/callback.ts', import.meta.url)),
      'utf8',
    );
    // 処理は同一ページ内で完結する。**遷移する手段をそもそも持たない。**
    expect(source).not.toMatch(/\blocation\b/);
    expect(source).not.toMatch(/\bassign\s*\(/);
    expect(source).not.toMatch(/\bredirect\s*\(/);
  });
});

describe('TTL 超過', () => {
  it('10 分を超えた pending は expired、呼び出し 0 回', async () => {
    const store = newStore();
    const tokenCalls: URLSearchParams[] = [];
    const begun = startLogin(store, NOW_MS - 10 * 60 * 1000 - 1);

    const result = await handleCallback({
      search: `?code=C&state=${begun.state}`,
      store,
      now: () => NOW_MS,
      redirectUri: REDIRECT_URI,
      replaceSearch: () => {},
      exchange: async (args) => {
        tokenCalls.push(new URLSearchParams(args.code));
        return { ok: false, error: 'unused' };
      },
    });

    expect(tokenCalls).toHaveLength(0);
    expect(result).toEqual({ kind: 'failed', reason: 'expired' });
    expect(consumePendingLogin(store, begun.state, () => NOW_MS)).toEqual({
      ok: false,
      reason: 'no_pending_login',
    });
  });
});
