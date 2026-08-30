import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
// **site の実物を import する。複製もモックもしない。**
// api の役割は「GitHub Actions のビルドが落ちない Markdown を書く」ことであり、
// その判定基準は site/src/content.config.ts の postSchema そのものだから。
// 複製すると必ずいつか乖離し、乖離した瞬間に本番のビルドが止まる（記事を 1 本足すと
// 一覧・タグ・ページネーション・RSS・sitemap が全部作り直しになる）。
import { postSchema } from '@blog/site/src/content.config.ts';
import { renderMarkdown, toFrontMatterObject } from '../../src/posts/frontmatter.ts';
import { validatePost } from '../../src/posts/validate.ts';

const NOW_MS = Date.UTC(2026, 7, 30, 12, 34, 56);

const build = (overrides: Record<string, unknown> = {}) =>
  validatePost(
    {
      slug: 'hello-world',
      title: 'こんにちは',
      description: '最初の記事',
      body: '本文です。\n',
      ...overrides,
    },
    NOW_MS,
  );

/** 生成した Markdown から front matter ブロックだけを切り出して js-yaml で読む。 */
const parseFrontMatter = (markdown: string): { data: unknown; body: string } => {
  expect(markdown.startsWith('---\n'), "Markdown が '---\\n' で始まること").toBe(true);
  const end = markdown.indexOf('\n---\n', 3);
  expect(end, '閉じの --- があること').toBeGreaterThan(0);
  return {
    data: load(markdown.slice(4, end + 1)),
    body: markdown.slice(end + '\n---\n'.length),
  };
};

describe('契約: api が生成した front matter が site の postSchema を通る', () => {
  it('最小の記事が通る', () => {
    const result = postSchema.safeParse(toFrontMatterObject(build()));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('タグ・下書き・明示 pubDate を付けた記事が通る', () => {
    const post = build({ tags: ['aws', 'node-24'], draft: true, pubDate: '2026-01-02T03:04:05.000Z' });
    const result = postSchema.safeParse(toFrontMatterObject(post));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.tags).toEqual(['aws', 'node-24']);
    expect(result.data?.draft).toBe(true);
  });

  it('**生成した Markdown を js-yaml で読み直したものも通る**', () => {
    // astro が front matter の解釈に使っているのが js-yaml（astro@7.2.9 -> js-yaml@4.3.2）。
    // オブジェクトのままでなく **文字列を経由した結果** を検査することで、
    // 直列化で壊れる経路（引用・エスケープ・キー順）を落とす。
    const { data } = parseFrontMatter(renderMarkdown(build({ tags: ['aws'] })));
    const result = postSchema.safeParse(data);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('pubDate が Date に強制される（postSchema の z.coerce.date）', () => {
    const { data } = parseFrontMatter(renderMarkdown(build()));
    const parsed = postSchema.parse(data);
    expect(parsed.pubDate).toBeInstanceOf(Date);
    expect(parsed.pubDate.toISOString()).toBe(new Date(NOW_MS).toISOString());
  });
});

describe('契約: api が落とす入力は site でも落ちる（api の検証が同等以上に厳しい）', () => {
  it('大文字を含むタグは postSchema 側でも落ちる', () => {
    // api が通してしまうと site のビルドが落ちる入力。**両側で落ちること**を
    // 主張して初めて「api の検証が site より緩くない」と言える。
    expect(postSchema.safeParse({
      title: 't',
      description: 'd',
      pubDate: '2026-01-01',
      tags: ['AWS'],
    }).success).toBe(false);
    expect(() => build({ tags: ['AWS'] })).toThrow();
  });

  it('空の description は postSchema 側でも落ちる', () => {
    expect(postSchema.safeParse({
      title: 't',
      description: '',
      pubDate: '2026-01-01',
    }).success).toBe(false);
    expect(() => build({ description: '' })).toThrow();
  });

  it('空の title は postSchema 側でも落ちる', () => {
    expect(postSchema.safeParse({ title: '', description: 'd', pubDate: '2026-01-01' }).success).toBe(
      false,
    );
    expect(() => build({ title: '' })).toThrow();
  });

  it('スペース入りのタグは postSchema 側でも落ちる', () => {
    expect(postSchema.safeParse({
      title: 't',
      description: 'd',
      pubDate: '2026-01-01',
      tags: ['Two Words'],
    }).success).toBe(false);
    expect(() => build({ tags: ['Two Words'] })).toThrow();
  });
});

describe('Markdown のかたち', () => {
  it("'---\\n' で始まり、front matter の直後に空行 1 行を挟んで本文が続く", () => {
    const markdown = renderMarkdown(build({ body: '本文\n' }));
    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('\n---\n\n本文\n');
  });

  it('本文がそのまま保持される', () => {
    const body = '# 見出し\n\n段落と `code` と [link](https://example.com/).\n';
    expect(parseFrontMatter(renderMarkdown(build({ body }))).body).toBe(`\n${body}`);
  });

  it('front matter が 5 フィールドちょうどである', () => {
    const { data } = parseFrontMatter(renderMarkdown(build()));
    expect(Object.keys(data as Record<string, unknown>).sort()).toEqual([
      'description',
      'draft',
      'pubDate',
      'tags',
      'title',
    ]);
  });
});

describe('インジェクション: ユーザ入力が front matter の構造を破れないこと', () => {
  it('本文に "---" だけの行があってもブロックが壊れない', () => {
    const body = '前段\n\n---\n\n後段\n';
    const { data, body: parsedBody } = parseFrontMatter(renderMarkdown(build({ body })));
    expect((data as Record<string, unknown>)['title']).toBe('こんにちは');
    expect(parsedBody).toBe(`\n${body}`);
  });

  it('本文が front matter を模していてもブロックが壊れない', () => {
    const body = '---\ntitle: "乗っ取り"\ndraft: true\n---\n\n本文\n';
    const { data } = parseFrontMatter(renderMarkdown(build({ body })));
    expect((data as Record<string, unknown>)['title']).toBe('こんにちは');
    expect((data as Record<string, unknown>)['draft']).toBe(false);
  });

  it('**title に改行と front matter を仕込んでもフィールドが増えない**', () => {
    // この API で唯一のインジェクション面。改行をエスケープしないと
    // title の中から draft: true を注入できてしまう。
    const post = build({ title: 'まとも\ndraft: true\nevil: yes' });
    const { data } = parseFrontMatter(renderMarkdown(post));
    const record = data as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'description',
      'draft',
      'pubDate',
      'tags',
      'title',
    ]);
    expect(record['draft']).toBe(false);
    expect(record['evil']).toBeUndefined();
    expect(record['title']).toBe('まとも\ndraft: true\nevil: yes');
  });

  it('title に "---" を入れてもブロックが閉じない', () => {
    const post = build({ title: '---' });
    const { data } = parseFrontMatter(renderMarkdown(post));
    expect((data as Record<string, unknown>)['title']).toBe('---');
    expect(postSchema.safeParse(data).success).toBe(true);
  });
});

describe('YAML のメタ文字が往復で元に戻る', () => {
  it.each([
    'コロン: を含む',
    'ハッシュ # を含む',
    'ダブルクォート " を含む',
    "シングルクォート ' を含む",
    'バックスラッシュ \\ を含む',
    '角括弧 [a, b] を含む',
    '波括弧 {a: b} を含む',
    'アンパサンド & と * を含む',
    'パイプ | と > を含む',
    'タブ\tを含む',
    '末尾の空白 ',
    '@ と ` と % を含む',
    'yes',
    'null',
    '123',
    'true',
  ])('title が %o でも読み直すと元に戻る', (title) => {
    const post = build({ title, description: title });
    const { data } = parseFrontMatter(renderMarkdown(post));
    const record = data as Record<string, unknown>;
    // 前後の空白は validatePost が落とすので、比較対象も trim する。
    expect(record['title']).toBe(title.trim());
    expect(record['description']).toBe(title.trim());
    expect(postSchema.safeParse(data).success).toBe(true);
  });

  it('文字列として読まれる（"yes" が真偽値、"123" が数値にならない）', () => {
    for (const title of ['yes', 'no', 'true', 'false', '123', 'null', '~']) {
      const { data } = parseFrontMatter(renderMarkdown(build({ title, description: title })));
      expect(typeof (data as Record<string, unknown>)['title'], `title=${title}`).toBe('string');
    }
  });
});
