import { describe, expect, it } from 'vitest';

import {
  PUBLISHABLE_MINIMUM,
  UnknownSlugError,
  countPublishable,
  wouldStarveSite,
} from '../../src/posts/publishable-floor.ts';
import type { FloorPost } from '../../src/posts/publishable-floor.ts';

const post = (slug: string, draft = false): FloorPost => ({ slug, draft });

const PUBLISHED = post('2026/09/27/142621');
const ANOTHER = post('2026/09/28/090000');
const DRAFT_A = post('2026/08/01/090000', true);
const DRAFT_B = post('2026/08/02/090000', true);
const DRAFT_C = post('2026/08/03/090000', true);

describe('公開可能数の床', () => {
  it('下限は 1（整数リテラル）', () => {
    expect(PUBLISHABLE_MINIMUM).toBe(1);
  });

  it('countPublishable は draft を数えない', () => {
    expect(countPublishable([PUBLISHED, DRAFT_A, DRAFT_B])).toBe(1);
    expect(countPublishable([DRAFT_A, DRAFT_B])).toBe(0);
    expect(countPublishable([])).toBe(0);
  });

  it('公開 1 本だけのとき、その 1 本の削除は拒否', () => {
    expect(wouldStarveSite([PUBLISHED], { kind: 'delete', slug: PUBLISHED.slug })).toBe(true);
  });

  it('公開 2 本のとき、1 本の削除は許可', () => {
    expect(wouldStarveSite([PUBLISHED, ANOTHER], { kind: 'delete', slug: PUBLISHED.slug })).toBe(
      false,
    );
  });

  it('**公開 1 本 + draft 3 本で、その公開 1 本の削除は拒否**（総数は 3 残るのに拒否する）', () => {
    // ガード1（本数、draft 込み）は 3 本で通るが、ガード2（rss item）と
    // ガード3（公開分の集合）は 0 本で落ちる。**拘束するのは公開可能数。**
    const posts = [PUBLISHED, DRAFT_A, DRAFT_B, DRAFT_C];
    expect(countPublishable(posts)).toBe(1);
    expect(wouldStarveSite(posts, { kind: 'delete', slug: PUBLISHED.slug })).toBe(true);
  });

  it('draft の削除は、公開が 1 本残るなら許可', () => {
    expect(wouldStarveSite([PUBLISHED, DRAFT_A], { kind: 'delete', slug: DRAFT_A.slug })).toBe(
      false,
    );
  });

  it('**公開が 0 本のまま draft を削除するのも拒否**（すでに床を割っている）', () => {
    // 手で `blog-content` を直接編集すると起こりうる状態。
    // 「今より悪くならない」ではなく「操作後に床を満たすか」で判定する。
    expect(wouldStarveSite([DRAFT_A, DRAFT_B], { kind: 'delete', slug: DRAFT_A.slug })).toBe(true);
  });

  it('**最後の公開記事を draft: true にする更新も拒否**（編集でも床が要る）', () => {
    expect(
      wouldStarveSite([PUBLISHED, DRAFT_A], { kind: 'update', slug: PUBLISHED.slug, draft: true }),
    ).toBe(true);
  });

  it('公開記事を公開のまま更新するのは許可', () => {
    expect(
      wouldStarveSite([PUBLISHED], { kind: 'update', slug: PUBLISHED.slug, draft: false }),
    ).toBe(false);
  });

  it('draft を公開に変える更新は、床を満たすので許可', () => {
    expect(wouldStarveSite([DRAFT_A], { kind: 'update', slug: DRAFT_A.slug, draft: false })).toBe(
      false,
    );
  });

  it('公開 2 本のうち 1 本を draft にするのは許可', () => {
    expect(
      wouldStarveSite([PUBLISHED, ANOTHER], { kind: 'update', slug: ANOTHER.slug, draft: true }),
    ).toBe(false);
  });

  it('**存在しない slug は throw する**（黙って許可に倒さない）', () => {
    // 許可に倒すと、消えた記事を消そうとしたときに床の判定を飛ばして
    // 「拒否されないのにデプロイが落ちる」状態になる。
    expect(() => wouldStarveSite([PUBLISHED], { kind: 'delete', slug: 'nope' })).toThrow(
      UnknownSlugError,
    );
    expect(() =>
      wouldStarveSite([PUBLISHED], { kind: 'update', slug: 'nope', draft: false }),
    ).toThrow(UnknownSlugError);
  });

  it('**例外に slug を載せない**（api の他の例外と同じ規律）', () => {
    try {
      wouldStarveSite([PUBLISHED], { kind: 'delete', slug: 'secret-ish-slug' });
      expect.unreachable('throw しなかった');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-ish-slug');
    }
  });

  it('**依存ゼロ**（node 組み込みも他モジュールも import しない）', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../src/posts/publishable-floor.ts', import.meta.url),
      'utf8',
    );
    const imports = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\s.*\sfrom\s/.test(line));
    expect(imports).toEqual([]);
  });
});
