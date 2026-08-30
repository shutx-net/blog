/**
 * `x-amz-content-sha256` の値を作る。
 *
 * **ハッシュ計算にパッケージを入れていない。** Web Crypto の
 * `crypto.subtle.digest('SHA-256', bytes)` は Node 24 でもブラウザでも
 * グローバルに存在する（実測）。`js-sha256` の類は不要で、api が RS256 を
 * `node:crypto` だけで書いたのと同じ判断（AGENTS.md「依存を足さない選択を
 * 先に検討する」）。
 *
 * ブラウザでは `crypto.subtle` に secure context が要るが、配信は https、
 * 開発は `http://localhost` で、どちらも secure context に入る。
 * **これはブラウザが無いと確かめられない項目**なので、4.15 の smoke と
 * 手動確認に送っている。
 */

/**
 * バイト列。`ArrayBuffer` 裏付けであることまで型で言う。
 *
 * admin の tsconfig は `lib: ["ES2023","DOM","DOM.Iterable"]` と
 * `types: ["node"]` を両方持つ（前者はブラウザのコード、後者はテストと
 * scripts/smoke.ts のため）。この 2 つの宣言が重なる場所で
 * **node の `TextEncoder#encode` は `Uint8Array<ArrayBufferLike>` を返すのに、
 * DOM の `crypto.subtle.digest` と `BodyInit` は `ArrayBuffer` 裏付けを要求する**
 * というずれが出る（`SharedArrayBuffer` 裏付けを排除できないため）。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * 文字列 -> UTF-8 バイト列。**エンコードはここ 1 箇所だけで行う。**
 *
 * `as` はこのずれを 1 箇所で吸収するためだけのもの。`TextEncoder` は必ず
 * 新しい（共有でない）`ArrayBuffer` を割り当てるので実体としては常に正しい。
 * 正しさは型ではなくテストが見ている（`utf8Bytes('🎉').length === 4` など）。
 */
export const utf8Bytes = (value: string): Bytes => new TextEncoder().encode(value) as Bytes;

const HEX = '0123456789abcdef';

/** SigV4 が定めている空ペイロードのハッシュ。GET など body の無い経路に付ける。 */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * バイト列の SHA-256 を小文字 16 進で返す。
 *
 * `Array.prototype.map` + `padStart` ではなく手で組んでいるのは、
 * 出力が必ず 64 文字の小文字 16 進になることを目で追えるようにするため。
 */
export const sha256Hex = async (bytes: Bytes): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) {
    hex += HEX[byte >> 4];
    hex += HEX[byte & 0x0f];
  }
  return hex;
};
