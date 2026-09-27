/**
 * 記事スラッグの形と、投稿日時からの導出。
 *
 * **依存ゼロの純粋 TypeScript として保つこと。** `admin/src/editor/model.ts` が
 * このモジュールを直接 import しているので、`node:` の builtin を import した瞬間に
 * admin のビルドが壊れる。
 */

/**
 * 記事リポジトリ分離前から使ってきた平坦スラッグの形。
 *
 * **`validate.ts` の `SLUG_PATTERN` と同じ正規表現である。** 意図的な重複で、
 * `api/test/unit/post-slug.test.ts` が `source` と `flags` の一致を機械で固定している。
 *
 * ここに置いた理由は循環 import を作らないため。この先 `validate.ts` は
 * `dateSlug` を使う側になる（slug が入力ではなく pubDate からの導出になる）ので、
 * 依存の向きは **validate → slug の一方向**でなければならない。
 * 逆向きに import すると、モジュール初期化順によって正規表現が TDZ で undefined になる。
 */
export const FLAT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 投稿日時から導出する日付パスの形。`YYYY/MM/DD/HHmmss`。
 *
 * **桁数を固定し、ゼロ埋めを必須にしている。** `2026/9/8/54001` を許すと、
 * 同じ時刻から 2 通りのスラッグが作れてしまい、`/posts/<slug>/` が一意でなくなる。
 *
 * ドットを含まないので `infra/functions/rewrite-uri.js` の
 * 「最終セグメントにドットがあれば静的ファイル」判定に引っかからない。
 * CloudFront Function は階層の深さを見ないので、平坦スラッグと同じく
 * `/index.html` が付く。
 */
export const DATE_SLUG_PATTERN = /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9]{6}$/;

/**
 * 両端のアンカーを外して、和に埋め込める形にする。
 *
 * **アンカーを検査してから外す。** 片側しか無い正規表現を黙って切り詰めると、
 * 和にしたときに部分一致を許す形（= traversal を通す形）に化けうる。
 */
const withoutAnchors = (pattern: RegExp): string => {
  const { source } = pattern;
  if (!source.startsWith('^') || !source.endsWith('$')) {
    throw new Error('slug pattern must be anchored at both ends');
  }
  return source.slice(1, -1);
};

/**
 * 記事スラッグとして正当な形。**平坦スラッグと日付パスの和。**
 *
 * 和をリテラルで書き直さず両者から組み立てるのは、3 つ目の写しを作らないため。
 * 片方を変えれば和も自動的に追随する。
 *
 * **両辺が strict allowlist なので `..` を表現できない。** これがパストラバーサル対策の
 * 根拠で、`commit.ts` の `pathForSlug` はこのパターンだけに頼って封じ込めを主張している。
 * 「`../` を除去する」blocklist 方式は `....//` のような入力で破れるので採らない。
 */
export const POST_SLUG_PATTERN = new RegExp(
  `^(?:${withoutAnchors(FLAT_SLUG_PATTERN)}|${withoutAnchors(DATE_SLUG_PATTERN)})$`,
);

/**
 * 日本標準時のオフセット。
 *
 * **`Intl` を使わず固定オフセットで計算する。** 日本には夏時間が無く、1951 年の
 * 廃止以降 +09:00 から動いていない。ICU データに依存しないほうが、Lambda・ブラウザ・
 * CI のどこで走っても同じ答えになる（node は full-icu 同梱だが、それは実装の都合であって
 * 契約ではない）。
 *
 * 黙ってずれないよう、`post-slug.test.ts` が同じ入力を
 * `Intl.DateTimeFormat(timeZone: 'Asia/Tokyo')` と突き合わせている。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `JST_OFFSET_MS` を ISO 8601 のオフセット表記で書いたもの。 */
export const JST_OFFSET_SUFFIX = '+09:00';

/**
 * ISO 8601 の日時に**明示的なオフセットが付いているか**。
 *
 * # なぜ要るか
 *
 * `Date.parse('2026-09-08T05:40:01')` は**オフセットの無い日時をホストの
 * タイムゾーンで解釈する**。`<input type="datetime-local">` が返すのはまさにこの形で、
 * ブラウザは著者の TZ、Lambda は UTC なので、**同じ入力から違う瞬間ができる**。
 *
 * 実測（`2026-09-08T05:40:01` を dateSlug に通した結果）:
 *
 * ```
 * TZ=Asia/Tokyo        2026/09/08/054001
 * TZ=UTC               2026/09/08/144001
 * TZ=America/New_York  2026/09/08/184001
 * ```
 *
 * **公開先の URL が著者の居場所で変わってはいけない**（RSS の guid も変わる）。
 * だから曖昧な形は入口で拒み、admin 側で `jstWallClockToInstant` を通させる。
 *
 * 日付だけ（`2026-09-08`）も false にする。ES の仕様では UTC 扱いだが、
 * 「著者が何時のつもりだったか」は表現されていないので、推測しない。
 */
const EXPLICIT_OFFSET_PATTERN =
  /T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:[Zz]|[+-][0-9]{2}(?::?[0-9]{2})?)$/;

export const hasExplicitOffset = (value: string): boolean => EXPLICIT_OFFSET_PATTERN.test(value);

/**
 * 著者が入力した**壁時計時刻を JST の瞬間として**読める文字列にする。
 *
 * **「ブラウザのローカル時刻の瞬間」として送る案は採らない。** JST の著者では同じ
 * 結果になるが、旅行先や UTC のランナーで書いた日に公開先が変わる。
 * **ブログの日付が著者の居場所で変わるのは筋が悪い** — 利用者が選んだ
 * 「タイムゾーンは Asia/Tokyo」という決定は、まさにそれを避けるためのもの。
 *
 * 既にオフセットがあるものは触らない（二重に付けない）。
 */
export const jstWallClockToInstant = (wallClock: string): string =>
  hasExplicitOffset(wallClock) ? wallClock : `${wallClock}${JST_OFFSET_SUFFIX}`;

/**
 * 投稿日時から日付パスのスラッグを作る。
 *
 * @param pubDateIso ISO 8601。`validatePost` が正規化した `pubDate` を渡す。
 * @returns `DATE_SLUG_PATTERN` に合致する文字列。
 *
 * **UTC の日付ではなく JST の日付になる。** 20:40Z の投稿は JST では翌日 05:40 なので
 * `2026/09/08/054001` になる。UTC のまま扱うと、深夜・早朝の投稿だけ URL の日付が
 * 前日にずれて、書いた本人の体感と食い違う。
 */
export const dateSlug = (pubDateIso: string): string => {
  const epochMs = Date.parse(pubDateIso);
  if (Number.isNaN(epochMs)) throw new Error('pubDate must be a valid date');

  // +09:00 した瞬間を UTC として書き出すと、桁が JST の壁時計と一致する。
  const wallClock = new Date(epochMs + JST_OFFSET_MS).toISOString();
  const [date, time] = wallClock.split('T');
  const slug = `${date.replaceAll('-', '/')}/${time.slice(0, 8).replaceAll(':', '')}`;

  // **契約を自分で検査する。** toISOString は 9999 年を超えると `+275760-09-13...` の
  // ような拡張表記を返すので、桁が崩れた値を黙ってパスにしない。
  if (!DATE_SLUG_PATTERN.test(slug)) {
    throw new Error('pubDate is outside the range that produces a dated slug');
  }
  return slug;
};
