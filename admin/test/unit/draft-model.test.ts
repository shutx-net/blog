import { describe, expect, it } from 'vitest';

import { dateSlug } from '@blog/api/src/posts/slug.ts';
import { TAG_PATTERN, PostValidationError } from '@blog/api/src/posts/validate.ts';
import {
  TAG_PATTERN as ADMIN_TAG_PATTERN,
  dateSlug as ADMIN_DATE_SLUG,
  emptyDraft,
  parseTags,
  postRequestBody,
  publishPathLabel,
  validateDraft,
} from '../../src/editor/model.ts';
import type { DraftFields } from '../../src/editor/model.ts';

const NOW = Date.parse('2026-08-31T02:30:00.000Z');

const draft = (overrides: Partial<DraftFields> = {}): DraftFields => ({
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
  it('TAG_PATTERN が api から import した同一オブジェクトである', () => {
    // toBe（参照同一性）。toEqual だと「同じ形の別の正規表現」でも通ってしまい、
    // 片方だけ緩めたときに気づけない。
    expect(ADMIN_TAG_PATTERN).toBe(TAG_PATTERN);
  });

  it('**dateSlug が api から import した同一の関数である**', () => {
    // 公開先の表示が api の導出と別実装になると、画面と実際の URL がずれる。
    expect(ADMIN_DATE_SLUG).toBe(dateSlug);
  });
});

describe('validateDraft が api の validatePost に委ねている', () => {
  it('正しい入力は ValidatedPost になる', () => {
    expect(validateDraft(draft({ tags: 'astro, nix' }), NOW)).toEqual({
      // NOW = 2026-08-31T02:30:00Z -> JST 11:30:00 同日。
      slug: '2026/08/31/113000',
      title: 'A title',
      description: 'A description',
      pubDate: '2026-08-31T02:30:00.000Z',
      draft: false,
      tags: ['astro', 'nix'],
      body: 'Some body text.',
    });
  });

  it('**slug は送らない。** pubDate から導出される', () => {
    // フォームに slug の欄が無いので、admin は送りようがない。
    // api 側は送られたら 400 にする（api/test/unit/post-validate.test.ts）。
    expect(validateDraft(draft({ pubDate: '2026-09-08T05:40:01' }), NOW).slug).toBe(
      '2026/09/08/054001',
    );
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

  it('**datetime-local の壁時計を JST の瞬間として正規化する**', () => {
    // <input type="datetime-local"> は '2026-08-31T11:30' の形（オフセット無し）を返す。
    // そのまま渡すと Date.parse がホストの TZ で解釈し、**公開先が著者の居場所で
    // 変わる**（CI の UTC ランナーが本番の挙動として検出した）。
    //
    // **期待値をホストの TZ から計算しない。** JST の 11:30 は UTC の 02:30 ちょうど。
    const result = validateDraft(draft({ pubDate: '2026-08-31T11:30' }), NOW);
    expect(result.pubDate).toBe('2026-08-31T02:30:00.000Z');
  });

  it('**空文字は key ごと落として api の「未指定なら now」に委ねる**', () => {
    // 空文字を渡すと Date.parse('') が NaN で落ちる。
    expect(validateDraft(draft({ pubDate: '' }), NOW).pubDate).toBe('2026-08-31T02:30:00.000Z');
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

  it('**6 フィールドをちょうど持つ（slug は無い）**', () => {
    expect(Object.keys(emptyDraft()).sort()).toEqual([
      'body',
      'description',
      'draft',
      'pubDate',
      'tags',
      'title',
    ]);
  });
});

describe('publishPathLabel', () => {
  it('pubDate を入れると公開先の URL が出る', () => {
    expect(publishPathLabel(draft({ pubDate: '2026-09-08T05:40:01' }), NOW)).toBe(
      '公開先: /posts/2026/09/08/054001/',
    );
  });

  it('**未入力なら nowMs から出しつつ「確定していない」と言う**', () => {
    // 画面の値のまま公開されるとは限らないので、そう書いていないと誤解を生む。
    const label = publishPathLabel(draft({ pubDate: '' }), NOW);
    expect(label).toContain('/posts/2026/08/31/113000/');
    expect(label).toContain('送信時刻で確定する');
  });

  it('別の nowMs を渡せば別の値になる（時計が本当に注入されている）', () => {
    const other = Date.parse('2020-01-02T03:04:05.000Z');
    expect(publishPathLabel(draft({ pubDate: '' }), other)).toContain('/posts/2020/01/02/120405/');
  });

  it('**壊れた pubDate では投げず「決まらない」と言う**', () => {
    // 投げると bindEditor の update() が落ちて、画面全体が更新されなくなる。
    expect(() => publishPathLabel(draft({ pubDate: 'not-a-date' }), NOW)).not.toThrow();
    expect(publishPathLabel(draft({ pubDate: 'not-a-date' }), NOW)).toContain('決まらない');
  });

  it('**出す値が実際に送る値と一致する**（画面と公開先がずれない）', () => {
    // **api の導出をそのまま通して突き合わせる。** 期待値をホストの TZ から
    // 計算すると、TZ が変わった日に両方が同じだけずれて一致したまま素通りする。
    for (const pubDate of ['2026-09-08T05:40:01', '2026-01-01T00:00', '2026-12-31T23:59:59']) {
      const sent = validateDraft(draft({ pubDate }), NOW);
      expect(publishPathLabel(draft({ pubDate }), NOW)).toBe(`公開先: /posts/${sent.slug}/`);
    }
  });

  it.each([
    ['JST の朝', '2026-09-08T05:40:01', '/posts/2026/09/08/054001/'],
    ['JST の 0 時', '2026-09-08T00:00:00', '/posts/2026/09/08/000000/'],
    ['JST の 23:59', '2026-12-31T23:59:59', '/posts/2026/12/31/235959/'],
  ])('**%s は TZ に関係なく %s**', (_label, pubDate, expected) => {
    // 入力した壁時計時刻がそのまま URL になる（JST 固定なので）。
    expect(publishPathLabel(draft({ pubDate }), NOW)).toBe(`公開先: ${expected}`);
  });
});

describe('postRequestBody', () => {
  it('**slug を落とす**（api は付いていたら 400 にする）', () => {
    // validateDraft の結果をそのまま投げると admin 自身がその 400 を踏む。
    // 実際に一度踏んだので、ここで固定しておく。
    const post = validateDraft(draft({ pubDate: '2026-09-08T05:40:01' }), NOW);
    expect(post.slug).toBe('2026/09/08/054001');
    expect(Object.keys(postRequestBody(post))).not.toContain('slug');
  });

  it('記事の中身は 1 つも落とさない', () => {
    const post = validateDraft(draft({ tags: 'astro, nix' }), NOW);
    expect(postRequestBody(post)).toEqual({
      title: post.title,
      description: post.description,
      pubDate: post.pubDate,
      draft: post.draft,
      tags: post.tags,
      body: post.body,
    });
  });

  it('**落とすのは slug ちょうど 1 つ**', () => {
    const post = validateDraft(draft(), NOW);
    const remaining = Object.keys(postRequestBody(post));
    expect(remaining).toHaveLength(Object.keys(post).length - 1);
  });
});
