import { describe, expect, it } from 'vitest';

import { SLUG_PATTERN, TAG_PATTERN, PostValidationError } from '@blog/api/src/posts/validate.ts';
import {
  SLUG_PATTERN as ADMIN_SLUG_PATTERN,
  TAG_PATTERN as ADMIN_TAG_PATTERN,
  emptyDraft,
  parseTags,
  validateDraft,
} from '../../src/editor/model.ts';
import type { DraftFields } from '../../src/editor/model.ts';

const NOW = Date.parse('2026-08-31T02:30:00.000Z');

const draft = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  slug: 'a-post',
  title: 'A title',
  description: 'A description',
  pubDate: '',
  tags: '',
  draft: false,
  body: 'Some body text.',
  ...overrides,
});

/** 検証に落ちたときの field。落ちなければ undefined。 */
const fieldOf = (fields: DraftFields): string | undefined => {
  try {
    validateDraft(fields, NOW);
    return undefined;
  } catch (error) {
    // **api の実物の例外型で受け取れることが、規則を書き写していない証拠。**
    expect(error).toBeInstanceOf(PostValidationError);
    return (error as PostValidationError).field;
  }
};

describe('parseTags', () => {
  it.each([
    ['a, b ,c', ['a', 'b', 'c']],
    ['', []],
    [' , ', []],
    ['  ', []],
    ['single', ['single']],
    ['a,,b', ['a', 'b']],
    ['  spaced  ,  out  ', ['spaced', 'out']],
    ['dup, dup', ['dup']],
  ])('parseTags(%j) === %j', (input, expected) => {
    expect(parseTags(input)).toEqual(expected);
  });
});

describe('**規則を admin 側で再定義していない**', () => {
  it('SLUG_PATTERN が api から import した同一オブジェクトである', () => {
    // toBe（参照同一性）。toEqual だと「同じ形の別の正規表現」でも通ってしまい、
    // 片方だけ緩めたときに気づけない。
    expect(ADMIN_SLUG_PATTERN).toBe(SLUG_PATTERN);
  });

  it('TAG_PATTERN が api から import した同一オブジェクトである', () => {
    expect(ADMIN_TAG_PATTERN).toBe(TAG_PATTERN);
  });
});

describe('validateDraft が api の validatePost に委ねている', () => {
  it('正しい入力は ValidatedPost になる', () => {
    expect(validateDraft(draft({ tags: 'astro, nix' }), NOW)).toEqual({
      slug: 'a-post',
      title: 'A title',
      description: 'A description',
      pubDate: '2026-08-31T02:30:00.000Z',
      draft: false,
      tags: ['astro', 'nix'],
      body: 'Some body text.',
    });
  });

  it.each([
    ['空', ''],
    ['大文字', 'A-Post'],
    ['ドット入り', 'node-24.19-notes'],
    ['スラッシュ入り', 'a/b'],
    ['先頭ハイフン', '-a'],
    ['末尾ハイフン', 'a-'],
    ['日本語', '記事'],
  ])('slug が %s なら field === "slug"', (_label, slug) => {
    expect(fieldOf(draft({ slug }))).toBe('slug');
  });

  it.each([
    ['title', 'title'],
    ['description', 'description'],
  ])('%s が空白のみなら落ちる', (field) => {
    expect(fieldOf(draft({ [field]: '   ' }))).toBe(field);
  });

  it.each([
    ['大文字', 'Astro'],
    ['空白入り', 'two words'],
    ['日本語', 'にほんご'],
    ['アンダースコア', 'a_b'],
  ])('タグが %s なら field === "tags"', (_label, tag) => {
    expect(fieldOf(draft({ tags: tag }))).toBe('tags');
  });

  it('タグが空なら [] として通る', () => {
    expect(validateDraft(draft({ tags: '' }), NOW).tags).toEqual([]);
  });
});

describe('pubDate', () => {
  it('**未入力なら nowMs から ISO 8601 が入る**', () => {
    // 時計を注入する。Date.now() を関数内で読むとテストが時刻依存になる。
    expect(validateDraft(draft({ pubDate: '' }), NOW).pubDate).toBe('2026-08-31T02:30:00.000Z');
  });

  it('別の nowMs を渡せば別の値になる（時計が本当に注入されている）', () => {
    const other = Date.parse('2020-01-02T03:04:05.000Z');
    expect(validateDraft(draft({ pubDate: '' }), other).pubDate).toBe('2020-01-02T03:04:05.000Z');
  });

  it('datetime-local の文字列を ISO 8601 に正規化する', () => {
    // <input type="datetime-local"> は '2026-08-31T11:30' の形を返す。
    // **空文字を api に渡すと Date.parse('') が NaN で落ちる**ので、
    // 空のときは key ごと落として api の「未指定なら now」に委ねている。
    const result = validateDraft(draft({ pubDate: '2026-08-31T11:30' }), NOW);
    expect(result.pubDate).toBe(new Date('2026-08-31T11:30').toISOString());
  });

  it('壊れた日付は field === "pubDate" で落ちる', () => {
    expect(fieldOf(draft({ pubDate: 'not-a-date' }))).toBe('pubDate');
  });
});

describe('draft チェックボックス', () => {
  it('true がそのまま渡る', () => {
    expect(validateDraft(draft({ draft: true }), NOW).draft).toBe(true);
  });

  it('false がそのまま渡る（"false" を true に読まない）', () => {
    expect(validateDraft(draft({ draft: false }), NOW).draft).toBe(false);
  });
});

describe('emptyDraft', () => {
  it('draft が true で始まる（**既定で下書き**。誤って公開しない）', () => {
    expect(emptyDraft().draft).toBe(true);
  });

  it('7 フィールドをちょうど持つ', () => {
    expect(Object.keys(emptyDraft()).sort()).toEqual([
      'body',
      'description',
      'draft',
      'pubDate',
      'slug',
      'tags',
      'title',
    ]);
  });
});
