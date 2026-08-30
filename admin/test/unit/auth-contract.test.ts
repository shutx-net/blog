import { describe, expect, it } from 'vitest';
import { AUTH_HEADER, AUTH_SCHEME } from '../../src/auth/session.ts';
import * as apiTransport from '@blog/api/src/auth/transport.ts';
import { createStubAuthTransport } from '../../src/auth/session.ts';

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

  it('スタブはヘッダを送らない（ログイン未実装。api は 401 を返すのが正しい）', async () => {
    const stub = createStubAuthTransport();
    expect(await stub.authHeaders()).toEqual({});
    expect(stub.isAuthenticated()).toBe(false);
  });
});
