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
}

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
  if (error.code === 'auth_not_configured') {
    return '認証が未設定（API は AUTH_MODE=deny-all で動いている）';
  }
  if (error.code === 'key_not_provisioned') {
    return 'GitHub App の秘密鍵が Secrets Manager に入っていない';
  }
  if (error.code === 'invalid_post') {
    return `入力が API に拒否された（${error.field ?? '不明なフィールド'}）`;
  }
  return `送信に失敗した（${error.status} ${error.code}）`;
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
  if (form === null) throw new Error('admin app: #post-form が見つからない');
  if (imageInput === null) throw new Error('admin app: #image が見つからない');

  /** **二重送信の防止はここ 1 箇所。** ボタンの disabled は表示にすぎない。 */
  let inFlight = false;

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
        editor.setBusy(false);
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

  if (!deps.auth.isAuthenticated()) {
    editor.setStatus('認証が未設定。送信は API に拒否される（AUTH_MODE=deny-all）');
  }

  return {
    destroy: () => {
      form.removeEventListener('submit', onSubmit);
      imageInput.removeEventListener('change', onImage);
    },
  };
};
