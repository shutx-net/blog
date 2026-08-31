/**
 * 記事に書ける画像は 2 種類だけ。
 *
 * AGENTS.md「画像を Git に入れない」の帰結として、
 *   - presigned PUT で S3 に上げた `/media/...`（先頭スラッシュ必須）
 *   - 外部の絶対 URL
 * のどちらかになる。相対パスは astro の content layer が `assetImports` を
 * 解決しようとして **本番のビルドを落とす**。
 *
 * 相対パスはプレビューが site と一致しない唯一の構成でもある
 * （test/unit/preview-images.test.ts が固定している）。**プレビューが一致しない
 * 入力は、そもそも公開できない入力である** — 警告と検出を同じ場所に置いている。
 */

/** エディタが赤字で出す文言。 */
export const RELATIVE_IMAGE_WARNING =
  '相対パスの画像は site のビルドを落とす。`/media/...` を使うこと';

/**
 * 相対パスかどうか。**判定は astro の remarkCollectImages と同じ述語**
 * （`URL.canParse(url)` なら外部、`/` 始まりならサイト絶対、それ以外がローカル）。
 * 独自の規則を発明しない。
 */
const isRelative = (url: string): boolean => !URL.canParse(url) && !url.startsWith('/');

/** `<...>` で囲まれた宛先を剥がす。 */
const unwrap = (destination: string): string =>
  destination.startsWith('<') && destination.endsWith('>')
    ? destination.slice(1, -1)
    : destination;

/**
 * コード（フェンス・インライン）を空白に潰す。
 *
 * Markdown の書き方を本文で説明しているだけで送信が止まると困る。
 * 長さを保つ形で潰しているのは、出現順を壊さないため。
 */
const withoutCode = (markdown: string): string =>
  markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`+[^`\n]*`+/g, (span) => ' '.repeat(span.length));

/** `![alt](dest "title")` の宛先。 */
const INLINE_IMAGE = /!\[[^\]]*\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** `![alt][label]` と `![label]`（ショートカット参照）。 */
const REFERENCE_IMAGE = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;

/** `[label]: dest` の定義行。 */
const LINK_DEFINITION = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)/gm;

/**
 * 本文に含まれる相対パスの画像を出現順・重複なしで返す。
 *
 * **リンクは対象外。** 壊れるのは画像だけなので、`[a](./page.md)` を警告に
 * 混ぜると誤検出でエディタが使えなくなる。参照形式の画像は定義を解決してから
 * 判定するので、`![a][ref]` + `[ref]: /media/x.png` は検出しない。
 */
export const relativeImagePaths = (markdown: string): string[] => {
  const text = withoutCode(markdown);

  const definitions = new Map<string, string>();
  for (const match of text.matchAll(LINK_DEFINITION)) {
    const label = match[1]?.trim().toLowerCase();
    const destination = match[2];
    if (label !== undefined && destination !== undefined && !definitions.has(label)) {
      definitions.set(label, unwrap(destination));
    }
  }

  const found = new Set<string>();
  const inlineSpans: Array<[number, number]> = [];

  for (const match of text.matchAll(INLINE_IMAGE)) {
    inlineSpans.push([match.index, match.index + match[0].length]);
    const destination = match[1];
    if (destination === undefined) continue;
    const url = unwrap(destination);
    if (isRelative(url)) found.add(url);
  }

  for (const match of text.matchAll(REFERENCE_IMAGE)) {
    // インライン形式として既に読んだ範囲は飛ばす（`![a](./x.png)` の
    // 先頭部分が `![a]` としても一致してしまうため）。
    if (inlineSpans.some(([start]) => start === match.index)) continue;
    const label = (match[2] === undefined || match[2] === '' ? match[1] : match[2])
      ?.trim()
      .toLowerCase();
    if (label === undefined) continue;
    const url = definitions.get(label);
    if (url !== undefined && isRelative(url)) found.add(url);
  }

  return [...found];
};
