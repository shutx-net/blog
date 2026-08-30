/**
 * メディアアップロードのポリシー定数。
 *
 * **依存ゼロにしてあるのは、ブラウザ（admin/）から import させるため。**
 * presign.ts は @aws-sdk/client-s3 と node:crypto を読むのでブラウザに載せられない。
 * 定数を同居させると admin 側が値を複製することになり、複製はいずれずれる。
 * validate.ts / frontmatter.ts が既に同じ形になっている。
 *
 * **このファイルに import を足さないこと。** 足した瞬間にブラウザから読めなくなる
 * 可能性が生まれる。test/unit/media-limits.test.ts が import 文ゼロを固定している。
 */
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
export const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
