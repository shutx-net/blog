import { describe, expect, it } from 'vitest';
import { FrontMatterParseError, parseMarkdown } from '../../src/posts/parse-frontmatter.ts';
import { renderMarkdown } from '../../src/posts/frontmatter.ts';
import { validatePost } from '../../src/posts/validate.ts';

const NOW_MS = Date.UTC(2026, 7, 30, 12, 34, 56);

const build = (overrides: Record<string, unknown> = {}) =>
  validatePost(
    {
      title: 'こんにちは',
      description: '最初の記事',
      body: '本文です。\n',
      ...overrides,
    },
    NOW_MS,
  );

/** 本番の記事が実際に持っている形（`renderFrontMatter` の出力）。 */
const CANONICAL = [
  '---',
  'title: "test"',
  'description: "testtesttest"',
  'pubDate: "2026-09-27T05:26:21.486Z"',
  'draft: false',
  'tags: []',
  '---',
  '',
  '# test',
  '## test',
  '',
].join('\n');

/**
 * 手で書いた記事の形。**`pubDate` が引用されていない。**
 *
 * `site/test/fixtures/posts/2026/08/03/090000.md` の実物がこの形で、
 * blog-content の README も「直接コミットしてもよい」と言っている。
 * 正規形しか読めない parser にすると、手で書いた記事が一覧に出た日に落ちる。
 */
const HAND_WRITTEN = [
  '---',
  'title: "Draft post"',
  'description: "An unfinished post; it must never reach dist/."',
  'pubDate: 2026-08-03',
  'draft: true',
  'tags: ["astro", "draft-only"]',
  '---',
  '',
  '本文',
  '',
].join('\n');

describe('parseMarkdown が renderMarkdown の逆になっている', () => {
  it('正規形を読める', () => {
    const parsed = parseMarkdown(CANONICAL);
    expect(parsed.title).toBe('test');
    expect(parsed.description).toBe('testtesttest');
    expect(parsed.pubDate).toBe('2026-09-27T05:26:21.486Z');
    expect(parsed.draft).toBe(false);
    expect(parsed.tags).toEqual([]);
    expect(parsed.body).toBe('# test\n## test\n');
  });

  it('**引用されていない値も読める**（手で書いた記事）', () => {
    const parsed = parseMarkdown(HAND_WRITTEN);
    expect(parsed.title).toBe('Draft post');
    expect(parsed.pubDate).toBe('2026-08-03');
    expect(parsed.draft).toBe(true);
    expect(parsed.tags).toEqual(['astro', 'draft-only']);
    expect(parsed.body).toBe('本文\n');
  });

  it('引用のないタグも読める', () => {
    const parsed = parseMarkdown(HAND_WRITTEN.replace('["astro", "draft-only"]', '[astro, draft-only]'));
    expect(parsed.tags).toEqual(['astro', 'draft-only']);
  });

  it('draft と tags は省略できる（site の postSchema と同じ既定）', () => {
    const raw = ['---', 'title: "t"', 'description: "d"', 'pubDate: "2026-01-01T00:00:00.000Z"', '---', '', '本文'].join('\n');
    const parsed = parseMarkdown(raw);
    expect(parsed.draft).toBe(false);
    expect(parsed.tags).toEqual([]);
  });

  it('知らないキーは無視する（前方互換）', () => {
    const parsed = parseMarkdown(CANONICAL.replace('draft: false', 'draft: false\nheroImage: "x.png"'));
    expect(parsed.title).toBe('test');
  });
});

describe('往復: parseMarkdown(renderMarkdown(post)) が元に戻る', () => {
  const roundTrip = (post: ReturnType<typeof build>): void => {
    const parsed = parseMarkdown(renderMarkdown(post));
    expect(parsed.title).toBe(post.title);
    expect(parsed.description).toBe(post.description);
    expect(parsed.pubDate).toBe(post.pubDate);
    expect(parsed.draft).toBe(post.draft);
    expect(parsed.tags).toEqual(post.tags);
    expect(parsed.body).toBe(post.body);
  };

  it('最小の記事', () => {
    roundTrip(build());
  });

  it('タグ・下書き・明示 pubDate', () => {
    roundTrip(build({ tags: ['aws', 'node-24'], draft: true, pubDate: '2026-01-02T03:04:05.000Z' }));
  });

  // **`frontmatter-schema.test.ts` の YAML メタ文字コーパスを再利用する。**
  // あちらは js-yaml で読み直して往復を固定している。こちらが同じ入力で同じ答えを
  // 出すことが、js-yaml を足さずに済ませている根拠になる。
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
    '@ と ` と % を含む',
    'yes',
    'null',
    '123',
    'true',
  ])('title が %o でも往復する', (title) => {
    roundTrip(build({ title, description: title }));
  });

  it('**改行を仕込んだ title でもフィールドが増えず、元の文字列に戻る**', () => {
    // renderFrontMatter が \n をエスケープしているので 1 行に収まる。
    // parser が復号しないと、ここで title が切れて description が壊れる。
    const title = 'まとも\ndraft: true\nx: y';
    roundTrip(build({ title, description: 'd' }));
  });

  it('本文に "---" だけの行があっても壊れない', () => {
    roundTrip(build({ body: '前\n\n---\n\n後\n' }));
  });

  it('本文が front matter を模していても壊れない', () => {
    roundTrip(build({ body: '---\ntitle: "偽"\n---\n\n本文\n' }));
  });

  it('本文が空行から始まっても保たれる', () => {
    roundTrip(build({ body: '\n先頭が空行\n' }));
  });

  it('本文が空でも保たれる', () => {
    roundTrip(build({ body: '' }));
  });
});

describe('壊れた入力は FrontMatterParseError になる', () => {
  it('front matter ブロックが無い', () => {
    expect(() => parseMarkdown('# 見出しだけ\n')).toThrow(FrontMatterParseError);
  });

  it('閉じの --- が無い', () => {
    expect(() => parseMarkdown('---\ntitle: "t"\n')).toThrow(FrontMatterParseError);
  });

  it.each(['title', 'description', 'pubDate'])('必須キー %s の欠落を field で報告する', (field) => {
    const raw = CANONICAL.split('\n')
      .filter((line) => !line.startsWith(`${field}:`))
      .join('\n');
    try {
      parseMarkdown(raw);
      expect.unreachable(`${field} が無いのに通った`);
    } catch (error) {
      expect(error).toBeInstanceOf(FrontMatterParseError);
      expect((error as FrontMatterParseError).field).toBe(field);
    }
  });

  it('空の title は落ちる（site の min(1) と揃える）', () => {
    expect(() => parseMarkdown(CANONICAL.replace('title: "test"', 'title: ""'))).toThrow(
      FrontMatterParseError,
    );
  });

  it('**draft が真偽値でなければ落ちる**（"true" を true と読まない）', () => {
    // 曖昧な強制で下書きを公開するのは、この API が一貫して拒んできた種類の事故。
    expect(() => parseMarkdown(CANONICAL.replace('draft: false', 'draft: "true"'))).toThrow(
      FrontMatterParseError,
    );
  });

  it('tags が配列でなければ落ちる', () => {
    expect(() => parseMarkdown(CANONICAL.replace('tags: []', 'tags: "aws"'))).toThrow(
      FrontMatterParseError,
    );
  });

  it('**メッセージに入力値を含めない**（400 やログに出る前提）', () => {
    const secret = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
    try {
      parseMarkdown(['---', `title: "${secret}"`, 'description: "d"', '---', '', 'b'].join('\n'));
      expect.unreachable('pubDate が無いのに通った');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
