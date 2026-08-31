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
import { validateDraft } from './model.ts';

const CREATE_POST: ApiOperation = { method: 'POST', path: '/api/posts' };

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
 * その突き合わせは `test/contract/auth-failure-messages.test.ts`（node 環境）が行う。
 *
 * **ここで api から import しない。** `@blog/api/src/auth.ts` は認可の実装モジュール経由で
 * `aws-jwt-verify` を引き込むので、import するとそれがブラウザのバンドルに入る
 * （ブラウザに配る依存を増やさないという Phase 4 からの判断に反する）。
 * **代わりに、綴りの一致を contract テストが機械的に見ている。**
 */
export const AUTH_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  // **「認証が未設定」の綴りを保つこと。** Phase 4 の test/dom/submit.test.ts が
  // この語で固定している（既存アサーションを緩めない）。
  auth_not_configured: '認証が未設定（API が AUTH_MODE=deny-all で動いている）。infra を確認すること',
  unauthenticated: 'ログインしていないので送信できない。「ログイン」を押すこと',
  invalid_token: 'ログインの期限が切れた。もう一度ログインすること',
  not_authorized:
    'このユーザには投稿する権限が無い。投稿できるのは 1 人だけなので、再ログインしても直らない',
  auth_unavailable: '認証サーバに一時的に到達できない。しばらく待ってから送信し直すこと',
};

/**
 * 送信の失敗をユーザに読める文にする。
 *
 * **404 の扱いがこの関数の存在理由。** CloudFront は署名に失敗した 403 を
 * `CustomErrorResponses` で **404 の HTML** に化けさせる。素直に
 * 「見つかりません」と出すと、次に読む人が経路の問題だと誤解して何時間も溶かす
 * （Phase 3 で実際に踏んだ）。**その知識を UI に埋め込んでおく。**
 */
const describeFailure = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return `送信に失敗した: ${(error as Error).message}`;
  }
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
 * エディタの根を取り出す。**`main.ts` に条件分岐を書かせないためにここにある。**
 *
 * 無ければ投げる（黙って握りつぶさない）。`main.ts` に `if` を書くと、
 * ブラウザ無しでは実行できない領域に判断が 1 つ増える。
 */
export const requireRoot = (doc: ParentNode): HTMLElement => {
  const root = doc.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('admin: #editor が見つからない');
  return root;
};

/**
 * すべての依存を引数で受け取る。**DOM テストは偽の client と偽の auth を刺せる。**
 */
export const createApp = (deps: AppDeps): { destroy(): void } => {
  const client = createApiClient({
    ...(deps.origin === undefined ? {} : { origin: deps.origin }),
    auth: deps.auth,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  const store = deps.store;

  // **復元は bindEditor より前。** 先に value を入れておけば、bindEditor の初回
  // update() が復元後の値でプレビューと検証をまとめて行う。
  const restored = store === undefined ? undefined : loadDraft(store);
  if (restored !== undefined) applyDraftToForm(deps.root, restored);

  /**
   * **復元中の保存を抑える。** `bindEditor` は構築時に update() を 1 回呼び、
   * その中で onChange が発火する。抑えないと「復元 -> 保存し直し」が毎回走る。
   */
  let ready = false;

  const editor = bindEditor(deps.root, {
    renderPreview: deps.renderPreview,
    // **既存の差し込み口をそのまま使う。** 毎 input / change で呼ばれるので、
    // 新しいイベント配線は要らない（bind.ts は 1 行も変えていない）。
    onChange: (fields) => {
      if (!ready || store === undefined) return;
      saveDraft(store, fields);
    },
  });

  ready = true;

  const form = deps.root.querySelector<HTMLFormElement>('#post-form');
  const imageInput = deps.root.querySelector<HTMLInputElement>('#image');
  const signinButton = deps.root.querySelector<HTMLButtonElement>('#signin');
  const signoutButton = deps.root.querySelector<HTMLButtonElement>('#signout');
  if (form === null) throw new Error('admin app: #post-form が見つからない');
  if (imageInput === null) throw new Error('admin app: #image が見つからない');
  if (signinButton === null) throw new Error('admin app: #signin が見つからない');
  if (signoutButton === null) throw new Error('admin app: #signout が見つからない');

  /** **二重送信の防止はここ 1 箇所。** ボタンの disabled は表示にすぎない。 */
  let inFlight = false;

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

    void client
      .call(CREATE_POST, post)
      .then((result) => {
        const record = (result ?? {}) as Record<string, unknown>;
        // **成功したときだけ下書きを捨てる。** 残すと次に開いたときに復活する。
        // 失敗時は消さない（書き直せなければならない）。
        if (store !== undefined) clearDraft(store);
        editor.setStatus(
          `公開しました: ${String(record['commitSha'] ?? '')} ${String(record['path'] ?? '')}`,
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
  imageInput.addEventListener('change', onImage);
  signinButton.addEventListener('click', onSignInClick);
  signoutButton.addEventListener('click', onSignOutClick);

  renderAuthState();

  // **起動時のメッセージ。** callback の結果があればそれを優先する。
  // どちらも `setStatus`（`textContent`）を通すので、認可サーバが返した任意文字列が
  // マークアップとして解釈されることはない。
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
      imageInput.removeEventListener('change', onImage);
      signinButton.removeEventListener('click', onSignInClick);
      signoutButton.removeEventListener('click', onSignOutClick);
    },
  };
};
