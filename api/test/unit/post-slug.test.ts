import { describe, expect, it } from 'vitest';

import {
  DATE_SLUG_PATTERN,
  FLAT_SLUG_PATTERN,
  JST_OFFSET_MS,
  POST_SLUG_PATTERN,
  dateSlug,
} from '../../src/posts/slug.ts';
import { SLUG_PATTERN } from '../../src/posts/validate.ts';

/**
 * Intl から組んだ期待値。**実装はこれを使わない。**
 *
 * 実装は +09:00 の固定オフセット算術で、ICU データに依存しない。ここで突き合わせるのは、
 * その割り切りが黙ってずれないことを固定するため。日本に DST は無いので両者は常に一致する
 * はずで、一致しなくなったらどちらかの前提が壊れている。
 *
 * hourCycle: 'h23' を明示するのは、既定の h24 だと真夜中が '24' になり
 * '2026/09/08/240000' のような値が出るため。
 */
const intlDateSlug = (iso: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('year')}/${at('month')}/${at('day')}/${at('hour')}${at('minute')}${at('second')}`;
};

/**
 * 境界値。**UTC の日付と JST の日付が食い違う時刻を必ず含める。**
 *
 * 利用者が実際に踏んだのがこれで、20:40 UTC の投稿は JST では翌日 05:40 になる。
 * オフセットを落とした実装は、この行だけが赤くなる。
 */
const BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  // 実際の投稿（2026-09-07T20:40:01.277Z）。UTC は 9/7、JST は 9/8。
  ['2026-09-07T20:40:01.277Z', '2026/09/08/054001'],
  // JST のちょうど 0 時。UTC では前日の 15:00。
  ['2026-09-07T15:00:00.000Z', '2026/09/08/000000'],
  // その 1 ミリ秒前。日付が繰り上がってはいけない。
  ['2026-09-07T14:59:59.999Z', '2026/09/07/235959'],
  // 年またぎ。UTC では 2026 年、JST では 2027 年。
  ['2026-12-31T15:00:00.000Z', '2027/01/01/000000'],
  // 昼。UTC と JST で日付が一致する側の対照。
  ['2026-09-08T03:00:00.000Z', '2026/09/08/120000'],
];

describe('dateSlug', () => {
  it.each(BOUNDARIES)('%s → %s', (iso, expected) => {
    expect(dateSlug(iso)).toBe(expected);
  });

  it.each(BOUNDARIES.map(([iso]) => iso))('%s が Intl(Asia/Tokyo) と一致する', (iso) => {
    expect(dateSlug(iso)).toBe(intlDateSlug(iso));
  });

  it('JST_OFFSET_MS が 9 時間ちょうどである', () => {
    expect(JST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });

  it('出力が必ず DATE_SLUG_PATTERN に合致する', () => {
    for (const [iso] of BOUNDARIES) {
      expect(dateSlug(iso)).toMatch(DATE_SLUG_PATTERN);
    }
  });

  it('日付として解釈できない入力は例外になる', () => {
    // 黙って 'NaN/NaN/NaN/NaNNaNNaN' のようなパスを作らせない。
    expect(() => dateSlug('not a date')).toThrow();
    expect(() => dateSlug('')).toThrow();
  });
});

describe('DATE_SLUG_PATTERN', () => {
  it.each(['2026/09/08/054001', '2026/01/01/000000', '2027/12/31/235959'])(
    '%o を通す',
    (slug) => {
      expect(DATE_SLUG_PATTERN.test(slug)).toBe(true);
    },
  );

  it.each([
    'posts/2026/09/08/054001', // **元の事故と同じ形**（content repo のルートを降ろした）
    '2026/09/054001', // 階層が 1 つ足りない
    '2026/09/08/09/054001', // 階層が 1 つ多い
    '26/09/08/054001', // 年が 2 桁
    '2026/9/8/54001', // ゼロ埋めなし
    '2026/09/08/05400', // 時刻が 5 桁
    '2026/09/08/0540011', // 時刻が 7 桁
    '/2026/09/08/054001', // 先頭スラッシュ
    '2026/09/08/054001/', // 末尾スラッシュ
    'hello-world', // 平坦スラッグ
  ])('%o を拒む', (slug) => {
    expect(DATE_SLUG_PATTERN.test(slug)).toBe(false);
  });
});

describe('POST_SLUG_PATTERN', () => {
  it.each(['hello-world', 'node-24-notes', 'a', '2026/09/08/054001'])('%o を通す', (slug) => {
    expect(POST_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each([
    'posts/hello-world', // **元の事故**（記事が 1 階層深くなった）
    'posts/2026/09/08/054001', // 日付パス時代に同じ事故が起きた形
    '..',
    '../../etc/passwd',
    './x',
    'a/b',
    'a\\b',
    '', // 空
    '.', // ドット単体
    'node-24.19-notes', // **ドット入り。CloudFront Function が index.html を付けない**
    'Hello-World', // 大文字
    'a b', // 空白
    '2026/09/08/054001/extra',
  ])('%o を拒む', (slug) => {
    expect(POST_SLUG_PATTERN.test(slug)).toBe(false);
  });

  it('日付パスと平坦スラッグのどちらかに必ず還元される', () => {
    // POST_SLUG_PATTERN が「和である」ことを構造で主張する。片方を落とす変異を捕まえる。
    for (const slug of ['hello-world', '2026/09/08/054001']) {
      const byUnion = POST_SLUG_PATTERN.test(slug);
      const byParts = FLAT_SLUG_PATTERN.test(slug) || DATE_SLUG_PATTERN.test(slug);
      expect(byUnion).toBe(byParts);
      expect(byUnion).toBe(true);
    }
  });

  it('**両辺が strict allowlist なので traversal を表現できない**', () => {
    // '..' を含む入力は、どんな組み合わせでも通らない。パス封じ込めの根拠。
    for (const slug of ['..', 'a/../b', '....//', '2026/09/../08/054001', 'a/..']) {
      expect(POST_SLUG_PATTERN.test(slug)).toBe(false);
    }
  });
});

describe('FLAT_SLUG_PATTERN と validate.ts の SLUG_PATTERN', () => {
  /**
   * **同じ正規表現が 2 か所にある状態を機械で固定する。**
   *
   * slug.ts に置いたのは、Phase 3 で validate.ts が dateSlug を使う側になるため
   * （validate → slug の一方向にして循環 import を作らない）。それまでの間の重複を
   * ここで縛っておく。片方だけ直したらこのテストが落ちる。
   */
  it('source が 1 文字も違わない', () => {
    expect(FLAT_SLUG_PATTERN.source).toBe(SLUG_PATTERN.source);
  });

  it('flags も一致する', () => {
    expect(FLAT_SLUG_PATTERN.flags).toBe(SLUG_PATTERN.flags);
  });
});
