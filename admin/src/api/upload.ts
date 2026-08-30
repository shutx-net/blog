import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
} from '@blog/api/src/media/limits.ts';

import type { ApiClient, ApiOperation } from './client.ts';

/**
 * 画像のアップロード。**S3 を直接叩く 2 本目にして最後の fetch。**
 *
 * 上限・許可 content type・キー接頭辞は `@blog/api/src/media/limits.ts` の
 * **実物を import している**。あのファイルは依存ゼロで（`presign.ts` が
 * `@aws-sdk/*` と `node:crypto` を読むのに対して）ブラウザ向けバンドルに
 * そのまま入るので、admin 側に定数のコピーは 1 つも無い。
 *
 * **メディアバケットにはまだ CORS 設定が無い。** presigned PUT は
 * `<bucket>.s3.ap-northeast-1.amazonaws.com` へ**別オリジン**に飛ぶので、
 * preflight が通らず実アップロードは infra の変更が入るまで動かない
 * （計画の hand-off 3）。**このファイルのテストが全部緑でもアップロードは
 * 動かない** — fetch を注入しているので CORS の欠落に影響されないため。
 */

/** api/src/router.ts の presign 経路。API_OPERATIONS と同じ形。 */
export const PRESIGN_OPERATION: ApiOperation = { method: 'POST', path: '/api/media/presign' };

/** 入力が受け付けられない。`field` はそのまま UI に出す。 */
export class UploadValidationError extends Error {
  readonly field: string;

  constructor(field: string, requirement: string) {
    super(`invalid upload field '${field}': ${requirement}`);
    this.name = 'UploadValidationError';
    this.field = field;
  }
}

/**
 * 署名済みの content-length と実バイト数が食い違っている。
 *
 * **ブラウザは `content-length` を送れない**（fetch の禁止ヘッダ名）ので、
 * ずれていると S3 が 403 を返す。送る前にここで落とす。
 */
export class UploadSizeMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`upload size mismatch: signed for ${expected} bytes but the file is ${actual}`);
    this.name = 'UploadSizeMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** api の presigner が返す形（api/src/deps.ts の `PresignResult`）。 */
export interface PresignResult {
  url: string;
  key: string;
  expiresIn: number;
  /** **1 つでも送り忘れると S3 が 403 を返す。** api 側が明示してくれる。 */
  requiredHeaders: Record<string, string>;
}

export interface PresignRequest {
  contentType: string;
  size: number;
  filename?: string;
}

/**
 * ファイル選択直後の検査。**presign を呼びに行く前に落とす。**
 *
 * @param size 省略すると `file.size`。テストが境界値を直接指定するための口。
 */
export const checkUploadable = (file: Blob, size: number = file.size): void => {
  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    throw new UploadValidationError(
      'contentType',
      `must be one of ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError('size', `must be an integer in 1..${MAX_UPLOAD_BYTES}`);
  }
};

/** presigned URL をもらう。**署名ヘッダは client.ts が付ける**（ここは知らない）。 */
export const presignMedia = async (
  client: ApiClient,
  request: PresignRequest,
): Promise<PresignResult> =>
  (await client.call(PRESIGN_OPERATION, {
    contentType: request.contentType,
    size: request.size,
    ...(request.filename === undefined ? {} : { filename: request.filename }),
  })) as PresignResult;

/**
 * S3 に直接 PUT する。成功したらキーを返す。
 *
 * **`x-amz-content-sha256` を付けない。** 署名はクエリ文字列側にあり、S3 は
 * presigned URL を UNSIGNED-PAYLOAD として扱うので、実ハッシュのヘッダを
 * 足すと食い違って 403 になる。**API 経路とは規則が逆**なのがこの関数の要点。
 *
 * **`content-length` を Headers に入れない。** fetch の禁止ヘッダ名なので
 * ブラウザは黙って捨てる（S3 は自分でボディ長を見る）。代わりに送信前に
 * バイト数を突き合わせる — Node の undici は禁止ヘッダを捨てないので
 * 「送られなかったこと」はテストできず、**テストできない規約は
 * テスト可能な形に置き換える**。
 */
export const uploadToPresignedUrl = async (
  presign: PresignResult,
  file: Blob,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> => {
  const contentType = presign.requiredHeaders['content-type'];
  if (contentType === undefined) {
    throw new UploadValidationError('contentType', 'presign result must require a content-type');
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    // api 側が壊れても、許可外の type をバケットに置きにいかない。
    throw new UploadValidationError('contentType', 'presign result requires a disallowed type');
  }

  const signedLength = presign.requiredHeaders['content-length'];
  if (signedLength === undefined) {
    throw new UploadValidationError('size', 'presign result must require a content-length');
  }
  if (Number(signedLength) !== file.size) {
    throw new UploadSizeMismatchError(Number(signedLength), file.size);
  }

  const response = await fetchImpl(presign.url, {
    method: 'PUT',
    // **content-type ちょうど 1 つ。** test/unit/media-upload.test.ts が
    // キー集合を固定している。
    headers: { 'content-type': contentType },
    body: file,
    // 別オリジン。presigned URL 自体が認可を持つので資格情報は送らない。
    mode: 'cors',
    credentials: 'omit',
  });

  if (!response.ok) {
    // **URL も署名もメッセージに載せない。** 期限内なら誰でも書き込める。
    throw new Error(`presigned upload failed with ${response.status}`);
  }

  return presign.key;
};

/**
 * 本文に挿入する Markdown。
 *
 * **先頭スラッシュ必須。** 無いと相対パスになり、プレビューが site と一致せず
 * （4.5）、本番のビルドも落ちる。
 */
export const mediaMarkdown = (key: string, alt: string): string => {
  const path = key.startsWith('/') ? key : `/${key}`;
  // alt の ] と改行は Markdown を壊す。
  const safeAlt = alt.replace(/\]/g, '\\]').replace(/[\r\n]+/g, ' ');
  return `![${safeAlt}](${path})`;
};
