import { SLUG_PATTERN, TAG_PATTERN, validatePost } from '@blog/api/src/posts/validate.ts';
import type { ValidatedPost } from '@blog/api/src/posts/validate.ts';

import { RELATIVE_IMAGE_WARNING, relativeImagePaths } from '../preview/images.ts';

/**
 * **規則を書き写さない。** api の実物をそのまま再 export する。
 *
 * `api/src/posts/validate.ts` は依存ゼロの純粋 TypeScript なので、ブラウザ向けの
 * バンドルにそのまま入る（実測: frontmatter.ts と合わせて 6 modules / 2.48 kB /
 * 警告 0）。**これは Lambda が実際に走らせるコードそのもの**なので、
 * 「admin の検証が api とずれる」という状態が原理的に作れない。
 *
 * site の `postSchema` はブラウザから触らない — `content.config.ts` は
 * `astro/loaders` 経由で node builtin を 22 件引き込み、**ビルドは成功するのに
 * 実行時に投げる proxy** が混ざる（実測）。突き合わせは
 * test/contract/post-schema.test.ts（node 環境）の仕事にしてある。
 */
export { SLUG_PATTERN, TAG_PATTERN };
export type { ValidatedPost };

/** フォームの生の値。すべて `<input>` / `<textarea>` からそのまま読んだ形。 */
export interface DraftFields {
  slug: string;
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
  slug: '',
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
 * **`pubDate` が空文字なら key ごと落とす。** api 側が「未指定なら now」を
 * 実装しているので、空文字を渡すと `Date.parse('')` が NaN になって
 * `PostValidationError('pubDate')` で落ちてしまう。
 *
 * @param nowMs 注入するクロック。`Date.now()` をここで読まない。
 * @throws {PostValidationError} api の実物の例外。`field` がそのまま UI に出る。
 */
export const validateDraft = (fields: DraftFields, nowMs: number): ValidatedPost =>
  validatePost(
    {
      slug: fields.slug,
      title: fields.title,
      description: fields.description,
      draft: fields.draft,
      tags: parseTags(fields.tags),
      body: fields.body,
      ...(fields.pubDate === '' ? {} : { pubDate: fields.pubDate }),
    },
    nowMs,
  );

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
