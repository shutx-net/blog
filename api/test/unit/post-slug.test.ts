import { describe, expect, it } from 'vitest';

import {
  DATE_SLUG_PATTERN,
  JST_OFFSET_MS,
  JST_OFFSET_SUFFIX,
  dateSlug,
  hasExplicitOffset,
  jstWallClockToInstant,
} from '../../src/posts/slug.ts';

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
    'posts/hello-world', // 平坦スラッグ時代に同じ事故が起きた形
    '2026/09/054001', // 階層が 1 つ足りない
    '2026/09/08/09/054001', // 階層が 1 つ多い
    '26/09/08/054001', // 年が 2 桁
    '2026/9/8/54001', // ゼロ埋めなし
    '2026/09/08/05400', // 時刻が 5 桁
    '2026/09/08/0540011', // 時刻が 7 桁
    '/2026/09/08/054001', // 先頭スラッシュ
    '2026/09/08/054001/', // 末尾スラッシュ
    '2026/09/08/054001/extra', // 余分な階層
    'hello-world', // **撤廃した平坦スラッグ**
    'node-24.19-notes', // ドット入り。CloudFront Function が index.html を付けない
    '', // 空
    '.', // ドット単体
    '..',
    '../../etc/passwd',
    './x',
    'a/b',
    'a\\b',
    'Hello-World', // 大文字
    'a b', // 空白
  ])('%o を拒む', (slug) => {
    expect(DATE_SLUG_PATTERN.test(slug)).toBe(false);
  });

  it('**strict allowlist なので traversal を表現できない**', () => {
    // '..' を含む入力は、どんな組み合わせでも通らない。パス封じ込めの根拠。
    for (const slug of ['..', 'a/../b', '....//', '2026/09/../08/054001', 'a/..']) {
      expect(DATE_SLUG_PATTERN.test(slug)).toBe(false);
    }
  });
});

describe('hasExplicitOffset', () => {
  it.each([
    '2026-09-08T05:40:01.000Z',
    '2026-09-08T05:40:01Z',
    '2026-09-08T05:40:01+09:00',
    '2026-09-08T05:40:01-05:00',
    '2026-09-08T05:40+09:00',
    '2026-09-08T05:40:01+0900',
    '2026-09-08T05:40:01+09',
  ])('%o はオフセットを持つ', (value) => {
    expect(hasExplicitOffset(value)).toBe(true);
  });

  it.each([
    // **`<input type="datetime-local">` が返す形。** これが曖昧さの入口だった。
    '2026-09-08T05:40:01',
    '2026-09-08T05:40',
    // 日付だけも拒む。仕様では UTC 扱いだが、著者の意図としては曖昧。
    '2026-09-08',
    '',
    'not a date',
    '2026-09-08 05:40:01',
  ])('%o はオフセットを持たない', (value) => {
    expect(hasExplicitOffset(value)).toBe(false);
  });
});

describe('jstWallClockToInstant', () => {
  it('**オフセットの無い壁時計に +09:00 を付ける**', () => {
    expect(jstWallClockToInstant('2026-09-08T05:40:01')).toBe('2026-09-08T05:40:01+09:00');
  });

  it('秒が無い形（datetime-local の既定）でも付く', () => {
    expect(jstWallClockToInstant('2026-09-08T05:40')).toBe('2026-09-08T05:40+09:00');
  });

  it('既にオフセットがあるものは触らない', () => {
    // 復元された下書きや、別の経路から来た値を二重に変換しない。
    for (const value of ['2026-09-08T05:40:01.000Z', '2026-09-08T05:40:01+09:00']) {
      expect(jstWallClockToInstant(value)).toBe(value);
    }
  });

  it('**結果がホストのタイムゾーンに依存しない**', () => {
    // dateSlug に通したときの答えが 1 つに決まることが、この関数の存在理由。
    const instant = jstWallClockToInstant('2026-09-08T05:40:01');
    expect(new Date(Date.parse(instant)).toISOString()).toBe('2026-09-07T20:40:01.000Z');
    expect(dateSlug(instant)).toBe('2026/09/08/054001');
  });

  it('JST_OFFSET_SUFFIX が JST_OFFSET_MS と同じ値を表している', () => {
    // 片方だけ直すと、表示と実際の公開先が静かに食い違う。
    const hours = JST_OFFSET_MS / 3_600_000;
    expect(JST_OFFSET_SUFFIX).toBe(`+${String(hours).padStart(2, '0')}:00`);
  });

  it('壊れた文字列は付けても壊れたまま（dateSlug が投げる）', () => {
    expect(() => dateSlug(jstWallClockToInstant('not a date'))).toThrow();
  });
});
