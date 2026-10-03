import { ApiError, createApiClient } from '../api/client.ts';
import type { ApiOperation } from '../api/client.ts';
import {
  UploadSizeMismatchError,
  UploadValidationError,
  checkUploadable,
  mediaMarkdown,
  presignMedia,
  uploadToPresignedUrl,
} from '../api/upload.ts';
import type { CallbackResult } from '../auth/callback.ts';
import type { AuthTransport } from '../auth/session.ts';
import type { SessionStore } from '../storage/session-store.ts';
import { bindEditor } from './bind.ts';
import { applyDraftToForm, clearDraft, loadDraft, saveDraft } from './draft-persistence.ts';
import { emptyDraft, postRequestBody, slugToWallClock, updateRequestBody, validateDraft } from './model.ts';
import type { DraftFields, EditTarget } from './model.ts';
import { renderPostList } from './post-list.ts';
import type { PostListEntry } from './post-list.ts';

const CREATE_POST: ApiOperation = { method: 'POST', path: '/api/posts' };
const UPDATE_POST: ApiOperation = { method: 'PUT', path: '/api/posts' };
const DELETE_POST: ApiOperation = { method: 'DELETE', path: '/api/posts' };
const LIST_POSTS: ApiOperation = { method: 'GET', path: '/api/posts' };
const GET_POST: ApiOperation = { method: 'GET', path: '/api/posts/detail' };

/** 送信ボタンの文字。**モードが見えることが要件。** */
const SUBMIT_CREATE = '公開する';
const SUBMIT_UPDATE = '更新する';

/** 一覧を読む前に出す文。**「0 件」と区別する。** */
const POST_LIST_IDLE = '「更新」を押すと既存の記事を読み込む';

/** 未認証で「更新」を押されたとき。**API は呼ばない。** */
const POST_LIST_SIGNED_OUT = 'ログインすると既存の記事を読み込める';

export interface AppDeps {
  root: HTMLElement;
  auth: AuthTransport;
  /** プレビュー関数。**注入することで DOM テストが決定的になる。** */
  renderPreview(markdown: string): Promise<string>;
  /** 注入するクロック。`Date.now()` を関数内で読まない。 */
  now(): number;
  /**
   * 下書きの保存先。**省略できる**（渡さなければ保存も復元もしない）。
   *
   * 保存できないことでエディタが使えなくなってはいけないので、
   * ストレージが投げる環境でも `store` 側が吸収する。
   */
  store?: SessionStore;
  origin?: string;
  fetchImpl?: typeof fetch;
  /**
   * 上書きの確認。**注入するのは `window.confirm` が jsdom で動かないから。**
   *
   * 省略時は `window.confirm`。**それも無ければ false**（上書きしない）に倒す。
   * 確認できない環境で「はい」と見なすと、公開済みの記事を黙って踏み潰す。
   */
  confirm?(message: string): boolean | Promise<boolean>;
  /**
   * 「ログイン」を押されたとき。**このモジュールは認可サーバを知らない。**
   * 本物（`beginSignIn`）を繋ぐのは `main.ts` だけ。
   */
  onSignIn?(): void | Promise<void>;
  /** 「サインアウト」を押されたとき。本物は `signOut`。 */
  onSignOut?(): void | Promise<void>;
  /**
   * 起動時の callback 処理の結果。
   *
   * **結果による分岐をここに置く**のは、`main.ts` を条件分岐なしに保つため
   * （ブラウザが無いので `main.ts` は実行して確かめられない）。ここなら
   * DOM テストから駆動できる。
   */
  callback?: CallbackResult;
}

/**
 * api の拒否コード -> 画面に出す文。
 *
 * **キーは `@blog/api` の `AUTH_FAILURE_RESPONSES` の `error` と一致していなければならない。**
 * 突き合わせは `test/contract/auth-failure-messages.test.ts`（node 環境）が行う。
 *
 * **ここで api から import しない。** `@blog/api/src/auth.ts` は認可の実装モジュール経由で
 * `aws-jwt-verify` を引き込むので、import するとブラウザのバンドルに入る（ブラウザに配る
 * 依存を増やさないという判断に反する）。**代わりに綴りの一致を contract テストが見ている。**
 */
export const AUTH_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  // **「認証が未設定」の綴りを保つこと。** test/dom/submit.test.ts が
  // この語で固定している（既存アサーションを緩めない）。
  auth_not_configured: '認証が未設定（API が AUTH_MODE=deny-all で動いている）。infra を確認すること',
  unauthenticated: 'ログインしていないので送信できない。「ログイン」を押すこと',
  invalid_token: 'ログインの期限が切れた。もう一度ログインすること',
  not_authorized:
    'このユーザには投稿する権限が無い。投稿できるのは 1 人だけなので、再ログインしても直らない',
  auth_unavailable: '認証サーバに一時的に到達できない。しばらく待ってから送信し直すこと',
};

/**
 * 上書きを断られたことを、通常の送信失敗と区別するための番兵。
 *
 * **例外にして流すのは、成功経路に紛れ込ませないため。** 「409 を受けた」あとに
 * 何もせず resolve すると、下書きの破棄と成功表示にそのまま落ちてしまう。
 */
class OverwriteDeclinedError extends Error {
  constructor() {
    super('overwrite declined');
    this.name = 'OverwriteDeclinedError';
  }
}

/**
 * 削除の確認文。**失われるものと、失われないものを両方言う。**
 *
 * 「履歴には残る」を書くのは、取り消せないと誤解して手が止まるのを避けるため。
 * サイトからは消えるので**取り消せない操作ではある**が、内容は git に残っている。
 */
export const deletePrompt = (slug: string, title: string): string =>
  `${title}（${slug}）を削除する。Git の履歴には残るが、サイトからは消える。削除するか？`;

/**
 * 409 のときの確認文。**失われるものを先に言う。**
 *
 * **ここに到達するのは新規投稿で同じ秒に 2 本出したときだけ。** slug は pubDate から
 * `YYYY/MM/DD/HHmmss` で導出されるので、秒が違えば衝突しない。編集（`UPDATE_POST`）の
 * 409 はこの確認を通さず、`UPDATE_CONFLICT_MESSAGES` が理由だけを伝える。
 */
export const slugConflictPrompt = (slug: string): string =>
  `${slug} には既に記事がある（同じ秒に投稿したか、pubDate が既存の記事と同じ）。上書きすると今の内容は置き換わる（Git の履歴には残る）。上書きするか？`;

/** api が返す衝突コード。`api/src/router.ts` の綴りと一致していること。 */
const SLUG_CONFLICT = 'slug_conflict';

/**
 * 編集で返る 409 の文言。**`slug_conflict` と混ぜない。**
 *
 * `slug_conflict` は「上書きするか？」を聞く価値がある（同じ秒への再投稿）。
 * こちらはどちらも**聞いても意味が無い** — 読み直すか、他の記事を公開するしか
 * 直しようが無いので、確認を出さずに理由だけを伝える。
 *
 * `stale_post` と `concurrent_update` は原因が違う（blob が変わった / main が進んだ）が、
 * **利用者の対応は同じ**なので同じ文にする。区別はログが持っている。
 */
const UPDATE_CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  stale_post: 'この記事は別の場所で更新された。「更新」で一覧を読み直してから編集し直すこと',
  concurrent_update:
    'コミットの最中に blog-content が進んだ。「更新」で一覧を読み直してから編集し直すこと',
  would_starve_site:
    '公開記事が 0 本になるので保存できない。ほかの記事を公開してから下書きに戻すこと',
};

/**
 * 削除で返る 409 の文言。**保存側（`UPDATE_CONFLICT_MESSAGES`）と分ける。**
 *
 * 同じコードでも直しようが違う。保存側は「下書きに戻す」のをやめれば済むが、
 * 削除側は**別の記事を公開する以外に手が無い**。同じ文にすると、
 * 削除を押した人に「下書きに戻すな」と言うことになる。
 */
const DELETE_CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  would_starve_site:
    '公開記事が 0 本になるので削除できない。ほかの記事を公開してから削除すること',
  stale_post: 'この記事は別の場所で更新された。「更新」で一覧を読み直すこと',
  concurrent_update: 'コミットの最中に blog-content が進んだ。「更新」で一覧を読み直すこと',
};

const isSlugConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && error.code === SLUG_CONFLICT;

/**
 * 送信の失敗をユーザに読める文にする。
 *
 * **404 の扱いがこの関数の存在理由。** CloudFront は署名に失敗した 403 を
 * `CustomErrorResponses` で **404 の HTML** に化けさせる。素直に
 * 「見つかりません」と出すと、次に読む人が経路の問題だと誤解して何時間も溶かす
 * （実際に踏んだ）。**その知識を UI に埋め込んでおく。**
 */
const describeFailure = (error: unknown): string => {
  if (error instanceof OverwriteDeclinedError) {
    return '上書きしなかったので、何も変更していない。pubDate を変えるか、もう一度送信して上書きすること';
  }
  if (!(error instanceof ApiError)) {
    return `送信に失敗した: ${(error as Error).message}`;
  }
  if (isSlugConflict(error)) {
    // 確認を出せなかった場合にここへ来る（confirm が無い環境など）。
    return 'その公開先には既に記事がある。上書きするなら確認に「はい」と答えること';
  }
  const conflict = UPDATE_CONFLICT_MESSAGES[error.code];
  if (conflict !== undefined) return conflict;
  if (error.status === 404) {
    return '404 が返った。経路が無いのではなく、x-amz-content-sha256 が届いていない可能性が高い（署名に失敗した 403 が CloudFront で 404 の HTML に化ける）';
  }
  const authMessage = AUTH_FAILURE_MESSAGES[error.code];
  if (authMessage !== undefined) return authMessage;
  if (error.code === 'key_not_provisioned') {
    return 'GitHub App の秘密鍵が Secrets Manager に入っていない';
  }
  if (error.code === 'invalid_post') {
    return `入力が API に拒否された（${error.field ?? '不明なフィールド'}）`;
  }
  return `送信に失敗した（${error.status} ${error.code}）`;
};

/** 未認証で起動したときの文言。**送信できない理由を先に言う。** */
const SIGNED_OUT_MESSAGE = 'ログインしていない。書くことはできるが、送信するにはログインが要る';

/**
 * 起動時の callback 処理の結果を文にする。
 *
 * **`description` は認可サーバが返す任意文字列である。** ここで作った文字列は
 * 必ず `setStatus`（`textContent`）を通す — `#preview` 以外に `innerHTML` を使わない、
 * というのがこのアプリの境界。プレビューは生 HTML を通す設計なので、
 * ここを間違えるとそのまま XSS になる。
 */
const describeCallback = (result: CallbackResult): string | undefined => {
  if (result.kind === 'no_callback') return undefined;
  if (result.kind === 'signed_in') return 'ログインした';
  if (result.kind === 'provider_error') {
    const detail = result.description === undefined ? '' : `: ${result.description}`;
    return `ログインできなかった（${result.error}${detail}）`;
  }
  return `ログインを完了できなかった（${result.reason}）。もう一度ログインすること`;
};

/**
 * エディタの根を取り出す。**`main.ts` に `if` を書かせないためにここにある**
 * — ブラウザ無しでは実行できない領域に判断を 1 つも増やさない。無ければ投げる。
 */
export const requireRoot = (doc: ParentNode): HTMLElement => {
  const root = doc.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('admin: #editor が見つからない');
  return root;
};

export const createApp = (deps: AppDeps): { destroy(): void } => {
  const client = createApiClient({
    ...(deps.origin === undefined ? {} : { origin: deps.origin }),
    auth: deps.auth,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  const store = deps.store;

  /** **既定は window.confirm、それも無ければ false**（上書きしない側に倒す）。 */
  const confirmOverwrite = (message: string): boolean | Promise<boolean> =>
    deps.confirm === undefined ? (globalThis.confirm?.(message) ?? false) : deps.confirm(message);

  // **復元は bindEditor より前。** 先に value を入れておけば、bindEditor の初回
  // update() が復元後の値でプレビューと検証をまとめて行う。
  const restored = store === undefined ? undefined : loadDraft(store);
  if (restored !== undefined) applyDraftToForm(deps.root, restored);

  /**
   * **復元中の保存を抑える。** `bindEditor` は構築時に update() を 1 回呼び、
   * その中で onChange が発火する。抑えないと「復元 -> 保存し直し」が毎回走る。
   */
  let ready = false;

  /**
   * 編集中の対象。**`undefined` が新規投稿モード。**
   *
   * ここが送信先（POST / PUT）と下書きの保存可否の両方を決める。**1 つの変数に
   * まとめているのが要点** — 別々のフラグにすると「PUT に送るのに下書きも保存する」
   * のような中間状態が作れてしまい、新規の書きかけが編集の打鍵で壊れる。
   *
   * **宣言が `bindEditor` より前にあるのは TDZ を避けるため。** `bindEditor` は
   * 構築時に `update()` を呼び、その中で `onChange` がこの変数を読む。
   * 後に置くと、`!ready` の短絡評価だけが ReferenceError を防いでいる状態になる。
   */
  let editing: EditTarget | undefined;

  const editor = bindEditor(deps.root, {
    renderPreview: deps.renderPreview,
    onChange: (fields) => {
      // **編集中は保存しない。** 下書きストアは新規記事のためのもので、
      // 編集の打鍵を書き込むと、次に新規で開いたときに他人の記事が復活する。
      if (!ready || store === undefined || editing !== undefined) return;
      saveDraft(store, fields);
    },
  });

  ready = true;

  const form = deps.root.querySelector<HTMLFormElement>('#post-form');
  const imageInput = deps.root.querySelector<HTMLInputElement>('#image');
  const signinButton = deps.root.querySelector<HTMLButtonElement>('#signin');
  const signoutButton = deps.root.querySelector<HTMLButtonElement>('#signout');
  const listReload = deps.root.querySelector<HTMLButtonElement>('#post-list-reload');
  const listStatus = deps.root.querySelector<HTMLElement>('#post-list-status');
  const listItems = deps.root.querySelector<HTMLElement>('#post-list-items');
  const pubDateInput = deps.root.querySelector<HTMLInputElement>('#pubDate');
  const submitButton = deps.root.querySelector<HTMLButtonElement>('#submit');
  const newPostButton = deps.root.querySelector<HTMLButtonElement>('#new-post');
  if (form === null) throw new Error('admin app: #post-form が見つからない');
  if (imageInput === null) throw new Error('admin app: #image が見つからない');
  if (signinButton === null) throw new Error('admin app: #signin が見つからない');
  if (signoutButton === null) throw new Error('admin app: #signout が見つからない');
  if (listReload === null) throw new Error('admin app: #post-list-reload が見つからない');
  if (listStatus === null) throw new Error('admin app: #post-list-status が見つからない');
  if (listItems === null) throw new Error('admin app: #post-list-items が見つからない');
  if (pubDateInput === null) throw new Error('admin app: #pubDate が見つからない');
  if (submitButton === null) throw new Error('admin app: #submit が見つからない');
  if (newPostButton === null) throw new Error('admin app: #new-post が見つからない');

  /** **二重送信の防止はここ 1 箇所。** ボタンの disabled は表示にすぎない。 */
  let inFlight = false;


  /**
   * フォームに値を流し込む。
   *
   * **`setBody` を最後に呼ぶのは再描画のため。** `applyDraftToForm` は value を
   * 書くだけでイベントを出さないので、`bindEditor` の `update()` が走らず
   * プレビューと指摘が古いままになる。`setBody` は「差し替えて再描画する」
   * ために既にある口で、画像挿入が同じ経路を使っている。
   */
  const fillForm = (fields: DraftFields): void => {
    applyDraftToForm(deps.root, fields);
    editor.setBody(fields.body);
  };

  /** 編集モードの見た目。**pubDate を読み取り専用にするのがこの関数の主目的。** */
  const renderEditState = (): void => {
    const active = editing !== undefined;
    // **URL を動かせないことの UI 側の表明。** api も 400 で拒むので二重化になる。
    pubDateInput.readOnly = active;
    submitButton.textContent = active ? SUBMIT_UPDATE : SUBMIT_CREATE;
    newPostButton.hidden = !active;
  };

  /** 編集をやめて新規投稿モードに戻る。**保存済みの下書きを取り戻す。** */
  const exitEditMode = (): void => {
    editing = undefined;
    renderEditState();
    // **編集中はストアを触っていないので、書きかけがそのまま残っている。**
    // 空フォームに戻すだけだと、編集に寄り道した人の新規記事が消える。
    const saved = store === undefined ? undefined : loadDraft(store);
    fillForm(saved ?? emptyDraft());
  };

  const enterEditMode = (slug: string): void => {
    if (inFlight) return;
    editor.setStatus('記事を読み込み中…');

    void client
      .call(GET_POST, undefined, { slug })
      .then((result) => {
        const record = (result ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(record['tags']) ? (record['tags'] as string[]) : [];
        // **editing を先に立てる。** fillForm が onChange を走らせるので、
        // 後に立てると 1 打鍵ぶんの下書きが保存されてしまう。
        editing = {
          slug: String(record['slug'] ?? slug),
          // **front matter の実値をそのまま持つ。** 表示用に整形した値を送ると
          // ms が落ちて api の「表記まで一致」検査に落ちる。
          pubDate: String(record['pubDate'] ?? ''),
          sha: String(record['sha'] ?? ''),
        };
        renderEditState();
        fillForm({
          title: String(record['title'] ?? ''),
          description: String(record['description'] ?? ''),
          // **slug から戻す。** pubDate を書式化すると jstWallClockToInstant の
          // 逆関数を持つことになり、いつか片方だけずれる。
          pubDate: slugToWallClock(editing.slug),
          tags: tags.join(', '),
          draft: record['draft'] === true,
          body: String(record['body'] ?? ''),
        });
        editor.setStatus(`${editing.slug} を編集中`);
      })
      .catch((error: unknown) => {
        // **編集モードに入らない。** 中途半端に入ると、次の送信が
        // 取得できなかった記事を上書きしようとする。
        editing = undefined;
        renderEditState();
        editor.setStatus(describeFailure(error), 'error');
      });
  };

  const onNewPost = (): void => {
    exitEditMode();
  };

  /**
   * ログイン状態を画面に反映する。
   *
   * **送信ボタンの disabled は `bind.ts` が所有している**（毎 update で
   * `busy || problems.length > 0` に再計算する）。横から書いても次の打鍵で戻るので、
   * `setBusy` 経由で伝える。**未認証は「いま送信できない状態」**なので意味も合う。
   *
   * **ここでリダイレクトしない。** 未認証は正常な状態のひとつである。
   */
  const renderAuthState = (): void => {
    const signedIn = deps.auth.isAuthenticated();
    signinButton.hidden = signedIn;
    signoutButton.hidden = !signedIn;
    editor.setBusy(inFlight || !signedIn);
  };

  let listInFlight = false;

  /**
   * 記事を削除する。**確認を通らなければリクエストを 1 本も出さない。**
   *
   * `confirmOverwrite` と同じ注入形を使うので、**確認できない環境では false** に
   * 倒れる（jsdom や `confirm` を潰したブラウザ）。削除は取り消せないので、
   * 「確認が出せなかったから実行した」は最悪の分岐である。
   *
   * **`refreshPostList` は成功時だけ呼ぶ。** 拒否されたときに読み直すと、
   * 残っている行が消えたように見えたり、逆に理由の表示が上書きされたりする。
   */
  const deletePost = async (slug: string, sha: string, title: string): Promise<void> => {
    let approved = false;
    try {
      approved = await confirmOverwrite(deletePrompt(slug, title));
    } catch {
      // 確認そのものが投げた場合も**実行しない側**に倒す。
      approved = false;
    }
    if (!approved) {
      listStatus.textContent = '削除しなかった';
      return;
    }

    listStatus.textContent = '削除中…';
    try {
      await client.call(DELETE_POST, undefined, { slug, sha });
    } catch (error) {
      const conflict = error instanceof ApiError ? DELETE_CONFLICT_MESSAGES[error.code] : undefined;
      listStatus.textContent = conflict ?? describeFailure(error);
      return;
    }

    // **編集中の記事が消えたら新規モードへ。** 残すと、次の送信が
    // 存在しない記事を更新しようとして 404 になる。
    if (editing?.slug === slug) exitEditMode();
    refreshPostList();
  };

  /**
   * 一覧の読み込み。**エディタの状態には触らない。**
   *
   * 失敗は `#post-list-status` にだけ出す。`#problems`（入力の指摘）や
   * `#status`（送信の結果）に混ぜると、**一覧が読めないだけで「記事が書けない」と
   * 読めてしまう。**
   */
  const refreshPostList = (): void => {
    if (listInFlight) return;
    if (!deps.auth.isAuthenticated()) {
      // **API を呼ばない。** 401 を並べても情報が増えない。
      listStatus.textContent = POST_LIST_SIGNED_OUT;
      return;
    }

    listInFlight = true;
    listReload.disabled = true;
    listStatus.textContent = '読み込み中…';

    void client
      .call(LIST_POSTS)
      .then((result) => {
        const record = (result ?? {}) as Record<string, unknown>;
        const posts = Array.isArray(record['posts']) ? (record['posts'] as PostListEntry[]) : [];
        // **編集と削除を注入する。** post-list.ts は DOM を組むだけで、何も呼ばない。
        renderPostList(listItems, posts, {
          onEdit: enterEditMode,
          onDelete: (slug, sha) => {
            // **title は一覧が持っている値を使う。** 確認文に出すために
            // 詳細を取り直すと、押してから確認が出るまでに往復が入る。
            const target = posts.find((post) => post.slug === slug);
            void deletePost(slug, sha, target?.title ?? slug);
          },
        });
        listStatus.textContent = `${posts.length} 件`;
      })
      .catch((error: unknown) => {
        // **describeFailure を再利用する。** 404 が署名の失敗であるという知識を
        // 一覧側でも共有する（別の文言を書くと片方だけ古くなる）。
        listStatus.textContent = describeFailure(error);
      })
      .finally(() => {
        listInFlight = false;
        listReload.disabled = false;
      });
  };

  const onListReload = (): void => {
    refreshPostList();
  };

  const onSignInClick = (): void => {
    // **押されて初めて遷移する。** 押した時点で下書きは既に保存されている
    // （毎打鍵で保存しているため）が、直前の値を取りこぼさないようもう一度書く。
    if (store !== undefined) saveDraft(store, editor.fields());
    void deps.onSignIn?.();
  };

  const onSignOutClick = (): void => {
    // **下書きは消さない。** サインアウトは「書きかけを捨てる」操作ではない。
    void deps.onSignOut?.();
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    if (inFlight) return;
    if (editor.problems().length > 0) return;

    let post;
    try {
      post = validateDraft(editor.fields(), deps.now());
    } catch {
      // bindEditor が既に #problems に出している。
      return;
    }

    inFlight = true;
    editor.setBusy(true);
    editor.setStatus('送信中…');

    /**
     * **上書きの意思は 2 回目の送信でしか付かない。**
     *
     * **slug は送らない**（`postRequestBody`）。api は付いていたら 400 にする。
     */
    const body = postRequestBody(post);
    const send = (overwrite: boolean): Promise<unknown> =>
      client.call(CREATE_POST, overwrite ? { ...body, overwrite: true } : body);

    const sendable = post;
    /** **送信の瞬間のモードを固定する。** 途中で編集をやめられても分岐がぶれない。 */
    const target = editing;

    const attempt: Promise<unknown> =
      target === undefined
        ? send(false).catch(async (error: unknown) => {
            // **409 だけを拾う。** 他の失敗はそのまま下の catch へ落とす。
            if (!isSlugConflict(error)) throw error;
            // **無言で再送しない。** ここで承認を取らずに overwrite を付けると、
            // 409 を出した意味が無くなる（2026-09-07 の事故がそのまま再現する）。
            const approved = await confirmOverwrite(slugConflictPrompt(sendable.slug));
            if (!approved) throw new OverwriteDeclinedError();
            return send(true);
          })
        : // **編集の 409 では確認を出さない。** stale も would_starve_site も
          // 「はい」と答えて直る種類ではないので、聞くと押し間違いを誘うだけ。
          client.call(UPDATE_POST, updateRequestBody(post, target));

    void attempt
      .then((result) => {
        const record = (result ?? {}) as Record<string, unknown>;
        // **成功したときだけ下書きを捨てる。** 残すと次に開いたときに復活する。
        // 失敗時は消さない（書き直せなければならない）。
        //
        // **編集では消さない。** ストアが持っているのは新規記事の書きかけで、
        // 編集の成功はそれと無関係である。
        if (store !== undefined && target === undefined) clearDraft(store);
        const where = `${String(record['commitSha'] ?? '')} ${String(record['path'] ?? '')}`;
        // **記事は保存されているが、デプロイが起動していない状態を成功と混ぜない。**
        // 同じ見た目にすると、利用者はサイトが更新されると信じて待ち続ける。
        // キーが無い = dispatch が無効（今日の既定）なので、成功として扱う。
        if (record['deployTriggered'] === false) {
          editor.setStatus(`保存しました（デプロイ未起動。手動で再実行が必要）: ${where}`);
          return;
        }
        // **編集と新規で文言を分ける。** 更新は `replaced: true` を返すので、
        // 分けないと編集が「上書きしました」になり、事故の報告と見分けが付かない。
        if (target !== undefined) {
          editor.setStatus(`更新しました: ${where}`, 'ok');
          return;
        }
        editor.setStatus(
          record['replaced'] === true ? `上書きしました: ${where}` : `公開しました: ${where}`,
          'ok',
        );
      })
      .catch((error: unknown) => {
        editor.setStatus(describeFailure(error), 'error');
        if (error instanceof ApiError && error.field !== undefined) {
          // API が指したフィールドを、クライアント側の指摘と同じ場所に出す。
          const list = deps.root.querySelector('#problems');
          const item = document.createElement('li');
          item.dataset['field'] = error.field;
          item.textContent = `${error.field}: API に拒否された`;
          list?.appendChild(item);
        }
      })
      .finally(() => {
        inFlight = false;
        // **拒否を受けたあとの状態をここで拾う。** 認証が失われていれば
        // #signin が戻り、送信ボタンは固まったままになる。
        // **リダイレクトはしない** — 編集中に勝手に飛ばさない。
        renderAuthState();
      });
  };

  const onImage = (): void => {
    const file = imageInput.files?.[0];
    if (file === undefined) return;

    // **presign を呼ぶ前に落とす。** 許可外の type と 10 MiB 超はここで終わり。
    try {
      checkUploadable(file);
    } catch (error) {
      editor.setStatus(
        error instanceof UploadValidationError
          ? `この画像は上げられない（${error.field}）`
          : `この画像は上げられない: ${(error as Error).message}`,
        'error',
      );
      return;
    }

    editor.setStatus('画像をアップロード中…');

    void presignMedia(client, {
      contentType: file.type,
      size: file.size,
      filename: file.name,
    })
      .then((presign) => uploadToPresignedUrl(presign, file, deps.fetchImpl))
      .then((key) => {
        // **成功したときだけ本文を書き換える。** 失敗時に壊れたリンクを
        // 本文に残さない。
        const body = editor.fields().body;
        const snippet = mediaMarkdown(key, file.name);
        editor.setBody(body.length === 0 ? snippet : `${body}\n\n${snippet}`);
        editor.setStatus(`画像を追加した: /${key}`, 'ok');
        imageInput.value = '';
      })
      .catch((error: unknown) => {
        editor.setStatus(
          error instanceof UploadSizeMismatchError
            ? `アップロードを中止した（署名は ${error.expected} バイト、ファイルは ${error.actual} バイト）`
            : `画像のアップロードに失敗した: ${describeFailure(error)}`,
          'error',
        );
      });
  };

  form.addEventListener('submit', onSubmit);
  newPostButton.addEventListener('click', onNewPost);
  imageInput.addEventListener('change', onImage);
  signinButton.addEventListener('click', onSignInClick);
  signoutButton.addEventListener('click', onSignOutClick);
  listReload.addEventListener('click', onListReload);

  renderAuthState();
  renderEditState();
  // **押されるまで一覧を取りに行かない。**
  listStatus.textContent = POST_LIST_IDLE;

  // **起動時のメッセージ。** callback の結果があればそれを優先する。
  const callbackMessage =
    deps.callback === undefined ? undefined : describeCallback(deps.callback);
  if (callbackMessage !== undefined) {
    editor.setStatus(callbackMessage, deps.callback?.kind === 'signed_in' ? 'ok' : 'error');
  } else if (!deps.auth.isAuthenticated()) {
    editor.setStatus(SIGNED_OUT_MESSAGE);
  }

  return {
    destroy: () => {
      form.removeEventListener('submit', onSubmit);
      newPostButton.removeEventListener('click', onNewPost);
      imageInput.removeEventListener('change', onImage);
      signinButton.removeEventListener('click', onSignInClick);
      signoutButton.removeEventListener('click', onSignOutClick);
      listReload.removeEventListener('click', onListReload);
    },
  };
};
