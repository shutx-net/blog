import { describe, expect, it } from 'vitest';

import { EMPTY_PAYLOAD_SHA256, sha256Hex, utf8Bytes } from '../../src/api/sha256.ts';

/**
 * `x-amz-content-sha256` の中身。
 *
 * CloudFront + OAC の `SigningBehavior: always` は届いたリクエストに SigV4 で
 * 署名するが、**ボディのハッシュだけは呼び出し側が付けないといけない**。
 * 付け忘れると Lambda が unsigned payload を拒んで 403 になり、それが
 * `CustomErrorResponses` によって **404 の HTML** に化ける（Phase 3 で実測）。
 *
 * ハッシュ計算にパッケージを入れていない。Web Crypto の
 * `crypto.subtle.digest('SHA-256', bytes)` は Node 24 でもブラウザでも
 * グローバルに存在する（実測）。
 */
describe('sha256Hex', () => {
  it('空ペイロードが SigV4 の既知の定数になる', async () => {
    // 実測でこの値を付けた GET /api/health は実配信で 200 が返る。
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('EMPTY_PAYLOAD_SHA256 が実際に空バイト列のハッシュと一致する', async () => {
    // 定数をベタ書きしているので、計算結果と食い違っていないことを確かめる。
    expect(EMPTY_PAYLOAD_SHA256).toBe(await sha256Hex(new Uint8Array(0)));
  });

  it('{"slug":"x"} が実配信で署名の通った値になる', async () => {
    // 実測: この値を付けて POST /api/posts に投げると 503 auth_not_configured が
    // 返る（= 署名が通った）。404 なら署名が失敗している。
    expect(await sha256Hex(utf8Bytes('{"slug":"x"}'))).toBe(
      '542a2b7daf61b872c20ad418cbd6853c3030cb03d90b57fbbfc3a1f4ee564b2c',
    );
  });

  it('常に小文字 16 進 64 文字を返す', async () => {
    for (const input of ['', 'a', '{"a":1}', '日本語', '🎉']) {
      expect(await sha256Hex(utf8Bytes(input))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('非 ASCII が UTF-8 として 1 度だけエンコードされる', async () => {
    // 文字列を 2 回エンコードしていないことの確認。
    const bytes = utf8Bytes('日本語🎉');
    expect(bytes.length).toBe(13);
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(new Uint8Array(bytes)));
  });

  it('\\r\\n を含んでもバイト列どおりにハッシュする', async () => {
    expect(await sha256Hex(utf8Bytes('a\r\nb'))).not.toBe(await sha256Hex(utf8Bytes('a\nb')));
  });

  it('1 バイト違えば別のハッシュになる', async () => {
    expect(await sha256Hex(utf8Bytes('a'))).not.toBe(await sha256Hex(utf8Bytes('b')));
  });
});

describe('utf8Bytes', () => {
  it('ASCII は 1 文字 1 バイト', () => {
    expect(utf8Bytes('abc')).toEqual(new Uint8Array([97, 98, 99]));
  });

  it('絵文字はサロゲートペアではなく 4 バイトになる', () => {
    expect(utf8Bytes('🎉').length).toBe(4);
  });
});
