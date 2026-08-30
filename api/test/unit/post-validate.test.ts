import { describe, expect, it } from 'vitest';
import { PostValidationError, SLUG_PATTERN, TAG_PATTERN, validatePost } from '../../src/posts/validate.ts';

const NOW_MS = Date.UTC(2026, 7, 30, 12, 34, 56);

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'hello-world',
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

describe('slug', () => {
  it('**ドットを含むと落ちる**', () => {
    // infra/functions/rewrite-uri.js の URI 書き換えは「最後のスラッシュより後に
    // ドットがあれば静的ファイル」というヒューリスティックなので、
    // /posts/node-24.19-notes には /index.html が付かず 403 になる。
    // これまで人間の規律でしか守られていなかったものを、ここで機械化する。
    expectRejected(valid({ slug: 'node-24.19-notes' }), 'slug');
    expectRejected(valid({ slug: 'a.b' }), 'slug');
    expectRejected(valid({ slug: 'x.' }), 'slug');
    expectRejected(valid({ slug: '.x' }), 'slug');
  });

  it.each([
    '../etc/passwd',
    'a/b',
    'UPPER',
    'Mixed-Case',
    '',
    'a..b',
    '-leading',
    'trailing-',
    'two--hyphens',
    'ja日本語',
    'with space',
    'under_score',
    'a'.repeat(201),
  ])('%o は落ちる', (slug) => {
    expectRejected(valid({ slug }), 'slug');
  });

  it.each(['a', 'hello', 'hello-world', 'node-24-notes', 'a1-b2-c3'])('%o は通る', (slug) => {
    expect(validatePost(valid({ slug }), NOW_MS).slug).toBe(slug);
  });

  it('slug が文字列でないとき落ちる', () => {
    for (const slug of [undefined, null, 42, {}, ['a']]) {
      expectRejected(valid({ slug }), 'slug');
    }
  });

  it('SLUG_PATTERN がドットを許さない', () => {
    expect(SLUG_PATTERN.test('a.b')).toBe(false);
    expect(SLUG_PATTERN.test('ab')).toBe(true);
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
    const error = expectRejected(valid({ slug: secret }));
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(secret);
  });

  it('どのフィールドが悪いかは分かる', () => {
    expect(expectRejected(valid({ slug: 'A' })).field).toBe('slug');
    expect(expectRejected(valid({ tags: ['A'] })).field).toBe('tags');
  });
});
