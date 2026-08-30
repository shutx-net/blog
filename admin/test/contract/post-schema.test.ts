import { parseFrontmatter } from '@astrojs/markdown-remark';
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '@blog/api/src/posts/frontmatter.ts';
import { TAG_PATTERN, validatePost } from '@blog/api/src/posts/validate.ts';
import { postSchema } from '@blog/site/src/content.config.ts';
import { validateDraft } from '../../src/editor/model.ts';
import type { DraftFields } from '../../src/editor/model.ts';

const NOW = Date.parse('2026-08-31T02:30:00.000Z');

const draft = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  slug: 'a-post',
  title: 'A title',
  description: 'A description',
  pubDate: '',
  tags: '',
  draft: false,
  body: 'Body.',
  ...overrides,
});

/**
 * **admin が受理する入力。** ここを通ったものは api も site も通らなければならない。
 */
const ACCEPTED: Array<[string, DraftFields]> = [
  ['最小', draft()],
  ['タグつき', draft({ tags: 'astro, nix, aws' })],
  ['下書き', draft({ draft: true })],
  ['pubDate 明示', draft({ pubDate: '2026-08-31T11:30' })],
  ['日本語のタイトルと本文', draft({ title: '日本語のタイトル', body: '日本語の本文。\n\n段落。' })],
  ['引用符入りのタイトル', draft({ title: 'A "quoted" title' })],
  ['バックスラッシュ入り', draft({ title: 'back\\slash', description: 'desc\\end' })],
  ['**改行を仕込んだタイトル**', draft({ title: 'まとも\ndraft: true' })],
  ['タブ入り', draft({ title: 'tab\there' })],
  ['絵文字', draft({ title: '🎉 released', description: '🎉' })],
  ['前後に空白のあるタイトル', draft({ title: '  padded  ' })],
  ['長い slug', draft({ slug: 'a'.repeat(180) })],
  ['コードフェンス入りの本文', draft({ body: '```ts\nconst a = 1;\n```' })],
];

/**
 * **admin が拒否する入力。** api も拒否しなければならない
 * （= admin が api より緩くない）。
 */
const REJECTED: Array<[string, DraftFields]> = [
  ['slug 空', draft({ slug: '' })],
  ['slug に大文字', draft({ slug: 'A-Post' })],
  ['slug にドット', draft({ slug: 'a.b' })],
  ['slug にスラッシュ', draft({ slug: 'a/b' })],
  ['title 空白のみ', draft({ title: '  ' })],
  ['description 空白のみ', draft({ description: '' })],
  ['タグに大文字', draft({ tags: 'Astro' })],
  ['タグに日本語', draft({ tags: 'にほんご' })],
  ['タグに空白', draft({ tags: 'two words' })],
  ['pubDate が壊れている', draft({ pubDate: 'not-a-date' })],
];

const accepts = (fields: DraftFields): boolean => {
  try {
    validateDraft(fields, NOW);
    return true;
  } catch {
    return false;
  }
};

/**
 * 三段契約の最後の 1 段。
 *
 *   admin ⊆ api        … このファイル（下の 2 つの describe）
 *   api   ⊆ postSchema … api/test/contract/frontmatter-schema.test.ts（既存）
 *
 * **同じ主張を書き直さない。** ここは「admin が api を素通しにしていること」と
 * 「admin の出力が実 postSchema を通ること」に焦点を当てる。
 *
 * **このテストだけが postSchema の実物に触れる。** ブラウザ側は触れない
 * （`content.config.ts` をバンドルすると `astro/loaders` 経由で node builtin が
 * 22 件 externalize され、実行時に投げる proxy が混ざる。実測）。
 */
describe('コーパスが空でない', () => {
  it('受理する入力が 1 件以上ある', () => {
    expect(ACCEPTED.length).toBeGreaterThan(0);
  });

  it('拒否する入力が 1 件以上ある', () => {
    expect(REJECTED.length).toBeGreaterThan(0);
  });

  it('受理コーパスが本当に全件受理される（分類が逆になっていない）', () => {
    expect(ACCEPTED.filter(([, fields]) => !accepts(fields)).map(([label]) => label)).toEqual([]);
  });

  it('拒否コーパスが本当に全件拒否される', () => {
    expect(REJECTED.filter(([, fields]) => accepts(fields)).map(([label]) => label)).toEqual([]);
  });
});

describe('**admin が通すものは site の postSchema も通す**', () => {
  it.each(ACCEPTED)('%s', (_label, fields) => {
    const post = validateDraft(fields, NOW);
    // api の実物で Markdown を組み立て、astro と同じパーサで読み直す。
    const { frontmatter } = parseFrontmatter(renderMarkdown(post));
    const result = postSchema.safeParse(frontmatter);
    expect(result.success, `postSchema が拒否した: ${JSON.stringify(result.error?.issues)}`).toBe(
      true,
    );
  });
});

describe('**admin が拒否するものは api も拒否する**（admin が緩くない）', () => {
  it.each(REJECTED)('%s', (_label, fields) => {
    expect(accepts(fields)).toBe(false);
    // 同じ入力を api の validatePost に直接渡しても拒否される。
    expect(() =>
      validatePost(
        {
          slug: fields.slug,
          title: fields.title,
          description: fields.description,
          draft: fields.draft,
          tags: fields.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0),
          body: fields.body,
          ...(fields.pubDate === '' ? {} : { pubDate: fields.pubDate }),
        },
        NOW,
      ),
    ).toThrow();
  });
});

describe('front matter の組み立てを admin が自前でやっていない', () => {
  it('**改行を仕込んだ title でもキーが 5 個のままである**', () => {
    // api の YAML エスケープに乗っていることの確認。admin が独自に front matter を
    // 組み立てていたら、ここでフィールドを注入できてしまう。
    const post = validateDraft(draft({ title: 'まとも\ndraft: true' }), NOW);
    const { frontmatter } = parseFrontmatter(renderMarkdown(post));
    expect(Object.keys(frontmatter).sort()).toEqual([
      'description',
      'draft',
      'pubDate',
      'tags',
      'title',
    ]);
    // 注入した 'draft: true' が draft フィールドを乗っ取っていない。
    expect(frontmatter['draft']).toBe(false);
    expect(frontmatter['title']).toBe('まとも\ndraft: true');
  });

  it('本文が front matter の後ろにそのまま入る', () => {
    const post = validateDraft(draft({ body: '## H\n\ntext' }), NOW);
    expect(renderMarkdown(post).endsWith('\n\n## H\n\ntext')).toBe(true);
  });
});

describe('pubDate が Date として往復する', () => {
  it('postSchema.parse の結果が admin の入力時刻と一致する', () => {
    const post = validateDraft(draft({ pubDate: '2026-08-31T11:30' }), NOW);
    const { frontmatter } = parseFrontmatter(renderMarkdown(post));
    const parsed = postSchema.parse(frontmatter);
    expect(parsed.pubDate).toBeInstanceOf(Date);
    expect(parsed.pubDate.toISOString()).toBe(new Date('2026-08-31T11:30').toISOString());
  });

  it('pubDate 未指定なら注入した時計の値になる', () => {
    const post = validateDraft(draft({ pubDate: '' }), NOW);
    const parsed = postSchema.parse(parseFrontmatter(renderMarkdown(post)).frontmatter);
    expect(parsed.pubDate.toISOString()).toBe('2026-08-31T02:30:00.000Z');
  });
});

describe('**タグの正規表現が 3 箇所で一致する**', () => {
  /**
   * `postSchema.shape.tags` の下から到達できる正規表現の source を全部集める。
   *
   * **固定パスで取りに行かない。** Zod 4 の内部構造（実測では
   * `tags.def.innerType.def.element._zod.pattern`）は公開 API ではなく、
   * 上げたときに黙って空振りする。「集めた中に居ること」なら構造が変わっても
   * 成立し、**regex を緩めたときだけ落ちる**。
   */
  const tagRegexSources = (): string[] => {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 8 || node === null || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (node instanceof RegExp) {
        found.push(node.source);
        return;
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
      // **`_zod` は列挙可能ではないので Object.values に出てこない**（実測）。
      // 明示的に辿らないと走査が空振りする。
      walk((node as { _zod?: unknown })._zod, depth + 1);
    };
    walk((postSchema as unknown as { shape: Record<string, unknown> }).shape['tags'], 0);
    return found;
  };

  it('admin が使う TAG_PATTERN は api 由来である', () => {
    // 4.8 で参照同一性まで見ている。ここでは 3 箇所目（postSchema）に届かせる。
    expect(TAG_PATTERN.source).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*$');
  });

  it('tags の下から正規表現が 1 つ以上見つかる（走査が空振りしていない）', () => {
    expect(tagRegexSources().length).toBeGreaterThan(0);
  });

  it('**postSchema の tags に同じ source の正規表現が入っている**', () => {
    expect(tagRegexSources()).toContain(TAG_PATTERN.source);
  });

  it.each([
    'astro',
    'nix',
    'two-words',
    'a1',
    'Astro',
    'two words',
    'にほんご',
    'a_b',
    '',
    '-lead',
    'trail-',
    'UPPER',
  ])('タグ %j に対する判定が TAG_PATTERN と postSchema で一致する', (tag) => {
    // **振る舞いでも突き合わせる。** 文字列比較だけだと「取り出しに失敗して
    // いるのに一致した」形がありうるし、逆に構造比較を通っても
    // `.default()` や `.transform()` の位置で実効挙動が変わることがある。
    const bySchema = postSchema.safeParse({
      title: 't',
      description: 'd',
      pubDate: '2026-01-01T00:00:00.000Z',
      draft: false,
      tags: [tag],
    }).success;
    expect(bySchema).toBe(TAG_PATTERN.test(tag));
  });
});
