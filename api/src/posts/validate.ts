import { dateSlug, hasExplicitOffset } from './slug.ts';

/**
 * タグの許容形。**site/src/content.config.ts の regex と 1 文字も違わないこと。**
 *
 * タグはディレクトリ名になるので、空白や非 ASCII が入ると
 * dist/tags/Two Words/index.html のような到達不能な URL が出来る。
 */
export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ValidatedPost {
  /** **導出値。** 入力ではない。`dateSlug(pubDate)` の結果が入る。 */
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
 * 上書きの意思を読む。**記事の中身ではないので ValidatedPost には入れない。**
 *
 * **既定は必ず false。** 省略・null・文字列・数値のいずれも「上書きしない」に倒れる。
 * `draft` と同じく **'"false"' を true と解釈しない** — 曖昧な強制で公開済みの記事を
 * 踏み潰すのは、下書きを誤って公開するのと同じ種類の事故である。
 *
 * boolean 以外を黙って false に畳まず 400 にするのは、呼び出し側の綴り間違い
 * （`overwrite: 'true'`）が「拒否され続ける理由の分からない 409」に化けるのを防ぐため。
 */
export const validateOverwrite = (raw: Record<string, unknown>): boolean => {
  const value = raw['overwrite'];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new PostValidationError('overwrite', 'must be a boolean');
  return value;
};

/**
 * 投稿リクエストのボディを検証して正規化する。
 *
 * @param nowMs 注入するクロック（ミリ秒）。pubDate 省略時の既定値に使う。
 */
export const validatePost = (raw: Record<string, unknown>, nowMs: number): ValidatedPost => {
  // **送られてきたら拒否する。黙って捨てない。**
  //
  // 捨てると「この slug で公開されるつもりだった」という呼び出し側の思い違いが無言で
  // 通り、意図しない URL に記事が出る。`validateOverwrite` が `overwrite: 'true'` を
  // 400 にしているのと同じ立場で、曖昧な入力を勝手に解釈しない。
  //
  // `undefined` だけは通す。JSON に現れない形なので「送っていない」と区別できない。
  if (raw['slug'] !== undefined) {
    throw new PostValidationError('slug', 'is derived from pubDate and must not be supplied');
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
    // **オフセットの無い日時を黙って推測しない。**
    //
    // `Date.parse('2026-09-08T05:40:01')` はホストの TZ で解釈するので、同じ入力から
    // ブラウザ（著者の TZ）と Lambda（UTC）で違う瞬間ができ、**公開先の URL が著者の
    // 居場所で変わる**（RSS の guid も変わる。取り消せない）。
    //
    // 著者の壁時計時刻を JST として送るのは呼び出し側の責任にする
    // （`admin` は `jstWallClockToInstant` を通す）。`slug` を 400 にしたのと同じ立場。
    if (!hasExplicitOffset(rawPubDate)) {
      throw new PostValidationError('pubDate', 'must carry an explicit UTC offset (Z or +09:00)');
    }
    const parsed = Date.parse(rawPubDate);
    if (Number.isNaN(parsed)) throw new PostValidationError('pubDate', 'must be a valid date');
    pubDate = new Date(parsed).toISOString();
  }

  // **導出は pubDate が確定したあと。** 先に作ろうとすると dateSlug が素の Error を
  // 投げ、PostValidationError にならないので 400 ではなく 500 になる。
  const slug = dateSlug(pubDate);

  return { slug, title, description, pubDate, draft, tags: tags as string[], body };
};

/** 更新の対象を識別するのに要る、既存記事の一部。 */
export interface ExistingPost {
  /** 読んだときのパスから復元したスラッグ。**書き戻す先はこれ。** */
  slug: string;
  /** front matter に書かれている値そのまま。**表記まで含めて比較する。** */
  pubDate: string;
}

export interface ValidatedUpdate {
  post: ValidatedPost;
  /** 呼び出し側が読んだときの blob sha。 */
  sha: string;
}

/**
 * 更新リクエストのボディを検証する。**規則は `validatePost` を再利用する。**
 *
 * 追加で見るのは 3 つ。
 *
 * # `pubDate` は変えられない
 *
 * 利用者の決定により、スラッグは作成時に固定される — **URL と RSS の `<guid>` を
 * 不変に保つため**（guid が変わると購読者に全記事が再配信され、取り消せない）。
 * スラッグは pubDate から導出されるので、pubDate の不変が URL の不変そのものになる。
 *
 * **表記まで含めて一致を要求する。** 「同じ瞬間なら通す」にすると、ms を落とした
 * 表記で往復するたびに front matter が書き換わる。黙って既存値で上書きするのも
 * 採らない — 呼び出し側の思い違いを無言で通さないという `slug` と同じ立場。
 *
 * **副作用**: front matter の `pubDate` が `2026-08-03` のような日付のみの記事は、
 * そのまま送ると `validatePost` のオフセット必須検査で 400 になる。管理画面からは
 * 編集できず、`blog-content` 側で完全な ISO に直す必要がある。
 * 黙って正規化すると「pubDate は変えない」という約束を破ることになるので、落とす側に倒す。
 *
 * # `sha` は省略できない
 *
 * 省略を許すと**楽観的並行制御を外して呼べる経路**ができる。
 *
 * # `overwrite` は送れない
 *
 * 更新は常に差し替えなので意味を持たない。黙って捨てると呼び出し側の思い違いが
 * 無言で通る（`slug` を 400 にしているのと同じ立場）。
 *
 * @param nowMs `validatePost` に渡すクロック。**更新では使われない**
 *   （pubDate の省略は下で 400 になるため）が、規則を共有するために通す。
 */
export const validateUpdate = (
  raw: Record<string, unknown>,
  existing: ExistingPost,
  nowMs: number,
): ValidatedUpdate => {
  if (raw['overwrite'] !== undefined) {
    throw new PostValidationError('overwrite', 'is meaningless on update and must not be supplied');
  }

  // **pubDate の検査を validatePost より前に置く。** 後に置くと、日付のみの pubDate を
  // 持つ記事で「オフセットが無い」という遠い理由の 400 が先に出る。
  if (raw['pubDate'] !== existing.pubDate) {
    throw new PostValidationError('pubDate', 'must not change; the slug and the RSS guid depend on it');
  }

  const sha = requireTrimmedString(raw, 'sha');
  const post = validatePost(raw, nowMs);

  return { post, sha };
};
