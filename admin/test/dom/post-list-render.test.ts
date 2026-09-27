import { describe, expect, it } from 'vitest';

import { EMPTY_POST_LIST_MESSAGE, renderPostList } from '../../src/editor/post-list.ts';
import type { PostListEntry } from '../../src/editor/post-list.ts';

const entry = (over: Partial<PostListEntry> = {}): PostListEntry => ({
  slug: '2026/09/27/142621',
  title: 'A title',
  draft: false,
  pubDate: '2026-09-27T05:26:21.486Z',
  ...over,
});

const list = (): HTMLElement => {
  const ul = document.createElement('ul');
  document.body.replaceChildren(ul);
  return ul;
};

const slugs = (root: ParentNode): string[] =>
  [...root.querySelectorAll('li')].map((li) => li.dataset['slug'] ?? '');

describe('一覧の描画', () => {
  it('**title をマークアップとして解釈しない**（innerHTML を使っていない証明）', () => {
    const ul = list();
    renderPostList(ul, [entry({ title: '<img src=x onerror="alert(1)"><b>bold</b>' })]);

    // 文字列比較ではなく **DOM に要素が生えていないこと**で見る。
    // innerHTML に書き換えると img と b が生えるので、ここが落ちる。
    expect(ul.querySelectorAll('img')).toHaveLength(0);
    expect(ul.querySelectorAll('b')).toHaveLength(0);
    expect(ul.textContent).toContain('<img src=x onerror="alert(1)"><b>bold</b>');
  });

  it('pubDate の降順に並ぶ', () => {
    const ul = list();
    renderPostList(ul, [
      entry({ slug: '2026/08/01/090000', pubDate: '2026-08-01T00:00:00.000Z' }),
      entry({ slug: '2026/09/27/142621', pubDate: '2026-09-27T05:26:21.486Z' }),
      entry({ slug: '2026/09/01/120000', pubDate: '2026-09-01T03:00:00.000Z' }),
    ]);

    expect(slugs(ul)).toEqual([
      '2026/09/27/142621',
      '2026/09/01/120000',
      '2026/08/01/090000',
    ]);
  });

  it('**渡された配列を並べ替えない**（呼び出し側の値を壊さない）', () => {
    const ul = list();
    const posts = [
      entry({ slug: '2026/08/01/090000', pubDate: '2026-08-01T00:00:00.000Z' }),
      entry({ slug: '2026/09/27/142621', pubDate: '2026-09-27T05:26:21.486Z' }),
    ];
    renderPostList(ul, posts);

    expect(posts.map((post) => post.slug)).toEqual([
      '2026/08/01/090000',
      '2026/09/27/142621',
    ]);
  });

  it('下書きは**文字で**分かる（色だけに頼らない）', () => {
    const ul = list();
    renderPostList(ul, [entry({ draft: true }), entry({ slug: '2026/01/01/000000', draft: false })]);

    const items = [...ul.querySelectorAll('li')];
    expect(items[0]?.textContent).toContain('下書き');
    expect(items[1]?.textContent).not.toContain('下書き');
  });

  it('各行に data-slug が付く（Phase 4 が記事を特定する手がかり）', () => {
    const ul = list();
    renderPostList(ul, [entry()]);

    expect(slugs(ul)).toEqual(['2026/09/27/142621']);
  });

  it('`<time datetime>` が pubDate の実値を持つ（機械可読）', () => {
    const ul = list();
    renderPostList(ul, [entry()]);

    const time = ul.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-09-27T05:26:21.486Z');
    // 表示は slug の日付部分。**slug は JST の壁時計そのもの**なので、
    // 新しい書式化関数を増やさずに時差のずれない表示ができる。
    expect(time?.textContent).toBe('2026/09/27');
  });

  it('0 件のときは文言を出し、data-slug の行を作らない', () => {
    const ul = list();
    renderPostList(ul, []);

    expect(ul.textContent).toContain(EMPTY_POST_LIST_MESSAGE);
    expect(slugs(ul).filter((slug) => slug.length > 0)).toEqual([]);
  });

  it('**描き直しで前回の行が残らない**', () => {
    const ul = list();
    renderPostList(ul, [entry({ slug: '2026/08/01/090000' }), entry()]);
    renderPostList(ul, [entry()]);

    expect(slugs(ul)).toEqual(['2026/09/27/142621']);
  });
});
