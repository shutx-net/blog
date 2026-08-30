import { randomBytes } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Logger, MediaPresigner, PresignInput, PresignResult } from '../deps.ts';

/**
 * メディアのキー接頭辞。
 *
 * **infra/lib/site-stack.ts の MEDIA_PATH_PATTERN（'/media/*'）から機械的に導出できる形。**
 * CloudFront のビヘイビア・S3 のキー空間・IAM のリソース ARN の 3 つが同じ接頭辞で
 * 揃っていないと動かない。test/unit/media-presign.test.ts が infra の定数と突き合わせている。
 */
export const MEDIA_KEY_PREFIX = 'media/';

/** 署名の有効期限。長くしても得が無く、漏れたときの窓が広がるだけ。 */
export const PRESIGN_EXPIRES_IN_SECONDS = 900;

/** 1 ファイルの上限。10 MiB。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 許可する content type。
 *
 * **text/html と image/svg+xml を入れないこと。** どちらもメディアバケットに置かれると
 * CloudFront 経由で実行可能なコンテンツになる（SVG は script を含められる）。
 */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/** 拡張子は **content type から導出する**。ユーザが送ったファイル名の拡張子は信用しない。 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export class MediaValidationError extends Error {
  readonly field: string;

  constructor(field: string, requirement: string) {
    super(`invalid media field '${field}': ${requirement}`);
    this.name = 'MediaValidationError';
    this.field = field;
  }
}

export interface MediaPresignerDeps {
  bucket: string;
  region: string;
  /** 省略すると Lambda の実行ロールの資格情報が使われる（本番はこちら）。 */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  logger: Logger;
  /** 注入するクロック（ミリ秒）。キーの年月に使う。 */
  now: () => number;
  expiresIn?: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const createMediaPresigner = (deps: MediaPresignerDeps): MediaPresigner => {
  // **requestChecksumCalculation: 'WHEN_REQUIRED' が必須。** 既定のままだと
  // x-amz-checksum-crc32=AAAAAA==（空ボディの CRC32）が署名済みクエリに焼き込まれ、
  // ブラウザが実ボディを PUT した瞬間にチェックサム不一致で失敗する。
  const client = new S3Client({
    region: deps.region,
    ...(deps.credentials === undefined ? {} : { credentials: deps.credentials }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  const expiresIn = deps.expiresIn ?? PRESIGN_EXPIRES_IN_SECONDS;

  const presign = async (input: PresignInput): Promise<PresignResult> => {
    const extension = EXTENSIONS[input.contentType];
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType) || extension === undefined) {
      throw new MediaValidationError('contentType', `must be one of ${[...ALLOWED_CONTENT_TYPES].join(', ')}`);
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
      throw new MediaValidationError('size', `must be an integer in 1..${MAX_UPLOAD_BYTES}`);
    }

    // **ユーザのファイル名をキーに一切使わない。** 拡張子は content type から導出し、
    // 本体はランダムにする。パストラバーサルも衝突も同時に閉じる。
    const at = new Date(deps.now());
    const key = `${MEDIA_KEY_PREFIX}${at.getUTCFullYear()}/${pad2(at.getUTCMonth() + 1)}/${randomBytes(12).toString('hex')}.${extension}`;

    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.size,
        // ServerSideEncryption は **渡さない**。渡すとブラウザ側で
        // x-amz-server-side-encryption を必ず付ける必要が出る。
        // バケットは既に SSE-S3 が既定なので、渡さなくても暗号化される。
      }),
      {
        expiresIn,
        // **これが無いと content type も content-length も署名に入らない。**
        // 実測で SignedHeaders は host だけになり、上限もタイプも実質無検証になる。
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );

    // **URL も署名もログに出さない。** 期限内なら誰でもそのキーに書き込める。
    // キーだけは運用上の追跡に要るので出してよい。
    deps.logger.info('issued media upload url', { key, contentType: input.contentType, size: input.size });

    return {
      url,
      key,
      expiresIn,
      // **署名済みヘッダを 1 つでも送り忘れると S3 は 403 を返す。**
      // 管理画面が推測せずに済むよう、何を送るべきかを API 側から明示する。
      requiredHeaders: {
        'content-type': input.contentType,
        'content-length': String(input.size),
      },
    };
  };

  return { presign };
};
