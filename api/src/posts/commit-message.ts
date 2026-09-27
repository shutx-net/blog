/**
 * 投稿のコミットメッセージ。
 *
 * **slug を 1 行目に使わない。** slug は `pubDate` から導出した日付パスなので、
 * `feat(site): 記事 2026/09/08/054001 を追加` になり **履歴から中身が読めない**。
 * title を使う。
 *
 * **依存ゼロの純粋 TypeScript として保つこと。** `posts/` 配下は admin のバンドルに
 * そのまま入る経路があり、`node:` の builtin を import した瞬間にブラウザのビルドが壊れる。
 */

/** Conventional Commits のプレフィックス。 */
const PREFIX = 'feat(site): ';

/**
 * 1 行目の上限（コードポイント数）。
 *
 * AGENTS.md の「1 行目は 50 字程度に収める」に合わせる。`String.length` ではなく
 * コードポイントで数えるのは、和文と絵文字を UTF-16 の単位で数えると見た目と
 * 大きくずれるため。
 */
export const SUBJECT_MAX_LENGTH = 50;

/** 切り詰めたことを示す記号。 */
const ELLIPSIS = '…';

/**
 * title を囲む装飾。**予算計算に使うので、文言を変えたらここだけ直せば済む形にしてある。**
 *
 * 一番長い語（`を追加` と `を更新` は同じ長さ）で見積もる。
 */
const DECORATION = '記事「」を追加';

/**
 * title は利用者の自由入力なので、そのまま 1 行目に置けない。
 *
 * **畳むのは改行だけではない。** ` ` / ` ` は JS のソースでは行終端子だが
 * ここでは単なる空白として扱えばよく、タブと連続空白も 1 つに潰しておくと
 * `git log --oneline` の見た目が安定する。
 *
 * **切り詰めは `Array.from` を通してから行う。** 素の `slice` はサロゲートペアを
 * 半分で割り、不正な UTF-16 を GitHub に送りうる。
 */
export const foldSubjectTitle = (title: string): string => {
  const folded = title.replace(/\s+/gu, ' ').trim();

  // プレフィックスと装飾（`記事「」を追加` = 7 文字）を差し引いた残りが title の予算。
  const budget = SUBJECT_MAX_LENGTH - [...PREFIX].length - [...DECORATION].length;
  const points = [...folded];
  if (points.length <= budget) return folded;

  return `${points.slice(0, budget - [...ELLIPSIS].length).join('')}${ELLIPSIS}`;
};

/** 作成時と更新時の 1 行目。**どちらが使われるかは publisher が決める。** */
export interface CommitMessages {
  createMessage: string;
  replaceMessage: string;
}

/**
 * 投稿のコミットメッセージを組む。
 *
 * @param title `validatePost` が trim した title。
 */
export const commitMessages = (title: string): CommitMessages => {
  const subject = foldSubjectTitle(title);
  return {
    createMessage: `${PREFIX}記事「${subject}」を追加`,
    replaceMessage: `${PREFIX}記事「${subject}」を更新`,
  };
};
