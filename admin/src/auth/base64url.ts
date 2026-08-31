import type { Bytes } from '../api/sha256.ts';

/**
 * base64url（RFC 4648 §5）。**パッケージを入れていない。**
 *
 * `btoa` / `atob` はブラウザにも Node 24 にもグローバルで存在する（実測）。
 * 必要なのは 2 文字の置換とパディングの扱いだけで、`api/src/auth/` が
 * `node:crypto` だけで RS256 を書いたのと同じ判断（AGENTS.md
 * 「依存を足さない選択を先に検討する」）。
 *
 * **base64 と base64url を取り違えないこと。** `+` `/` `=` が 1 文字でも残ると
 * 認可サーバは `code_challenge` を受け取れない（`+` は URL のクエリで空白に化ける）。
 * test/unit/auth-pkce.test.ts が RFC 7636 のテストベクタで固定している。
 */

/**
 * バイト列 -> base64url。
 *
 * **`String.fromCharCode(...bytes)` のスプレッドを使わないこと。**
 * 引数が個数分スタックに積まれるので、大きな配列で RangeError になる。
 * ここに来るのは 32 バイトだが、将来大きな入力が来ても壊れない形で書いておく。
 */
export const base64UrlEncode = (bytes: Uint8Array): string => {
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  return btoa(latin1).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * base64url -> バイト列。
 *
 * **パディングを 4 の倍数まで復元してから `atob` に渡す。** 剥がしたまま渡すと
 * 実装によっては InvalidCharacterError になる。
 */
export const base64UrlDecodeToBytes = (text: string): Bytes => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const latin1 = atob(padded);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i += 1) bytes[i] = latin1.charCodeAt(i);
  return bytes;
};
