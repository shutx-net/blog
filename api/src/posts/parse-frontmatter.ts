/**
 * Markdown から front matter を読む。`frontmatter.ts` の `renderMarkdown` の逆。
 *
 * **YAML ライブラリを足していない。** 読む対象は 5 フィールドだけで、`renderFrontMatter`
 * が出す形（すべてダブルクォート文字列、tags はフロー形式）が正規形である。
 * 往復は `test/unit/parse-frontmatter.test.ts` が固定しており、YAML のメタ文字コーパスは
 * `test/contract/frontmatter-schema.test.ts`（js-yaml で読み直す側）と同じものを使っている。
 *
 * **正規形だけを受け付ける実装にはしない。** blog-content の README が「直接コミットして
 * もよい」と言っており、`site/test/fixtures/posts/` の実物も `pubDate: 2026-08-03` と
 * 引用していない。正規形しか読めない parser は、手で書いた記事が一覧に出た日に落ちる。
 *
 * ここが受け付けないもの（すべて throw する。黙って既定値に倒さない）:
 * ブロックスカラー（`|` `>`）、複数行の値、アンカー・エイリアス、入れ子のマップ。
 * front matter が壊れているのは「記事が無い」ではないので fail closed にする。
 */

/**
 * front matter が読めなかったときに投げる。
 *
 * **メッセージに入力値を含めない**（`PostValidationError` と同じ規律）。
 * 一覧の 1 本が壊れているだけで管理画面が何も出せなくなるのを避けるため、
 * 呼び出し側がどのフィールドが悪いかを判断できるように `field` を持たせる。
 */
export class FrontMatterParseError extends Error {
  readonly field: string;

  constructor(field: string, requirement: string) {
    super(`front matter field '${field}' ${requirement}`);
    this.name = 'FrontMatterParseError';
    this.field = field;
  }
}

/** `renderMarkdown` に渡す `ValidatedPost` から slug を除いた形。 */
export interface ParsedPost {
  title: string;
  description: string;
  pubDate: string;
  draft: boolean;
  tags: string[];
  body: string;
}

/** `yamlString` のエスケープの逆写像。 */
const UNESCAPE: Readonly<Record<string, string>> = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * ダブルクォート文字列の形。
 *
 * **中身は「引用符でない文字」か「バックスラッシュ + 任意の 1 文字」の繰り返し**に限る。
 * これで閉じ引用符の位置が一意に決まるので、`\"` を終端と読み違えない。
 */
const QUOTED = /^"((?:[^"\\]|\\.)*)"$/;

const decodeQuoted = (inner: string): string =>
  inner.replace(/\\(.)/g, (whole, ch: string) => UNESCAPE[ch] ?? whole);

/**
 * フロー形式の要素を切り出す。引用符の中のカンマで切らない。
 *
 * `TAG_PATTERN` はカンマを許さないので正規形では問題にならないが、手で書いた
 * `tags: ["a,b"]` を 2 要素に割るのは**読み違えを黙って通す**ことになる。
 */
const splitFlowItems = (inner: string): string[] => {
  const items: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inQuotes && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuotes) throw new FrontMatterParseError('tags', 'has an unterminated quoted item');
  items.push(current);

  // `[]` は「要素 0 個」。空文字 1 個の配列にしない。
  return items.map((item) => item.trim()).filter((item, index) => !(index === 0 && item === '' && items.length === 1));
};

/** 引用されていればほどき、されていなければそのまま返す。 */
const scalar = (raw: string, field: string): string => {
  if (!raw.startsWith('"')) {
    // 引用の無い値。ブロックスカラーと複数行は受け付けない（黙って空にしない）。
    if (raw === '|' || raw === '>' || raw.startsWith('|') || raw.startsWith('>')) {
      throw new FrontMatterParseError(field, 'uses a block scalar, which is not supported');
    }
    return raw;
  }
  const match = QUOTED.exec(raw);
  if (match === null || match[1] === undefined) {
    throw new FrontMatterParseError(field, 'is not a well-formed double-quoted string');
  }
  return decodeQuoted(match[1]);
};

const requireField = (fields: Map<string, string>, field: string): string => {
  const raw = fields.get(field);
  if (raw === undefined) throw new FrontMatterParseError(field, 'is missing');
  const value = scalar(raw, field).trim();
  // site の postSchema が min(1) を掛けている 3 フィールドと同じ厳しさにする。
  if (value.length === 0) throw new FrontMatterParseError(field, 'must not be blank');
  return value;
};

const parseDraft = (fields: Map<string, string>): boolean => {
  const raw = fields.get('draft');
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // **'"true"' を true と読まない。** 曖昧な強制で下書きを公開するのは、
  // この API が一貫して拒んできた種類の事故（validate.ts の draft と同じ立場）。
  throw new FrontMatterParseError('draft', 'must be the bare literal true or false');
};

const parseTags = (fields: Map<string, string>): string[] => {
  const raw = fields.get('tags');
  if (raw === undefined) return [];
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    throw new FrontMatterParseError('tags', 'must be a flow sequence like [a, b]');
  }
  return splitFlowItems(raw.slice(1, -1)).map((item) => scalar(item, 'tags'));
};

/** `---` で囲まれたブロックと、その後ろの本文に分ける。 */
const splitBlock = (raw: string): { block: string; body: string } => {
  if (!raw.startsWith('---\n')) {
    throw new FrontMatterParseError('frontMatter', "must start with '---'");
  }
  const end = raw.indexOf('\n---\n', 3);
  if (end < 0) {
    // 末尾が閉じ `---` で本文が無い形も受ける（改行が 1 つ足りないだけ）。
    if (raw.endsWith('\n---')) return { block: raw.slice(4, raw.length - 3), body: '' };
    throw new FrontMatterParseError('frontMatter', 'has no closing delimiter');
  }
  const rest = raw.slice(end + '\n---\n'.length);
  return {
    block: raw.slice(4, end + 1),
    // `renderMarkdown` は front matter の後に空行を 1 行挟む。**その 1 つだけを外す。**
    // 本文自体が空行で始まる場合（`\n先頭が空行`）も、外すのが 1 つなら往復する。
    body: rest.startsWith('\n') ? rest.slice(1) : rest,
  };
};

export const parseMarkdown = (raw: string): ParsedPost => {
  const { block, body } = splitBlock(raw);

  const fields = new Map<string, string>();
  for (const line of block.split('\n')) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    // インデントされた行は入れ子のマップかブロックスカラーの続き。受け付けない。
    if (separator <= 0 || /^\s/.test(line)) {
      throw new FrontMatterParseError('frontMatter', 'has a line that is not a top-level key');
    }
    // **後から来たキーで上書きしない。** 重複キーは YAML では後勝ちだが、
    // ここで後勝ちにすると `title` を 2 回書いた入力を黙って受けることになる。
    const key = line.slice(0, separator).trim();
    if (!fields.has(key)) fields.set(key, line.slice(separator + 1).trim());
  }

  return {
    title: requireField(fields, 'title'),
    description: requireField(fields, 'description'),
    pubDate: requireField(fields, 'pubDate'),
    draft: parseDraft(fields),
    tags: parseTags(fields),
    body,
  };
};
