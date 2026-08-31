import { utf8Bytes } from '../api/sha256.ts';
import { base64UrlEncode } from './base64url.ts';

/**
 * PKCE（RFC 7636）。**S256 だけを実装する。**
 *
 * `plain` の分岐を作らない理由は 2 つ。
 *   (a) `plain` は「challenge = verifier」なので、認可要求を覗ける相手に対して無力。
 *       S256 以外を選ぶ理由がそもそも存在しない。
 *   (b) 分岐を作ると「使われない分岐」が残り、いつか誰かがそちらに落ちる。
 *
 * **PKCE はサーバ側で強制されていない。** 実測で `code_challenge` の無い
 * `/oauth2/authorize` も 302 する（`code_challenge_method=plain` を付けた authorize も
 * 302 する。**拒否されるとしても交換の時点であって、認可要求の時点ではない**）。
 * つまり**「PKCE を必ず送る」のはこちら側の規律**であり、`authorize-url.ts` が
 * 空の challenge に対して投げることで機械的に守っている。
 */

/** verifier の乱数バイト数。32 バイト -> base64url 43 文字（RFC 7636 の下限ちょうど）。 */
export const VERIFIER_BYTES = 32;

/**
 * 注入する乱数源。
 *
 * **`crypto.getRandomValues` をこのモジュールの中で直接読まない**（`api/src/deps.ts` と
 * `now()` 注入の思想に揃える）。本物を渡すのは `src/main.ts` だけで、テストは
 * 固定値を渡して RFC のテストベクタを再現する。
 */
export type RandomBytes = () => Uint8Array;

/**
 * code_verifier を作る。
 *
 * **32 バイトちょうどを要求する。** 短い乱数源を黙って受け入れると、
 * 「動いているが推測可能な verifier」という最悪の壊れ方をする。長さが違えば投げる。
 */
export const createVerifier = (random: RandomBytes): string => {
  const bytes = random();
  if (bytes.length !== VERIFIER_BYTES) {
    throw new Error(`pkce: 乱数源は ${VERIFIER_BYTES} バイトを返すこと（実際は ${bytes.length}）`);
  }
  return base64UrlEncode(bytes);
};

/**
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))。
 *
 * **`crypto.subtle.digest` は Promise を返すので async。** 呼び出し側もそれに合わせる。
 * `utf8Bytes` は `api/sha256.ts` の実物を使う — エンコードを 2 箇所に書かない
 * （`Bytes` の `ArrayBuffer` 裏付け問題もあちらで解決済み）。
 */
export const challengeFor = async (verifier: string): Promise<string> =>
  base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Bytes(verifier))));
