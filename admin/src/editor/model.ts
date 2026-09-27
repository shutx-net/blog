import { DATE_SLUG_PATTERN, dateSlug, jstWallClockToInstant } from '@blog/api/src/posts/slug.ts';
import { SLUG_PATTERN, TAG_PATTERN, validatePost } from '@blog/api/src/posts/validate.ts';
import type { ValidatedPost } from '@blog/api/src/posts/validate.ts';

import { RELATIVE_IMAGE_WARNING, relativeImagePaths } from '../preview/images.ts';

/**
 * **規則を書き写さない。** api の実物をそのまま再 export する。
 *
 * `api/src/posts/validate.ts` は依存ゼロの純粋 TypeScript なのでブラウザ向けのバンドルに
 * そのまま入る（実測: frontmatter.ts と合わせて 6 modules / 2.48 kB / 警告 0）。
 * **これは Lambda が実際に走らせるコードそのもの**なので、「admin の検証が api とずれる」
 * という状態が原理的に作れない。
 *
 * site の `postSchema` はブラウザから触らない — `content.config.ts` は `astro/loaders` 経由で
 * node builtin を 22 件引き込み、**ビルドは成功するのに実行時に投げる proxy** が混ざる
 * （実測）。突き合わせは test/contract/post-schema.test.ts（node 環境）の仕事。
 */
export { DATE_SLUG_PATTERN, SLUG_PATTERN, TAG_PATTERN, dateSlug, jstWallClockToInstant };
export type { ValidatedPost };

/**
 * フォームの生の値。すべて `<input>` / `<textarea>` からそのまま読んだ形。
 *
 * **slug は無い。** 公開先は `pubDate` から導出される（`publishPathLabel`）。
 * 手入力だった頃は、前回の下書きから復元された slug が残ったまま別の記事を投稿し、
 * **公開済みの記事を黙って置き換える**事故が起きた（2026-09-07）。
 */
export interface DraftFields {
  title: string;
  description: string;
  /** `<input type="datetime-local">` の文字列。空文字は「未指定」。 */
  pubDate: string;
  /** カンマ区切り 1 本。 */
  tags: string;
  draft: boolean;
  body: string;
}

/**
 * 初期状態。
 *
 * **`draft: true` で始める。** 既定が公開だと、書きかけを誤って世に出せてしまう。
 * 「公開する」は明示的な操作であるべき。
 */
export const emptyDraft = (): DraftFields => ({
  title: '',
  description: '',
  pubDate: '',
  tags: '',
  draft: true,
  body: '',
});

/** カンマ区切りをタグ配列に。空要素と重複を落とし、前後の空白を削る。 */
export const parseTags = (raw: string): string[] => [
  ...new Set(
    raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  ),
];

/**
 * フォームの値を api の `validatePost` が受ける形に組み立てて投げる。
 *
 * **`pubDate` が空文字なら key ごと落とす。** api 側が「未指定なら now」を実装しているので、
 * 空文字を渡すと `Date.parse('')` が NaN になって `PostValidationError('pubDate')` で落ちる。
 *
 * **`pubDate` は JST の瞬間に変換して渡す。** `<input type="datetime-local">` が返すのは
 * オフセットの無い壁時計時刻で、そのまま渡すと解釈が**ホストの TZ 依存**になる（api 側は
 * 今それを 400 で拒む）。著者が入力した時刻は JST の壁時計時刻を意味する、という利用者の
 * 決定に従って `+09:00` を付ける。
 *
 * @param nowMs 注入するクロック。`Date.now()` をここで読まない。
 * @throws {PostValidationError} api の実物の例外。`field` がそのまま UI に出る。
 */
export const validateDraft = (fields: DraftFields, nowMs: number): ValidatedPost =>
  validatePost(
    {
      title: fields.title,
      description: fields.description,
      draft: fields.draft,
      tags: parseTags(fields.tags),
      body: fields.body,
      ...(fields.pubDate === '' ? {} : { pubDate: jstWallClockToInstant(fields.pubDate) }),
    },
    nowMs,
  );

/**
 * `POST /api/posts` に送るボディ。
 *
 * **`slug` を落とす。** `ValidatedPost` には導出された slug が入っているが、
 * api は **slug が付いていたら 400 にする**（送ってきた側の思い違いを無言で通さないため）。
 * `validateDraft` の結果をそのまま投げると、admin 自身がその 400 を踏む。
 *
 * 落とすのを型でも縛っているので、api 側が slug を要求する形に戻ったら
 * ここが型エラーになる。
 */
export const postRequestBody = (post: ValidatedPost): Omit<ValidatedPost, 'slug'> => {
  const { slug: _slug, ...rest } = post;
  return rest;
};

/**
 * 公開先の URL を表す文。**送信前に「どこに出るか」を見せるためにある。**
 *
 * slug が手入力だった頃は入力欄そのものが答えだった。導出になった今は、
 * 見せなければ利用者は公開先を知らずに送信することになる。
 *
 * @param nowMs 注入するクロック。**`Date.now()` をここで読まない。**
 */
export const publishPathLabel = (fields: DraftFields, nowMs: number): string => {
  // **送信するのと同じ変換を通す。** 別経路にすると、画面の表示と実際の公開先が
  // 静かに食い違う（それが CI で見つかった TZ のバグそのものだった）。
  const iso =
    fields.pubDate === '' ? new Date(nowMs).toISOString() : jstWallClockToInstant(fields.pubDate);
  let slug: string;
  try {
    slug = dateSlug(iso);
  } catch {
    // pubDate が読めないときは決まらない。**適当な既定でごまかさない。**
    // 同じ入力に対して draftProblems が pubDate の指摘を出しているので、
    // ここは「今は分からない」とだけ言えばよい。
    return '公開先: pubDate が読めないので決まらない';
  }
  const path = `/posts/${slug}/`;

  // **未入力は「まだ確定していない」ことを明示する。** 送信の瞬間の時刻になるので、
  // 画面に出ている値のまま公開されるとは限らない。
  return fields.pubDate === '' ? `公開先: ${path}（送信時刻で確定する）` : `公開先: ${path}`;
};

/** UI に出す 1 件の指摘。`field` はフォームの入力欄の id と一致する。 */
export interface DraftProblem {
  field: string;
  message: string;
}

/**
 * 送信前に出す指摘をすべて集める。
 *
 * 検証エラー（api 由来）と、相対パス画像の警告（プレビューが一致しない唯一の
 * 構成であり、本番のビルドを落とす書き方）の 2 種類。
 */
export const draftProblems = (fields: DraftFields, nowMs: number): DraftProblem[] => {
  const problems: DraftProblem[] = [];

  try {
    validateDraft(fields, nowMs);
  } catch (error) {
    const field = (error as { field?: unknown }).field;
    problems.push({
      field: typeof field === 'string' ? field : 'body',
      message: (error as Error).message,
    });
  }

  const relative = relativeImagePaths(fields.body);
  if (relative.length > 0) {
    problems.push({ field: 'body', message: `${RELATIVE_IMAGE_WARNING}（${relative.join(', ')}）` });
  }

  return problems;
};
