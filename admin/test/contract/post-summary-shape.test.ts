import { describe, expect, it } from 'vitest';

import type { PostSummary } from '@blog/api/src/deps.ts';
import type { PostListEntry } from '../../src/editor/post-list.ts';

/**
 * **`PostListEntry` は api の `PostSummary` の部分集合であること。**
 *
 * `post-list.ts` は 4 つだけを自前で宣言している（`deps.ts` を値 import すると
 * `aws-jwt-verify` がブラウザのバンドルに入る）。**綴りがずれたら一覧が空欄になる**
 * — API は `title` を返しているのに `name` を読む、という壊れ方は型では止まらない。
 *
 * このテストは node 環境（contract プロジェクト）なので、api の型を読んでも
 * ブラウザのバンドルには関係しない。
 */
describe('PostListEntry と PostSummary の契約', () => {
  it('**PostSummary を PostListEntry として渡せる**（キーの綴りと型が一致している）', () => {
    const summary: PostSummary = {
      slug: '2026/09/27/142621',
      title: 'A title',
      description: 'A description',
      pubDate: '2026-09-27T05:26:21.486Z',
      draft: false,
      tags: [],
      sha: 'blob-sha',
    };

    // 代入が通ること自体が主張。**型エラーになれば typecheck が落ちる。**
    const entry: PostListEntry = summary;

    expect(entry.slug).toBe(summary.slug);
    expect(entry.title).toBe(summary.title);
    expect(entry.draft).toBe(summary.draft);
    expect(entry.pubDate).toBe(summary.pubDate);
  });

  it('`PostListEntry` が読む 4 つのキーが `PostSummary` に実在する', () => {
    // 型の代入だけだと「PostListEntry に余計なキーを足しても通る」場合がある
    // （余剰プロパティ検査は変数宣言時のリテラルにしか働かない）。
    // **実行時にもキーの存在を見る。**
    const keys: Array<keyof PostListEntry> = ['slug', 'title', 'draft', 'pubDate'];
    const summaryKeys: Array<keyof PostSummary> = [
      'slug',
      'title',
      'description',
      'pubDate',
      'draft',
      'tags',
      'sha',
    ];

    for (const key of keys) {
      expect(summaryKeys, `PostSummary に ${key} が無い`).toContain(key);
    }
  });
});
