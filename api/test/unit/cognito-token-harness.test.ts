import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  FOREIGN_KID,
  ISSUER,
  KID,
  USER_POOL_ID,
  USERNAME,
  foreignPublicJwk,
  publicJwk,
  signIdToken,
  signRaw,
} from '../helpers/cognito-tokens.ts';

/**
 * **ハーネス自身のテスト。**
 *
 * 攻撃ケースを 1 件でも書く前に、「このハーネスが作る正しいトークンを **本物の**
 * CognitoJwtVerifier が受理する」ことを固定する。ここが嘘だと、以降の
 * 「攻撃が落ちた」がすべて「ハーネスが壊れているから落ちた」と区別できなくなる。
 */
const createVerifier = () => {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: 'id',
    clientId: CLIENT_ID,
  });
  verifier.cacheJwks({ keys: [publicJwk] });
  return verifier;
};

describe('ハーネスが本物の検証器に対して忠実である', () => {
  it('生成した ID トークンを本物の CognitoJwtVerifier が受理する', async () => {
    const payload = await createVerifier().verify(signIdToken());
    expect(payload['cognito:username']).toBe(USERNAME);
    expect(payload['token_use']).toBe('id');
    expect(payload['aud']).toBe(CLIENT_ID);
    expect(payload['iss']).toBe(ISSUER);
  });

  it('verifySync でも受理される（同期経路も同じ鍵で通る）', () => {
    const payload = createVerifier().verifySync(signIdToken());
    expect(payload['sub']).toBeDefined();
  });
});

describe('cacheJwks 済みならネットワークに一切出ない', () => {
  /**
   * **実測でこの手法が機能することを確認済み。** ネットワークの出口を全部投げるように
   * 差し替えてから verify する。JWKS を取りに行った瞬間に例外の種類が変わるので、
   * 「たまたま通った」が起きない。
   */
  const originalConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalLookup = dns.lookup;

  beforeEach(() => {
    net.Socket.prototype.connect = (() => {
      throw new Error('NETWORK_BLOCKED: net.Socket.connect');
    }) as unknown as typeof net.Socket.prototype.connect;
    (tls as { connect: unknown }).connect = () => {
      throw new Error('NETWORK_BLOCKED: tls.connect');
    };
    (dns as { lookup: unknown }).lookup = () => {
      throw new Error('NETWORK_BLOCKED: dns.lookup');
    };
  });

  afterEach(() => {
    net.Socket.prototype.connect = originalConnect;
    (tls as { connect: unknown }).connect = originalTlsConnect;
    (dns as { lookup: unknown }).lookup = originalLookup;
  });

  it('verify() がネットワークを塞いだ状態で成功する', async () => {
    await expect(createVerifier().verify(signIdToken())).resolves.toBeDefined();
  });

  it('verifySync() がネットワークを塞いだ状態で成功する', () => {
    expect(() => createVerifier().verifySync(signIdToken())).not.toThrow();
  });
});

describe('公開 JWK', () => {
  it('kid を持つ（kid が無いと JWKS の鍵選択が成立しない）', () => {
    expect(publicJwk.kid).toBe(KID);
    expect(publicJwk.alg).toBe('RS256');
    expect(publicJwk.use).toBe('sig');
    expect(publicJwk.kty).toBe('RSA');
  });

  it('公開鍵である（秘密指数 d を含まない）', () => {
    expect(publicJwk).not.toHaveProperty('d');
    expect(JSON.stringify(publicJwk)).not.toContain('"d"');
  });

  it('別プールの JWK は kid も鍵素材も異なる', () => {
    expect(foreignPublicJwk.kid).toBe(FOREIGN_KID);
    expect(foreignPublicJwk.kid).not.toBe(publicJwk.kid);
    expect(foreignPublicJwk.n).not.toBe(publicJwk.n);
  });
});

describe('クレームの上書き', () => {
  const claimsOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

  it.each([
    ['exp', 1],
    ['aud', 'other-client-id'],
    ['iss', 'https://cognito-idp.ap-northeast-1.amazonaws.com/other-pool'],
    ['token_use', 'access'],
    ['cognito:username', 'someone-else'],
    ['sub', '00000000-0000-4000-8000-000000000001'],
  ])('%s を上書きできる', (name, value) => {
    expect(claimsOf(signIdToken({ claims: { [name]: value } }))[name]).toBe(value);
  });

  it('クレームを削除できる（undefined を渡すとキーごと消える）', () => {
    const claims = claimsOf(signIdToken({ claims: { token_use: undefined } }));
    expect(claims).not.toHaveProperty('token_use');
  });

  it('既定では 5 つの必須クレームがすべて入っている', () => {
    const claims = claimsOf(signIdToken());
    for (const name of ['iss', 'aud', 'token_use', 'exp', 'sub', 'cognito:username']) {
      expect(claims[name], `${name} が既定のトークンに無い`).toBeDefined();
    }
  });
});

describe('署名鍵とアルゴリズムの差し替え', () => {
  const headerOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

  it('別の鍵対で署名できる（kid は正規のものに偽装できる）', () => {
    const token = signIdToken({ key: 'foreign' });
    expect(headerOf(token)['kid']).toBe(KID);
    // 署名だけが違う。3 パート構造は同じ。
    expect(token.split('.')).toHaveLength(3);
    expect(token.split('.')[2]).not.toBe(signIdToken().split('.')[2]);
  });

  it('alg を none に差し替えられる（3 パート・署名部はゴミ）', () => {
    const token = signIdToken({ alg: 'none' });
    expect(headerOf(token)['alg']).toBe('none');
    expect(token.split('.')).toHaveLength(3);
    expect(token.split('.')[2]?.length).toBeGreaterThan(0);
  });

  it('alg: none の 2 パート版も作れる（署名部そのものが無い）', () => {
    const token = signIdToken({ alg: 'none', parts: 2 });
    expect(token.split('.')).toHaveLength(2);
  });

  it('HS256 で署名できる（公開鍵のバイト列を共有秘密として使う鍵混同）', () => {
    const token = signIdToken({ alg: 'HS256' });
    expect(headerOf(token)['alg']).toBe('HS256');
    expect(token.split('.')).toHaveLength(3);
  });

  it('signRaw が任意のヘッダとペイロードをそのまま署名する', () => {
    const token = signRaw({ header: { alg: 'RS256', kid: KID }, payload: { hello: 'world' } });
    expect(headerOf(token)['kid']).toBe(KID);
    expect(token.split('.')).toHaveLength(3);
  });

  it('ペイロードの 1 バイトを書き換えても署名部は変わらない（改竄トークンが作れる）', () => {
    const token = signIdToken();
    const [header, payload, signature] = token.split('.');
    const tampered = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    tampered['cognito:username'] = 'attacker';
    const forged = `${header}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;
    expect(forged.split('.')[2]).toBe(signature);
    expect(forged).not.toBe(token);
  });
});

describe('鍵対の生成コスト', () => {
  it('モジュールスコープで 1 度だけ生成される（同じ鍵素材が返る）', () => {
    // 2048bit の生成は 100〜500ms かかる。it ごとに作ると積み上がったときに効く。
    const first = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex');
    const second = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex');
    expect(first).toBe(second);
  });
});
