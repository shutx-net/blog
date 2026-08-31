import { describe, expect, it } from 'vitest';
import { AUTH_HEADER, AUTH_SCHEME } from '../../src/auth/session.ts';
import * as apiTransport from '@blog/api/src/auth/transport.ts';
import { createCognitoAuthTransport, createStubAuthTransport } from '../../src/auth/session.ts';
import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { saveSession } from '../../src/auth/session-state.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';

/**
 * admin と api がトークン輸送について**同じ文字列を見ている**ことを固定する。
 *
 * 書き写すと、片方だけ変わったときに「admin は送っているのに api は読まない」
 * という壊れ方をする。401 になるだけで、どちらが悪いか分からない。
 */
describe('トークン輸送の契約が api と一致する', () => {
  it('AUTH_HEADER が api 側と同一である', () => {
    expect(AUTH_HEADER).toBe(apiTransport.AUTH_HEADER);
    expect(AUTH_HEADER).toBe('x-blog-authorization');
  });

  it('AUTH_SCHEME が api 側と同一である', () => {
    expect(AUTH_SCHEME).toBe(apiTransport.AUTH_SCHEME);
    expect(AUTH_SCHEME).toBe('Bearer');
  });

  it('**authorization ではない。** CloudFront が上書きするため使えない', () => {
    expect(AUTH_HEADER).not.toBe('authorization');
  });

  it('スタブはヘッダを送らない（トークンが無いので api は 401 を返すのが正しい）', async () => {
    const stub = createStubAuthTransport();
    expect(await stub.authHeaders()).toEqual({});
    expect(stub.isAuthenticated()).toBe(false);
  });

  it('**本物の transport が返すキーが api 側の AUTH_HEADER と一致する**', async () => {
    // 契約の確認を「型と定数」から「実際に出てくる値」まで広げる。
    // ここが無いと、定数は一致しているのに組み立てで別の名前を使う経路が残る。
    const entries = new Map<string, string>();
    const store = createSessionStore({
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    });
    const nowMs = 1_800_000_000_000;
    const idToken = [
      'eyJhbGciOiJSUzI1NiJ9',
      base64UrlEncode(
        utf8Bytes(
          JSON.stringify({
            exp: nowMs / 1000 + 3600,
            aud: AUTH_CONFIG.clientId,
            iss: AUTH_CONFIG.issuer,
            token_use: 'id',
            'cognito:username': 'shutx',
          }),
        ),
      ),
      'sig',
    ].join('.');
    saveSession(
      store,
      { ok: true, idToken, refreshToken: 'R' },
      { clientId: AUTH_CONFIG.clientId, issuer: AUTH_CONFIG.issuer },
    );

    const headers = await createCognitoAuthTransport({ store, now: () => nowMs }).authHeaders();
    expect(Object.keys(headers)).toEqual([apiTransport.AUTH_HEADER]);
    expect(headers[apiTransport.AUTH_HEADER]).toBe(`${apiTransport.AUTH_SCHEME} ${idToken}`);
  });
});
