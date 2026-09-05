import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@astrojs/markdown-remark';
import { describe, expect, it } from 'vitest';

import { postSchema } from '@blog/site/src/content.config.ts';
import { postsDirUrl } from '@blog/site/src/posts-dir.ts';
import { renderPreview } from '../../src/preview/pipeline.ts';

// **site の glob base と同じ関数で解決する。** ここが site のビルドと違う
// ディレクトリを指すと、dist と突き合わせても別の集合を比べることになり、
// 一致テストが「何も証明していないのに緑」になる。
const SITE_ROOT = new URL('../../../site/', import.meta.url);
const POSTS_DIR = fileURLToPath(postsDirUrl(process.env, SITE_ROOT));
const DIST_DIR = fileURLToPath(new URL('dist/', SITE_ROOT));

interface Post {
  slug: string;
  title: string;
  tags: string[];
  draft: boolean;
  body: string;
}

const posts: Post[] = readdirSync(POSTS_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => {
    const raw = readFileSync(POSTS_DIR + name, 'utf8');
    const { frontmatter, content } = parseFrontmatter(raw);
    // **site の実 postSchema で読む。** 型も既定値（draft: false, tags: []）も
    // 実物から取る。admin 側で「たぶんこう」を書かない。
    const data = postSchema.parse(frontmatter);
    return {
      slug: name.replace(/\.md$/, ''),
      title: data.title,
      tags: data.tags,
      draft: data.draft,
      body: content,
    };
  });

const published = posts.filter((post) => !post.draft);

/**
 * astro が `{post.data.title}` を書き出すときのエスケープ。
 *
 * 実測でどのフィクスチャにも該当文字は無いが、**タイトルに `&` や `<` が
 * 入った記事が増えたときに黙って落ちる**のを避けるために実装しておく。
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 先頭から `prefix` を剥がす。**一致しなければ失敗する。**
 *
 * 一致しないときに黙って元の文字列を返す実装にしないこと（CONTEXT 罠 3 と同型の
 * 事故 — 剥がせていないのに比較が通ってしまう形になる）。
 */
const stripPrefix = (text: string, prefix: string, what: string): string => {
  expect(text.startsWith(prefix), `${what} が先頭に一致しない`).toBe(true);
  return text.slice(prefix.length);
};

/** 末尾から `suffix` を剥がす。**一致しなければ失敗する。** */
const stripSuffix = (text: string, suffix: string, what: string): string => {
  expect(text.endsWith(suffix), `${what} が末尾に一致しない`).toBe(true);
  return text.slice(0, text.length - suffix.length);
};

/** `<article>` の中身。開始・終了タグが 1 つずつ無ければ失敗する。 */
const articleInnerHtml = (html: string): string => {
  const open = html.indexOf('<article>');
  const close = html.lastIndexOf('</article>');
  expect(open, '<article> が見つからない').toBeGreaterThan(-1);
  expect(close, '</article> が見つからない').toBeGreaterThan(open);
  return html.slice(open + '<article>'.length, close);
};

/** site/src/pages/posts/[...slug].astro が出すタグ一覧の HTML。 */
const tagListHtml = (tags: string[]): string =>
  `<ul>${tags.map((tag) => `<li><a href="/tags/${tag}/">${tag}</a></li>`).join('')}</ul>`;

/**
 * プレビュー一致の証明 (a)。**正規化なしのバイト一致。**
 *
 * 空白潰しも部分一致も使わない。実測で astro の `compressHTML`（既定 true）は
 * レンダリング済み Markdown の内部空白を触らず、`renderPreview` の出力と
 * 1 バイト違わない。
 *
 * **この比較だけでは `syntaxHighlight` のドリフトを検出できない**（公開記事に
 * コードフェンスが 1 つも無いため。実測）。その穴は parity/corpus.test.ts が塞ぐ。
 */
describe('公開済み HTML と renderPreview のバイト一致', () => {
  it('記事のフィクスチャが 1 件以上ある', () => {
    expect(posts.length).toBeGreaterThan(0);
  });

  it('公開記事が 1 件以上ある（下書きだけになっていない）', () => {
    expect(published.length).toBeGreaterThan(0);
  });

  it('下書きが 1 件以上あり、dist に存在しない', () => {
    const drafts = posts.filter((post) => post.draft);
    expect(drafts.length, '下書きのフィクスチャが必要').toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(
        existsSync(`${DIST_DIR}posts/${draft.slug}/index.html`),
        `下書き ${draft.slug} が dist に出ている`,
      ).toBe(false);
    }
  });

  // **corpus → dist だけでなく dist → corpus も見る。**
  //
  // 下の $slug テストは「corpus の各記事が dist にある」ことしか言わないので、
  // dist が別のディレクトリからビルドされていて余分な記事を含んでいても緑になる。
  // 集合の一致にすれば、読む側とビルド側が同じ corpus を見ていることが片方向に
  // 崩れた時点で落ちる。
  //
  // 現時点ではこの主張は mutation では動かせない — フィクスチャは実記事の
  // バイト一致コピーで、両者の差は draft の test.md だけ、つまり dist に出る
  // 集合が同一だから。**記事が blog-content へ移って src/content/posts/ が空に
  // なった時点で、これが POSTS_DIR の配線ミスを捕まえる唯一の主張になる。**
  it('dist の記事ページ集合が corpus の公開記事集合と一致する', () => {
    const postsRoot = `${DIST_DIR}posts/`;
    const inDist = existsSync(postsRoot)
      ? readdirSync(postsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];

    expect(inDist).toEqual(published.map((post) => post.slug).sort());
  });

  it('site/dist が存在する', () => {
    expect(
      existsSync(DIST_DIR),
      'site/dist が無い。`npm run -w admin test` の pretest が site をビルドする' +
        '（`npm run build -w ../site`）。個別に走らせるときは先に site をビルドすること',
    ).toBe(true);
  });

  it.each(published)(
    '$slug の <article> が <h1> とタグ一覧を除いて renderPreview と一致する',
    async (post) => {
      const path = `${DIST_DIR}posts/${post.slug}/index.html`;
      expect(existsSync(path), `${path} が無い`).toBe(true);

      let inner = articleInnerHtml(readFileSync(path, 'utf8'));

      // 前から <h1>タイトル</h1> を剥がす。
      inner = stripPrefix(inner, `<h1>${escapeHtml(post.title)}</h1>`, '<h1> のタイトル');

      // 後ろからタグ一覧を剥がす。**タグがあるのに末尾一致しなければ失敗する。**
      if (post.tags.length > 0) {
        inner = stripSuffix(inner, tagListHtml(post.tags), 'タグ一覧の <ul>');
      }

      expect(inner).toBe(await renderPreview(post.body));
    },
  );
});

describe('剥がし処理そのものが検出できる', () => {
  // 剥がし関数が「一致しなくても黙って通る」形になっていないことを、
  // 走査関数と同じ発想でフィクスチャ的に確かめる（CONTEXT 罠 3）。
  it('stripPrefix は先頭が一致しなければ失敗する', () => {
    expect(() => stripPrefix('abcdef', 'xyz', 'テスト')).toThrow();
  });

  it('stripSuffix は末尾が一致しなければ失敗する', () => {
    expect(() => stripSuffix('abcdef', 'xyz', 'テスト')).toThrow();
  });

  it('articleInnerHtml は <article> が無ければ失敗する', () => {
    expect(() => articleInnerHtml('<main>no article here</main>')).toThrow();
  });

  it('一致するときは正しく剥がれる', () => {
    expect(stripPrefix('<h1>T</h1>rest', '<h1>T</h1>', 'テスト')).toBe('rest');
    expect(stripSuffix('rest<ul></ul>', '<ul></ul>', 'テスト')).toBe('rest');
    expect(articleInnerHtml('<x><article>inner</article></x>')).toBe('inner');
  });

  it('tagListHtml が site のテンプレートと同じ形を出す', () => {
    expect(tagListHtml(['astro', 'nix'])).toBe(
      '<ul><li><a href="/tags/astro/">astro</a></li><li><a href="/tags/nix/">nix</a></li></ul>',
    );
  });
});
