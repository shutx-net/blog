import type { ValidatedPost } from './validate.ts';

/**
 * YAML のダブルクォート文字列としてエスケープする。
 *
 * **改行のエスケープがこのモジュールで一番効いている 1 行。** これが無いと
 * title に "まとも\ndraft: true" を入れるだけで front matter にフィールドを
 * 注入できる（test/contract/frontmatter-schema.test.ts が固定している）。
 *
 * 常にダブルクォートで囲むので、'yes' / '123' / 'null' が真偽値や数値や null に
 * 解釈される YAML の罠も同時に閉じる。
 */
const yamlString = (value: string): string =>
  `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;

/**
 * postSchema に渡す形のオブジェクト。
 *
 * **slug と body は入れない。** front matter に載るのは site/src/content.config.ts の
 * postSchema が定義する 5 フィールドだけで、slug はファイル名、body は本文になる。
 */
export const toFrontMatterObject = (post: ValidatedPost): Record<string, unknown> => ({
  title: post.title,
  description: post.description,
  pubDate: post.pubDate,
  draft: post.draft,
  tags: post.tags,
});

/**
 * front matter ブロックを描画する。
 *
 * **YAML ライブラリを入れずに手書きしている。** 出すのは 5 フィールドだけで、
 * 文字列は必ずダブルクォートで囲み、tags はフロー形式で書く。契約テストが
 * astro と同じ js-yaml で読み直して往復を固定しているので、ライブラリを足す理由がない。
 */
export const renderFrontMatter = (post: ValidatedPost): string => {
  const tags = post.tags.map(yamlString).join(', ');
  return [
    '---',
    `title: ${yamlString(post.title)}`,
    `description: ${yamlString(post.description)}`,
    `pubDate: ${yamlString(post.pubDate)}`,
    `draft: ${post.draft ? 'true' : 'false'}`,
    `tags: [${tags}]`,
    '---',
  ].join('\n');
};

/** front matter + 空行 + 本文。GitHub にコミットする Markdown の完成品。 */
export const renderMarkdown = (post: ValidatedPost): string =>
  `${renderFrontMatter(post)}\n\n${post.body}`;
