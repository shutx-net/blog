import { describe, expect, it } from 'vitest';

import { base64UrlDecodeToBytes, base64UrlEncode } from '../../src/auth/base64url.ts';
import { VERIFIER_BYTES, challengeFor, createVerifier } from '../../src/auth/pkce.ts';

/**
 * **RFC 7636 Appendix B のテストベクタ。**
 *
 * この 1 件が S256 実装の正しさの全部である。ライブラリを入れない判断
 * （計画の toolchain.rationale）の代償は「RFC の読み違いがこちらの責任になる」ことで、
 * その代償を払うのがこのファイル。
 */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** RFC 7636 Appendix B が明記している verifier のオクテット列（32 バイト）。 */
const RFC7636_OCTETS = new Uint8Array([
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105,
  214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]);

/** 注入する乱数源。**`crypto.getRandomValues` を実装から直接読ませないための口。** */
const fixedRandom = (bytes: Uint8Array) => (): Uint8Array => Uint8Array.from(bytes);

describe('base64url', () => {
  it('RFC 7636 のオクテット列が verifier の文字列にエンコードされる', () => {
    expect(base64UrlEncode(RFC7636_OCTETS)).toBe(RFC7636_VERIFIER);
  });

  it.each([
    ['0 バイト', []],
    ['1 バイト（余り 1）', [0xfb]],
    ['2 バイト（余り 2）', [0xfb, 0xff]],
    ['3 バイト（余り 0）', [0xfb, 0xff, 0xfe]],
  ])('%s の出力に + / = が 1 文字も無い', (_label, bytes) => {
    // **パディング剥がしと 2 文字の置換を忘れると Cognito が code_challenge を
    // 受け取れない。** 0xfb / 0xff は素の base64 で '+' と '/' を作るバイト列なので、
    // 置換が効いていなければここで落ちる。
    const encoded = base64UrlEncode(new Uint8Array(bytes));
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('置換が実際に起きている（素の base64 なら + と / が出る入力である）', () => {
    // 上の 4 件は「無いこと」の主張なので、エンコーダが常に空文字を返しても緑になる。
    // **素の base64 では実際に + と / が出ることを別に確かめる。**
    const latin1 = String.fromCharCode(0xfb, 0xff);
    expect(btoa(latin1)).toContain('+');
    expect(btoa(latin1)).toContain('/');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('全 256 値を含むバイト列が往復する', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect([...base64UrlDecodeToBytes(base64UrlEncode(all))]).toEqual([...all]);
  });

  it.each([0, 1, 2, 3, 31, 32, 33])('長さ %i のバイト列が往復する', (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) % 256;
    expect([...base64UrlDecodeToBytes(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it('RFC 7636 の verifier 文字列がオクテット列に戻る', () => {
    expect([...base64UrlDecodeToBytes(RFC7636_VERIFIER)]).toEqual([...RFC7636_OCTETS]);
  });
});

describe('PKCE の challenge（**S256 のテストベクタ**）', () => {
  it('challengeFor(RFC 7636 の verifier) が RFC の challenge ちょうどを返す', async () => {
    expect(await challengeFor(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  it('challenge が base64url（+ / = を含まない）', async () => {
    const challenge = await challengeFor(RFC7636_VERIFIER);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('verifier が違えば challenge も違う', async () => {
    expect(await challengeFor('a'.repeat(43))).not.toBe(await challengeFor('b'.repeat(43)));
  });
});

describe('verifier の生成', () => {
  it('注入した乱数から RFC 7636 の verifier が再現できる', () => {
    expect(createVerifier(fixedRandom(RFC7636_OCTETS))).toBe(RFC7636_VERIFIER);
  });

  it('RFC 3986 の unreserved 文字だけ・43〜128 文字', () => {
    const bytes = new Uint8Array(VERIFIER_BYTES);
    for (let i = 0; i < VERIFIER_BYTES; i += 1) bytes[i] = 255 - i;
    expect(createVerifier(fixedRandom(bytes))).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it('同じ乱数なら同じ verifier、違う乱数なら違う verifier', () => {
    const a = new Uint8Array(VERIFIER_BYTES).fill(1);
    const b = new Uint8Array(VERIFIER_BYTES).fill(2);
    expect(createVerifier(fixedRandom(a))).toBe(createVerifier(fixedRandom(a)));
    expect(createVerifier(fixedRandom(a))).not.toBe(createVerifier(fixedRandom(b)));
  });

  it('**乱数源を実際に呼んでいる**（定数を返す実装では緑にならない）', () => {
    let calls = 0;
    createVerifier(() => {
      calls += 1;
      return new Uint8Array(VERIFIER_BYTES).fill(7);
    });
    expect(calls).toBe(1);
  });

  it.each([0, 1, 16, 31, 33, 64])('%i バイトの乱数源に対して投げる', (length) => {
    // **短い乱数で静かに弱い verifier を作らない。**
    expect(() => createVerifier(fixedRandom(new Uint8Array(length)))).toThrow(/32/);
  });

  it('VERIFIER_BYTES が 32 である', () => {
    expect(VERIFIER_BYTES).toBe(32);
  });
});
