import { describe, expect, it } from 'vitest';
import { POST_SLUG_PATTERN, dateSlug } from '../../src/posts/slug.ts';
import { PostValidationError, SLUG_PATTERN, TAG_PATTERN, validatePost } from '../../src/posts/validate.ts';

const NOW_MS = Date.UTC(2026, 7, 30, 12, 34, 56);

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'こんにちは',
  description: '最初の記事',
  body: '本文です。\n',
  ...overrides,
});

const expectRejected = (raw: Record<string, unknown>, field?: string): PostValidationError => {
  let thrown: unknown;
  try {
    validatePost(raw, NOW_MS);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, '検証で落ちること').toBeInstanceOf(PostValidationError);
  if (field !== undefined) expect((thrown as PostValidationError).field).toBe(field);
  return thrown as PostValidationError;
};

describe('slug は入力ではなく pubDate から導出される', () => {
  it('入力に slug が無くても通り、pubDate の JST 日付パスになる', () => {
    // 20:40:01Z は JST では翌日 05:40:01。
    const post = validatePost(valid({ pubDate: '2026-09-07T20:40:01.277Z' }), NOW_MS);
    expect(post.slug).toBe('2026/09/08/054001');
  });

  it('pubDate 省略時は注入したクロックから導出される', () => {
    // NOW_MS = 2026-08-30T12:34:56Z -> JST 21:34:56 同日。
    const post = validatePost(valid(), NOW_MS);
    expect(post.slug).toBe('2026/08/30/213456');
    expect(post.slug).toBe(dateSlug(new Date(NOW_MS).toISOString()));
  });

  it.each([
    ['JST 0 時ちょうど', '2026-09-07T15:00:00.000Z', '2026/09/08/000000'],
    ['その 1ms 前', '2026-09-07T14:59:59.999Z', '2026/09/07/235959'],
    ['年またぎ', '2026-12-31T15:00:00.000Z', '2027/01/01/000000'],
  ])('境界値: %s', (_label, pubDate, expected) => {
    expect(validatePost(valid({ pubDate }), NOW_MS).slug).toBe(expected);
  });

  it('導出された slug は POST_SLUG_PATTERN を満たす', () => {
    for (const pubDate of [
      '2026-09-07T20:40:01.277Z',
      '2026-09-07T15:00:00.000Z',
      '2026-12-31T15:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    ]) {
      expect(POST_SLUG_PATTERN.test(validatePost(valid({ pubDate }), NOW_MS).slug)).toBe(true);
    }
  });

  it('**クライアントが slug を送ってきたら 400**', () => {
    // 黙って無視すると、呼び出し側の思い違い（「この slug で公開されるつもりだった」）が
    // 無言で通り、意図しない URL に記事が出る。**捨てるより拒否する。**
    expectRejected(valid({ slug: 'hello-world' }), 'slug');
  });

  it.each([['日付パスそのもの', '2026/09/08/054001'], ['空文字', ''], ['null', null], ['数値', 42]])(
    'slug が %s でも 400（値によらず「送ってはいけない」）',
    (_label, slug) => {
      expectRejected(valid({ slug }), 'slug');
    },
  );

  it('`slug: undefined` は「送っていない」として通る（JSON には現れない形）', () => {
    expect(validatePost(valid({ slug: undefined }), NOW_MS).slug).toBe('2026/08/30/213456');
  });

  it('pubDate が壊れているときは pubDate で落ち、slug 導出に進まない', () => {
    // 導出順序の主張。slug を先に作ろうとすると dateSlug が素の Error を投げ、
    // PostValidationError ではなくなって 400 にならない（500 になる）。
    expectRejected(valid({ pubDate: 'not a date' }), 'pubDate');
  });

  it('SLUG_PATTERN は既存の平坦スラッグの形として残っている', () => {
    // 入力の検査には使わなくなったが、移行前の 8 本が従う形の定数として
    // site / admin の契約テストが参照している。
    expect(SLUG_PATTERN.test('hello-world')).toBe(true);
    expect(SLUG_PATTERN.test('a.b')).toBe(false);
    expect(SLUG_PATTERN.test('2026/09/08/054001')).toBe(false);
  });
});

describe('tags', () => {
  it('正規表現が site のスキーマと同一である', () => {
    // site/src/content.config.ts の regex と 1 文字も違わないこと。
    expect(TAG_PATTERN.source).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*$');
  });

  it.each(['Two Words', 'AWS', '日本語', 'trailing-', '-leading', '', 'a_b', 'a.b'])(
    'タグ %o は落ちる',
    (tag) => {
      expectRejected(valid({ tags: [tag] }), 'tags');
    },
  );

  it.each([[[]], [['aws']], [['aws', 'cdk']], [['node-24']]])('タグ %j は通る', (tags) => {
    expect(validatePost(valid({ tags }), NOW_MS).tags).toEqual(tags);
  });

  it('既定は空配列', () => {
    expect(validatePost(valid(), NOW_MS).tags).toEqual([]);
  });

  it('配列でないとき落ちる', () => {
    for (const tags of ['aws', 42, {}]) expectRejected(valid({ tags }), 'tags');
  });
});

describe('title と description', () => {
  it.each([undefined, null, '', '   ', '\n', '\t', 42])('title が %o なら落ちる', (title) => {
    expectRejected(valid({ title }), 'title');
  });

  it.each([undefined, null, '', '   ', 42])('description が %o なら落ちる', (description) => {
    expectRejected(valid({ description }), 'description');
  });

  it('空白のみを弾くのは postSchema の min(1) と揃えるため', () => {
    // Zod の min(1) は ' ' を通すが、それは site 側の穴であって api が広げる理由にはならない。
    // **api の検証は site と同等かより厳しい**という関係を保つ。
    expectRejected(valid({ title: ' ' }), 'title');
  });

  it('前後の空白を落として保持する', () => {
    const post = validatePost(valid({ title: '  タイトル  ' }), NOW_MS);
    expect(post.title).toBe('タイトル');
  });
});

describe('pubDate', () => {
  it('渡さないとき注入したクロックの現在時刻が ISO 8601 で入る', () => {
    const post = validatePost(valid(), NOW_MS);
    expect(post.pubDate).toBe(new Date(NOW_MS).toISOString());
    expect(post.pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('渡したときはそれが使われる', () => {
    const post = validatePost(valid({ pubDate: '2020-01-02T03:04:05.000Z' }), NOW_MS);
    expect(post.pubDate).toBe('2020-01-02T03:04:05.000Z');
  });

  it('日付として読めない文字列は落ちる', () => {
    for (const pubDate of ['not a date', '', 42, {}]) {
      expectRejected(valid({ pubDate }), 'pubDate');
    }
  });
});

describe('draft', () => {
  it('既定が false（postSchema の default(false) と一致）', () => {
    expect(validatePost(valid(), NOW_MS).draft).toBe(false);
  });

  it('true を渡せる', () => {
    expect(validatePost(valid({ draft: true }), NOW_MS).draft).toBe(true);
  });

  it('真偽値でないとき落ちる（"false" 文字列を true と解釈しない）', () => {
    expectRejected(valid({ draft: 'false' }), 'draft');
    expectRejected(valid({ draft: 1 }), 'draft');
  });
});

describe('body', () => {
  it('文字列でないとき落ちる', () => {
    for (const body of [undefined, null, 42, {}]) expectRejected(valid({ body }), 'body');
  });

  it('空文字は通る（本文なしの記事を禁じる理由が無い）', () => {
    expect(validatePost(valid({ body: '' }), NOW_MS).body).toBe('');
  });
});

describe('例外', () => {
  it('メッセージに入力値をそのまま含めない', () => {
    // 誤って本文に貼られた資格情報がエラー応答やログに出る事故を防ぐ。
    const secret = 'ghp_SECRET_IN_TITLE_0123456789';
    const error = expectRejected(valid({ title: ' ', description: secret }), 'title');
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(secret);
  });

  it('どのフィールドが悪いかは分かる', () => {
    expect(expectRejected(valid({ slug: 'A' })).field).toBe('slug');
    expect(expectRejected(valid({ tags: ['A'] })).field).toBe('tags');
    expect(expectRejected(valid({ pubDate: 'x' })).field).toBe('pubDate');
  });
});
