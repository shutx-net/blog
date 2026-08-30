import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_MAX_LIFETIME_SECONDS, createAppJwt } from '../../src/github/jwt.ts';

/**
 * **署名器はモックしない。** モックした署名は「GitHub が検証できる」ことを何も
 * 証明しない。テスト内で本物の RSA 鍵を作り、node:crypto の createVerify で
 * 実際に検証する。
 */
let pkcs1Pem = '';
let pkcs8Pem = '';
let publicPem = '';

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // GitHub が配る形式（-----BEGIN RSA PRIVATE KEY-----）。
  pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  // 運用者が openssl pkcs8 -topk8 で変換していた場合の形式。
  pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

const NOW = 1_800_000_000;

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;

const parts = (jwt: string): [string, string, string] => {
  const segments = jwt.split('.');
  expect(segments, 'JWT は 3 セグメント').toHaveLength(3);
  return segments as [string, string, string];
};

describe('鍵の形式', () => {
  it('PKCS#1（GitHub が配る形式）で署名でき、公開鍵で検証が通る', () => {
    // **これが jose を採らなかった理由そのもの。** jose の importPKCS8 は
    // この PEM を TypeError で拒否する。node:crypto はそのまま受け取る。
    expect(pkcs1Pem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    const jwt = createAppJwt({ privateKeyPem: pkcs1Pem, issuer: 'Iv23liABC', nowSeconds: NOW });
    const [header, payload, signature] = parts(jwt);
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicPem, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
  });

  it('PKCS#8（openssl で変換済み）でも署名・検証できる', () => {
    expect(pkcs8Pem).toContain('-----BEGIN PRIVATE KEY-----');
    const jwt = createAppJwt({ privateKeyPem: pkcs8Pem, issuer: 'Iv23liABC', nowSeconds: NOW });
    const [header, payload, signature] = parts(jwt);
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(createPublicKey(pkcs8Pem), Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('別の鍵では検証が通らない（署名が本当に鍵に依存している）', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createAppJwt({ privateKeyPem: pkcs1Pem, issuer: 'Iv23liABC', nowSeconds: NOW });
    const [header, payload, signature] = parts(jwt);
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(other.publicKey.export({ type: 'spki', format: 'pem' }).toString(), Buffer.from(signature, 'base64url')),
    ).toBe(false);
  });
});

describe('ヘッダとペイロード', () => {
  const jwt = (): string =>
    createAppJwt({ privateKeyPem: pkcs1Pem, issuer: 'Iv23liABC', nowSeconds: NOW });

  it("alg が 'RS256'、typ が 'JWT'", () => {
    // docs.github.com: "Your JWT must be signed using the RS256 algorithm"
    const header = decodeSegment(parts(jwt())[0]);
    expect(header['alg']).toBe('RS256');
    expect(header['typ']).toBe('JWT');
  });

  it('alg に none や HS256 を使っていない', () => {
    const header = decodeSegment(parts(jwt())[0]);
    expect(['none', 'HS256', 'HS384', 'HS512']).not.toContain(header['alg']);
  });

  it('iat が現在時刻の 60 秒前である', () => {
    // docs: "To protect against clock drift, we recommend that you set this
    // 60 seconds in the past". 時刻は注入したクロックで固定する。
    expect(decodeSegment(parts(jwt())[1])['iat']).toBe(NOW - 60);
  });

  it('exp - iat が 600 秒以下で、exp - now も 600 秒以下である', () => {
    // docs: "The time must be no more than 10 minutes into the future".
    // iat が -60 秒なので、両方を主張しないと片方だけ満たす実装を見逃す。
    const payload = decodeSegment(parts(jwt())[1]);
    const iat = payload['iat'] as number;
    const exp = payload['exp'] as number;
    expect(exp - iat).toBeLessThanOrEqual(JWT_MAX_LIFETIME_SECONDS);
    expect(exp - NOW).toBeLessThanOrEqual(JWT_MAX_LIFETIME_SECONDS);
    expect(exp).toBeGreaterThan(NOW);
  });

  it('JWT_MAX_LIFETIME_SECONDS が 600 である（GitHub の上限）', () => {
    expect(JWT_MAX_LIFETIME_SECONDS).toBe(600);
  });

  it('iss がコンフィグから来た client ID そのものである', () => {
    // docs: "The client ID or application ID of your GitHub App ...
    // Use of the client ID is recommended."
    const payload = decodeSegment(
      parts(createAppJwt({ privateKeyPem: pkcs1Pem, issuer: 'Iv23liXYZ', nowSeconds: NOW }))[1],
    );
    expect(payload['iss']).toBe('Iv23liXYZ');
  });

  it('ペイロードに余計なフィールドが無い（iat / exp / iss ちょうど 3 つ）', () => {
    expect(Object.keys(decodeSegment(parts(jwt())[1])).sort()).toEqual(['exp', 'iat', 'iss']);
  });
});

describe('エンコーディング', () => {
  const jwt = (): string =>
    createAppJwt({ privateKeyPem: pkcs1Pem, issuer: 'Iv23liABC', nowSeconds: NOW });

  it('3 セグメントで、各セグメントが base64url である', () => {
    for (const segment of parts(jwt())) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(segment).not.toContain('+');
      expect(segment).not.toContain('/');
      expect(segment).not.toContain('=');
    }
  });

  it('署名対象が先頭 2 セグメントを "." で連結した文字列そのものである', () => {
    // padding や JSON のキー順で壊れる典型を落とす。生成物を自分で分解して、
    // **その文字列**に対して検証する（実装が内部で何を署名したかに依存しない）。
    const token = jwt();
    const [header, payload, signature] = parts(token);
    const signingInput = `${header}.${payload}`;
    expect(token.startsWith(`${signingInput}.`)).toBe(true);
    expect(
      createVerify('RSA-SHA256')
        .update(signingInput)
        .verify(publicPem, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('1 バイトでも改竄すると検証が落ちる', () => {
    const [header, payload, signature] = parts(jwt());
    const tampered = decodeSegment(payload);
    tampered['iss'] = 'attacker';
    const forged = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url');
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${forged}`)
        .verify(publicPem, Buffer.from(signature, 'base64url')),
    ).toBe(false);
  });
});

describe('鍵が壊れているとき', () => {
  it.each([
    ['空文字', ''],
    ['PEM ではない', 'not a pem at all'],
    ['ヘッダだけ', '-----BEGIN RSA PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----\n'],
    ['本文が壊れている', '-----BEGIN RSA PRIVATE KEY-----\nQUJD!!!\n-----END RSA PRIVATE KEY-----\n'],
  ])('%s のとき、例外に鍵の中身も -----BEGIN も含まれない', (_label, pem) => {
    // 例外はログに載る前提で書く。node:crypto の元例外をそのまま投げると
    // 実装によっては入力を含みうるので、こちらでラップして情報を落とす。
    let thrown: Error | undefined;
    try {
      createAppJwt({ privateKeyPem: pem, issuer: 'Iv23liABC', nowSeconds: NOW });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown, '壊れた PEM では投げること').toBeDefined();
    const text = `${thrown?.message ?? ''}\n${thrown?.stack ?? ''}`;
    expect(text).not.toContain('-----BEGIN');
    if (pem.length > 0) expect(text).not.toContain(pem);
  });

  it('本物の鍵の本文が例外に出ない', () => {
    // 「壊れた鍵」だけでなく、正しい鍵の一部が漏れる経路が無いことも見る。
    const body = pkcs1Pem.split('\n')[1] as string;
    expect(body.length).toBeGreaterThan(16);
    let text = '';
    try {
      createAppJwt({ privateKeyPem: `${pkcs1Pem}garbage`, issuer: 'x', nowSeconds: NOW });
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain(body);
  });
});
