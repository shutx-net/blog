/**
 * 既存記事の一覧の描画。**DOM を組むだけで、取得も送信もしない。**
 *
 * `api/src/deps.ts` の `PostSummary` を型として受けたいが、あのモジュールは
 * `./auth.ts` 経由で `aws-jwt-verify` を引き込む。`import type` は
 * `verbatimModuleSyntax` で完全に消えるので実害は無いが、値 import に書き換えた
 * 日に気づけない。**必要な 4 つだけをここで宣言し、綴りの一致は
 * test/contract/post-summary-shape.test.ts が見る。**
 */
export interface PostListEntry {
  /** `DATE_SLUG_PATTERN` に合致する日付パス。 */
  slug: string;
  title: string;
  draft: boolean;
  /** ISO の実値。`<time datetime>` にそのまま入れる。 */
  pubDate: string;
}

/** 記事が 1 本も無いときの文言。 */
export const EMPTY_POST_LIST_MESSAGE = 'まだ記事が無い';

/** 下書きのバッジ。**色ではなく文字で示す。** */
const DRAFT_BADGE = '下書き';

/** 編集ボタンの文字。 */
const EDIT_LABEL = '編集';

/**
 * 行に付ける操作。**このモジュールは何も呼ばない** — 押されたことを外へ渡すだけ。
 *
 * 省略すると読み取り専用の一覧になる（一覧だけを出したい経路を壊さない）。
 */
export interface PostListActions {
  onEdit(slug: string): void;
}

/**
 * slug の日付部分（`2026/09/27`）。
 *
 * **新しい書式化関数を増やさない。** slug は日本時間の壁時計をそのまま並べた
 * ものなので、ここから切り出せば時差でずれない。`pubDate` を自分で書式化すると
 * `publishPathLabel` と二重の実装になり、いつか片方だけ直る。
 */
const dateLabel = (slug: string): string => slug.split('/').slice(0, 3).join('/');

/**
 * 1 行。**`textContent` だけで組む。**
 *
 * `#preview` 以外に `innerHTML` を使わないのがこのアプリの境界。title は自分で
 * 書いた値だが、境界に例外を作らない（例外がある境界は、次に触る人には無い）。
 */
const renderEntry = (post: PostListEntry, actions: PostListActions | undefined): HTMLLIElement => {
  const item = document.createElement('li');
  item.dataset['slug'] = post.slug;
  item.className = 'post-list__item';

  const time = document.createElement('time');
  time.dateTime = post.pubDate;
  time.textContent = dateLabel(post.slug);
  time.className = 'post-list__date';

  const title = document.createElement('span');
  title.textContent = post.title;
  title.className = 'post-list__title';

  item.append(time, title);

  if (post.draft) {
    const badge = document.createElement('span');
    badge.textContent = DRAFT_BADGE;
    badge.className = 'post-list__draft';
    item.append(badge);
  }

  if (actions !== undefined) {
    const edit = document.createElement('button');
    // **type を明示する。** 既定の submit だと、フォームの外にあっても
    // Enter の扱いが紛らわしくなる（index.html の #post-list-reload と同じ理由）。
    edit.type = 'button';
    edit.textContent = EDIT_LABEL;
    edit.className = 'post-list__edit';
    edit.dataset['slug'] = post.slug;
    // **addEventListener で配線する。** on*= 属性は CSP の
    // `script-src-attr 'none'` で動かない。
    edit.addEventListener('click', () => {
      actions.onEdit(post.slug);
    });
    item.append(edit);
  }

  return item;
};

/**
 * `container` の中身を一覧で置き換える。
 *
 * 並びは pubDate の降順（新しいものが上）。**渡された配列は並べ替えない** —
 * 呼び出し側が同じ配列を他の用途に使っても壊れないようにする。
 */
export const renderPostList = (
  container: Element,
  posts: readonly PostListEntry[],
  actions?: PostListActions,
): void => {
  if (posts.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = EMPTY_POST_LIST_MESSAGE;
    empty.className = 'post-list__empty';
    container.replaceChildren(empty);
    return;
  }

  const ordered = [...posts].sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
  container.replaceChildren(...ordered.map((post) => renderEntry(post, actions)));
};
