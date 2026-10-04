/**
 * 「この操作のあとサイトに公開記事が残るか」の判定。
 *
 * **依存ゼロの純関数として保つこと。** `PostSummary` の一部だけを構造的に受けるので、
 * `deps.ts` を import しない（あれは `auth.ts` 経由で `aws-jwt-verify` を引き込む）。
 *
 * # なぜ「総数」ではなく「公開可能数」なのか
 *
 * `deploy.yml` の 3 つのガードが数えているものは同一ではない。実測（2026-09-27）:
 *
 *   ガード1（記事本数）   `find -name '*.md' | wc -l` で **draft 込み**
 *   ガード2（rss item）   公開分のみ
 *   ガード3（スラッグ照合）`expected` = **draft を除いた**集合の要素数
 *
 * draft 1 本だけのディレクトリで走らせるとガード1 は exit 0、ガード3 は exit 1 になる。
 * つまり**拘束条件は「公開可能 >= 1」**で、「総数 >= 1」より厳しい。
 *
 * **公開 1 本 + draft 3 本で、その公開 1 本を削除すると、総数は 3 残るのに
 * デプロイが落ちる。** API が「総数」で判定すると、許可したのにデプロイが止まる
 * — 利用者から見て最も分かりにくい壊れ方になる。
 *
 * # なぜ deploy.yml の数字を読まないのか
 *
 * 読むと「下限が 0 になったとき床も 0 になる」空振りを作る。`deploy.yml` 側も
 * 同じ理由で整数リテラルにしてある。**両者が一致することは
 * `infra/test/workflow-deploy-steps.test.ts` の
 * `describe('api の床と deploy.yml のガードの一致')` が突き合わせる。**
 */

/** 床の判定に要る最小の形。`PostSummary` はこれを満たす。 */
export interface FloorPost {
  slug: string;
  draft: boolean;
}

/** 記事に対する操作。**pubDate は変えられないので slug は不変。** */
export type PostChange =
  | { kind: 'delete'; slug: string }
  | { kind: 'update'; slug: string; draft: boolean };

/**
 * 操作後に残っていなければならない公開記事の数。**整数リテラル。**
 *
 * `deploy.yml` の 3 つの `minimum` と同じ値でなければならない。
 */
export const PUBLISHABLE_MINIMUM = 1;

/**
 * 対象の記事が存在しないときの例外。
 *
 * **メッセージに slug を載せない**（api の他の例外と同じ規律）。
 */
export class UnknownSlugError extends Error {
  constructor() {
    super('the post to change is not in the given list');
    this.name = 'UnknownSlugError';
  }
}

/** 公開される記事の数。**draft は数えない。** */
export const countPublishable = (posts: readonly FloorPost[]): number =>
  posts.filter((post) => !post.draft).length;

/**
 * この操作でサイトの公開記事が床を割るか。
 *
 * **「今より悪くならないか」ではなく「操作後に床を満たすか」で見る。**
 * すでに床を割っている状態（`blog-content` を手で編集すれば作れる）から
 * さらに削ることを許すと、デプロイが落ち続ける状態に踏み込める。
 *
 * 対象が一覧に無ければ throw する。**黙って許可に倒さない** — 倒すと
 * 「拒否されないのにデプロイが落ちる」状態になる。
 */
export const wouldStarveSite = (posts: readonly FloorPost[], change: PostChange): boolean => {
  const target = posts.find((post) => post.slug === change.slug);
  if (target === undefined) throw new UnknownSlugError();

  const after =
    change.kind === 'delete'
      ? posts.filter((post) => post.slug !== change.slug)
      : posts.map((post) => (post.slug === change.slug ? { ...post, draft: change.draft } : post));

  return countPublishable(after) < PUBLISHABLE_MINIMUM;
};
