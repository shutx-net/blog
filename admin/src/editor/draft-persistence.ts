import type { SessionStore } from '../storage/session-store.ts';
import { emptyDraft } from './model.ts';
import type { DraftFields } from './model.ts';

/**
 * 書きかけの記事を保存し、復元する。
 *
 * # なぜ必要か
 *
 * ログインは**全画面遷移**なので、押した瞬間にページが作り直される。
 * 保存していなければ書きかけは消える。**これがこのフェーズで最も守りたい 1 点**で、
 * `test/unit/draft-persistence.test.ts` の「攻撃 8」が偽 `redirect` の中から
 * store を覗いて、順序ではなく**観測で**固定している。
 *
 * # 差し込み口は既に空いていた
 *
 * `bind.ts` の `EditorPorts.onChange(fields)` が毎 input / change で `DraftFields` ごと
 * 呼ばれる。`app.ts` がそこに `saveDraft` を挿すだけでよく、**新しいイベント配線を
 * 足していない**（`bind.ts` は 1 行も変えていない）。
 *
 * # beforeunload も sendBeacon も使わない
 *
 *   (a) `sendBeacon` は `test/unit/no-raw-fetch.test.ts` が禁止している。
 *   (b) `beforeunload` は打鍵ごとの保存があれば不要で、頼ると
 *       「最後の 1 文字が入っていない」事故が起きる。
 *
 * **打鍵ごとに保存するほうが単純で確実。** `setItem` は同期 I/O だが、対象は数 KB の
 * JSON 1 個で、`bind.ts` は既に毎打鍵でプレビュー全体を再描画している。
 * **この保存が律速になることはない。**
 *
 * # 下書きは「タブが生きている間」だけ残る
 *
 * 保存先はタブ単位（`storage/session-store.ts`）。**端末をまたぐ保存は scope 外。**
 */

/** store の中でのキー。 */
export const DRAFT_KEY = 'draft';

/** フォームの `<input>` / `<textarea>` の id。`bind.ts` の `readFields` と対になる。 */
const TEXT_FIELD_IDS = ['slug', 'title', 'description', 'pubDate', 'tags', 'body'] as const;

/**
 * 何も書かれていない下書きか。
 *
 * **`emptyDraft()` と全フィールドが一致するときだけ true。** `draft` の既定は `true` なので、
 * `draft` を外しただけでも「空ではない」になる（それは意図的な操作である）。
 */
export const isEmptyDraft = (fields: DraftFields): boolean => {
  const empty = emptyDraft();
  return (
    TEXT_FIELD_IDS.every((id) => fields[id] === empty[id]) && fields.draft === empty.draft
  );
};

const isDraftFields = (value: unknown): value is DraftFields =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  TEXT_FIELD_IDS.every((id) => typeof (value as Record<string, unknown>)[id] === 'string') &&
  // **`draft` が無いレコードを既定 true で埋めない。** 「公開のつもりが下書き」
  // （またはその逆）を静かに起こすより、復元しないほうがよい。
  typeof (value as Record<string, unknown>)['draft'] === 'boolean';

/**
 * 下書きを保存する。
 *
 * **空の下書きは保存しない。** 開いただけのタブが、別のタブで書いた下書きを
 * 空で上書きするのを防ぐ（削除もしない）。
 */
export const saveDraft = (store: SessionStore, fields: DraftFields): void => {
  if (isEmptyDraft(fields)) return;
  store.set(DRAFT_KEY, fields);
};

/**
 * 下書きを読む。
 *
 * **投げない。** 壊れたレコード・版違い・欠けたフィールドはすべて `undefined`。
 * **復元に失敗してもエディタは開けなければならない。**
 */
export const loadDraft = (store: SessionStore): DraftFields | undefined => {
  const record = store.get<unknown>(DRAFT_KEY);
  return isDraftFields(record) ? record : undefined;
};

/** 下書きを消す。**公開に成功したときだけ呼ぶ**（サインアウトでは消さない）。 */
export const clearDraft = (store: SessionStore): void => {
  store.remove(DRAFT_KEY);
};

/**
 * 下書きをフォームに書き戻す。
 *
 * **`bind.ts` を変えずに済ませるためにここに置いてある**（`readFields` の対になるが、
 * あちらはプレビュー一致の証明に関わるので差分を作らない）。id がずれると片方だけ
 * 復元される壊れ方をするので、DOM テストが `readFields` との往復で固定している。
 *
 * **イベントは発火しない。** 呼び出し側（`app.ts`）が `bindEditor` より前に呼び、
 * `bindEditor` の初回 `update()` が描画と検証をまとめて行う。
 */
export const applyDraftToForm = (root: ParentNode, fields: DraftFields): void => {
  for (const id of TEXT_FIELD_IDS) {
    const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (element !== null) element.value = fields[id];
  }
  const checkbox = root.querySelector<HTMLInputElement>('#draft');
  if (checkbox !== null) checkbox.checked = fields.draft;
};
