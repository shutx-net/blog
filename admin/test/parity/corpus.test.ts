import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderPreview } from '../../src/preview/pipeline.ts';
import { renderWithSiteProcessor } from '../support/site-renderer.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

const corpus = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name, markdown: readFileSync(FIXTURE_DIR + name, 'utf8') }));

/**
 * プレビュー一致の証明 (b)。
 *
 * 期待値は **site の processor から毎回作る**（`test/support/site-renderer.ts`）。
 * スナップショットで固定しない — スナップショットは「admin の出力を焼き付けたもの」に
 * なりうるので、admin 側がずれたときに一緒にずれる。
 *
 * **このコーパスは 4.4（site/dist との突き合わせ）が塞げない穴のためにある。**
 * 公開済み記事にコードフェンスが 1 つも無いため、`syntaxHighlight` を `false` に
 * しても dist 比較は全件緑のまま通る（実測）。コードフェンスと `astro-code` の
 * アサーションを消さないこと。
 */
describe('固定コーパスが site の processor と一致する', () => {
  it('コーパスが空でない', () => {
    // it.each は空配列でも緑になる。先に非空を主張する。
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('コーパスに 3 本のフィクスチャが揃っている', () => {
    expect(corpus.map((entry) => entry.name)).toEqual([
      'code-fences.md',
      'images.md',
      'kitchen-sink.md',
    ]);
  });

  it.each(corpus)('$name が site の processor の出力とバイト一致する', async ({ markdown }) => {
    const [actual, expected] = await Promise.all([
      renderPreview(markdown),
      renderWithSiteProcessor(markdown),
    ]);
    // 正規化・空白潰し・部分一致は使わない。**文字列として完全一致**。
    expect(actual).toBe(expected);
  });

  it.each(corpus)('$name の出力が空でない（空同士の一致で緑にならない）', async ({ markdown }) => {
    const html = await renderPreview(markdown);
    expect(html.length).toBeGreaterThan(200);
  });
});

describe('コーパスが必要な構成をすべて含む', () => {
  const all = corpus.map((entry) => entry.markdown).join('\n');

  it.each([
    ['見出し', /^##\s/m],
    ['GFM 打ち消し', /~~[^~]+~~/],
    ['スマートクォート対象の引用符', /"[^"]+"/],
    ['ts のコードフェンス', /```ts\n/],
    ['言語なしのコードフェンス', /```\n/],
    ['未知言語のコードフェンス', /```notalanguage\n/],
    ['表', /^\|.*\|$/m],
    ['タスクリスト', /^- \[[ x]\]/m],
    ['脚注', /\[\^[^\]]+\]/],
    ['生 HTML', /<div class="raw-html-block">/],
    ['autolink', /https:\/\/example\.com\/autolink/],
    ['/media/ の画像', /!\[[^\]]*\]\(\/media\//],
    ['https:// の画像', /!\[[^\]]*\]\(https:\/\//],
  ])('%s を含む', (_label, pattern) => {
    expect(all).toMatch(pattern);
  });
});

describe('shiki が実際に走っている', () => {
  it('**出力に astro-code クラスが現れる**', async () => {
    // `SHARED_RENDER_OPTIONS.syntaxHighlight` を false にすると、site 側の
    // 期待値には astro-code が残り admin 側から消えるので上の一致テストが赤くなる。
    // このアサーションはその一段手前で「そもそも shiki が動いているか」を見る。
    //
    // **`toContain('astro-code')` では不十分だった（実測）。** フィクスチャ本文に
    // その文字列が書いてあると、コードブロックのテキストとしてそのまま出力に現れ、
    // shiki が動いていなくても通ってしまう。**クラス属性の形で見る。**
    const fence = corpus.find((entry) => entry.name === 'code-fences.md');
    expect(fence, 'code-fences.md がコーパスに必要').toBeDefined();
    const html = await renderPreview(fence?.markdown ?? '');
    expect(html).toContain('class="astro-code');
  });

  it('ts のコードフェンスが色付きの span に分解されている', () => {
    // astro-code というクラス名だけなら shiki が「動かずにクラスだけ付けた」
    // 場合も通ってしまう。実際にトークン分割されていることまで見る。
    const fence = corpus.find((entry) => entry.name === 'code-fences.md');
    return renderPreview(fence?.markdown ?? '').then((html) => {
      expect(html).toMatch(/<span style="color:[^"]+">/);
    });
  });
});

describe('本文の trim が astro の glob ローダと同じである', () => {
  it('前後の空行があってもなくても同じ出力になる', async () => {
    // astro は `body: parsed.content.trim()` で渡す
    // （astro/dist/vite-plugin-markdown/content-entry-type.js）。
    // trim を忘れると先頭・末尾の空行で出力がずれる。
    const body = '## Heading\n\nA paragraph.';
    const padded = `\n\n\n${body}\n\n\n`;
    expect(await renderPreview(padded)).toBe(await renderPreview(body));
  });
});
