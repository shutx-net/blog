/**
 * 記事スラッグの許容形。
 *
 * **ドットを許さないのは infra/functions/rewrite-uri.js と結合しているため。**
 * CloudFront Function の URI 書き換えは「最後のスラッシュより後にドットがあれば
 * 静的ファイル」というヒューリスティックなので、/posts/node-24.19-notes には
 * /index.html が付かず S3 が 403 を返す。infra/README.md の「記事スラッグに
 * ドットを使わない」はこれまで人間の規律でしかなく、**この API が最初の機械的な
 * 防波堤になる**。片方だけ直さないこと。
 *
 * スラッシュも大文字も許さないので、パストラバーサルもここで同時に閉じる。
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * タグの許容形。**site/src/content.config.ts の regex と 1 文字も違わないこと。**
 *
 * タグはディレクトリ名になるので、空白や非 ASCII が入ると
 * dist/tags/Two Words/index.html のような到達不能な URL が出来る。
 */
export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** slug の上限。ファイル名として現実的な長さに収める。 */
const SLUG_MAX_LENGTH = 200;

export interface ValidatedPost {
  slug: string;
  title: string;
  description: string;
  /** ISO 8601。postSchema の z.coerce.date が受け取る。 */
  pubDate: string;
  draft: boolean;
  tags: string[];
  body: string;
}

/**
 * 入力が site のスキーマを満たさないときに投げる。
 *
 * **メッセージに入力値を含めない。** 400 応答やログに出る前提で書く
 * （本文に誤って貼られた資格情報が漏れる経路を作らない）。
 */
export class PostValidationError extends Error {
  readonly field: string;

  constructor(field: string, requirement: string) {
    super(`invalid post field '${field}': ${requirement}`);
    this.name = 'PostValidationError';
    this.field = field;
  }
}

const requireTrimmedString = (raw: Record<string, unknown>, field: string): string => {
  const value = raw[field];
  if (typeof value !== 'string') throw new PostValidationError(field, 'must be a string');
  const trimmed = value.trim();
  // Zod の min(1) は ' ' を通すが、それは site 側の穴であって api が広げる理由にはならない。
  // **api の検証は site と同等かより厳しい**という関係を保つ。
  if (trimmed.length === 0) throw new PostValidationError(field, 'must not be blank');
  return trimmed;
};

/**
 * 投稿リクエストのボディを検証して正規化する。
 *
 * @param nowMs 注入するクロック（ミリ秒）。pubDate 省略時の既定値に使う。
 */
export const validatePost = (raw: Record<string, unknown>, nowMs: number): ValidatedPost => {
  const slug = raw['slug'];
  if (typeof slug !== 'string' || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new PostValidationError('slug', 'must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (no dots)');
  }

  const title = requireTrimmedString(raw, 'title');
  const description = requireTrimmedString(raw, 'description');

  const body = raw['body'];
  if (typeof body !== 'string') throw new PostValidationError('body', 'must be a string');

  const rawDraft = raw['draft'];
  if (rawDraft !== undefined && typeof rawDraft !== 'boolean') {
    // '"false"' を true と解釈しない。曖昧な強制は下書きを誤って公開する。
    throw new PostValidationError('draft', 'must be a boolean');
  }
  const draft = rawDraft ?? false;

  const rawTags = raw['tags'];
  if (rawTags !== undefined && !Array.isArray(rawTags)) {
    throw new PostValidationError('tags', 'must be an array of strings');
  }
  const tags = (rawTags ?? []) as unknown[];
  for (const tag of tags) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
      throw new PostValidationError('tags', 'each tag must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/');
    }
  }

  const rawPubDate = raw['pubDate'];
  let pubDate: string;
  if (rawPubDate === undefined) {
    pubDate = new Date(nowMs).toISOString();
  } else {
    if (typeof rawPubDate !== 'string') throw new PostValidationError('pubDate', 'must be a string');
    const parsed = Date.parse(rawPubDate);
    if (Number.isNaN(parsed)) throw new PostValidationError('pubDate', 'must be a valid date');
    pubDate = new Date(parsed).toISOString();
  }

  return { slug, title, description, pubDate, draft, tags: tags as string[], body };
};
