import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { isAcceptable, readIdTokenClaims } from '../../src/auth/claims.ts';

const CLAIMS_SOURCE = fileURLToPath(new URL('../../src/auth/claims.ts', import.meta.url));

const CLIENT_ID = '6idd147v3chsa6qhv6d02ao3ko';
const ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_MhH4fmqkb';

/**
 * テスト用の JWT。**署名部分は 'x' でよい** —
 * このモジュールは署名を見ないので、見ないことがテストからも読み取れる。
 */
const jwtWith = (payload: unknown): string =>
  ['eyJhbGciOiJSUzI1NiJ9', base64UrlEncode(utf8Bytes(JSON.stringify(payload))), 'x'].join('.');

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  exp: 1_800_000_000,
  aud: CLIENT_ID,
  iss: ISSUER,
  token_use: 'id',
  'cognito:username': 'shutx',
  ...overrides,
});

describe('ID トークンのクレーム読み取り', () => {
  it('5 つのクレームを取り出す', () => {
    const claims = readIdTokenClaims(jwtWith(validPayload()));
    expect(claims).toBeDefined();
    expect(claims?.expiresAtMs).toBe(1_800_000_000_000);
    expect(claims?.audience).toEqual([CLIENT_ID]);
    expect(claims?.issuer).toBe(ISSUER);
    expect(claims?.tokenUse).toBe('id');
    expect(claims?.username).toBe('shutx');
  });

  it('**exp を秒からミリ秒に直して返す**（単位の取り違えを 1 箇所に閉じる）', () => {
    // 1000 倍の取り違えは「永遠に有効」か「常に期限切れ」になる。境界はここだけ。
    expect(readIdTokenClaims(jwtWith(validPayload({ exp: 1 })))?.expiresAtMs).toBe(1000);
  });

  it('**UTF-8 が壊れない**（atob の結果を素直に JSON.parse すると化ける）', () => {
    const claims = readIdTokenClaims(
      jwtWith(validPayload({ 'cognito:username': 'ünïcode-🎉-日本語' })),
    );
    expect(claims?.username).toBe('ünïcode-🎉-日本語');
  });

  it('aud が配列形式でも読める（OIDC では文字列でも配列でもよい）', () => {
    expect(readIdTokenClaims(jwtWith(validPayload({ aud: [CLIENT_ID] })))?.audience).toEqual([
      CLIENT_ID,
    ]);
  });
});

describe('**壊れたトークンは「無い」と同じ扱いにする（投げない）**', () => {
  it.each([
    ['セグメント 0/1 個（空文字）', ''],
    ['セグメント 1 個', 'abc'],
    ['セグメント 2 個', 'header.payload'],
    ['セグメント 4 個', 'a.b.c.d'],
    ['セグメント 5 個', 'a.b.c.d.e'],
  ])('%s は undefined', (_label, jwt) => {
    // **呼び出し側に try/catch を強制しない。** 壊れたトークンは無いのと同じ。
    expect(() => readIdTokenClaims(jwt)).not.toThrow();
    expect(readIdTokenClaims(jwt)).toBeUndefined();
  });

  it.each([
    ['base64url でない', 'h.@@@@@.x'],
    ['JSON でない', ['h', base64UrlEncode(utf8Bytes('not json at all')), 'x'].join('.')],
    ['JSON だが配列', ['h', base64UrlEncode(utf8Bytes('[1,2,3]')), 'x'].join('.')],
    ['JSON だが文字列', ['h', base64UrlEncode(utf8Bytes('"scalar"')), 'x'].join('.')],
    ['JSON だが数値', ['h', base64UrlEncode(utf8Bytes('42')), 'x'].join('.')],
    ['JSON だが null', ['h', base64UrlEncode(utf8Bytes('null')), 'x'].join('.')],
    ['ペイロードが空', ['h', '', 'x'].join('.')],
  ])('%s は undefined', (_label, jwt) => {
    expect(() => readIdTokenClaims(jwt)).not.toThrow();
    expect(readIdTokenClaims(jwt)).toBeUndefined();
  });

  it.each([
    ['文字列', '1800000000'],
    ['null', null],
    ['真偽値', true],
    ['オブジェクト', { at: 1 }],
    ['配列', [1800000000]],
  ])('**exp が数値でない（%s）トークンは受け入れない**', (_label, exp) => {
    // 期限を知らないまま持ち続けると「永遠に有効」として扱ってしまう。
    expect(readIdTokenClaims(jwtWith(validPayload({ exp })))).toBeUndefined();
  });

  it('**exp が欠落しているトークンも受け入れない**', () => {
    const payload = validPayload();
    delete payload['exp'];
    expect(readIdTokenClaims(jwtWith(payload))).toBeUndefined();
  });
});

/**
 * **これは「検証」ではない。**
 *
 * 検証の権威は api ただ 1 つ（`api/src/auth/cognito.ts` が aws-jwt-verify で
 * 署名まで見る）。ここは「トークンエンドポイントの応答が想定どおりか」を見る番人で、
 * 攻撃対策というより**設定を間違えたときに黙って進まないため**のもの。
 */
describe('isAcceptable — 健全性チェック', () => {
  const expected = { clientId: CLIENT_ID, issuer: ISSUER };
  const claimsOf = (overrides: Record<string, unknown> = {}) => {
    const claims = readIdTokenClaims(jwtWith(validPayload(overrides)));
    expect(claims, 'テストの前提としてクレームが読めていること').toBeDefined();
    return claims;
  };

  it('想定どおりのトークンは true', () => {
    expect(isAcceptable(claimsOf(), expected)).toBe(true);
  });

  it('**攻撃 5: aud が別のクライアント ID なら false**', () => {
    expect(isAcceptable(claimsOf({ aud: 'someoneelsesclientid00000x' }), expected)).toBe(false);
  });

  it('**iss が違えば false**', () => {
    expect(
      isAcceptable(
        claimsOf({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_evil0000' }),
        expected,
      ),
    ).toBe(false);
  });

  it.each(['access', 'refresh', 'ID', '', 'id '])(
    '**token_use が "%s" なら false**（access トークンを掴まされたときに弾く）',
    (tokenUse) => {
      expect(isAcceptable(claimsOf({ token_use: tokenUse }), expected)).toBe(false);
    },
  );

  it('token_use が欠落していれば false', () => {
    const payload = validPayload();
    delete payload['token_use'];
    expect(isAcceptable(readIdTokenClaims(jwtWith(payload)), expected)).toBe(false);
  });

  it('aud が [clientId] ちょうどの配列なら true', () => {
    expect(isAcceptable(claimsOf({ aud: [CLIENT_ID] }), expected)).toBe(true);
  });

  it('**aud の配列に clientId 以外が混ざっていたら false**', () => {
    expect(isAcceptable(claimsOf({ aud: [CLIENT_ID, 'anotherclientid0000000000x'] }), expected)).toBe(
      false,
    );
  });

  it('aud が空配列なら false', () => {
    expect(isAcceptable(claimsOf({ aud: [] }), expected)).toBe(false);
  });

  it('クレームが undefined なら false（読めなかったトークンを受理しない）', () => {
    expect(isAcceptable(undefined, expected)).toBe(false);
  });
});

describe('**この関数は「検証」を名乗らない**', () => {
  it.each(['crypto.subtle.verify', 'importKey', 'jwks'])(
    'claims.ts に %s の綴りが現れない',
    (needle) => {
      // **署名検証をここに生やさせない。** 生やすなら JWKS 取得・鍵キャッシュ・
      // 鍵の import という一式が要り、それは「ライブラリを入れない」判断の前提を崩す。
      // 検証の権威は api ただ 1 つ（api/src/auth/cognito.ts）。
      expect(readFileSync(CLAIMS_SOURCE, 'utf8').toLowerCase()).not.toContain(needle.toLowerCase());
    },
  );

  it('検出規則そのものが機能する（綴りがあれば捕まえる）', () => {
    const sample = 'await crypto.subtle.verify(alg, key, sig, data);';
    expect(sample.toLowerCase()).toContain('crypto.subtle.verify');
  });
});
