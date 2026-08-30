import { draftProblems, type DraftFields, type DraftProblem } from './model.ts';

/**
 * DOM 結線。**ここには「何を描くか」しか無く、「どこに送るか」は無い**
 * （送信は app.ts）。
 *
 * `ports` を注入可能にしているのが、DOM テストを決定的にできる理由。重い
 * 実パイプラインを使うのは 1 件だけにし、残りは偽物で待ち時間を作らない。
 */
export interface EditorPorts {
  renderPreview(markdown: string): Promise<string>;
  onChange(fields: DraftFields): void;
}

/** 必須要素。**1 つでも欠けたら即座に投げる**（黙って握りつぶさない）。 */
const require$ = <T extends Element>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`admin editor: ${selector} が見つからない`);
  return element;
};

const FIELD_IDS = ['slug', 'title', 'description', 'pubDate', 'tags', 'body'] as const;

/** フォームの 7 フィールドを読み出す。checkbox だけ `checked` を見る。 */
export const readFields = (root: ParentNode): DraftFields => {
  const value = (id: string): string =>
    require$<HTMLInputElement | HTMLTextAreaElement>(root, `#${id}`).value;
  return {
    slug: value('slug'),
    title: value('title'),
    description: value('description'),
    pubDate: value('pubDate'),
    tags: value('tags'),
    draft: require$<HTMLInputElement>(root, '#draft').checked,
    body: value('body'),
  };
};

export interface BoundEditor {
  /** 現在のフォームの値。 */
  fields(): DraftFields;
  /** 現在の指摘。空なら送信できる。 */
  problems(): DraftProblem[];
  /** 本文を差し替えて再描画する（画像挿入で使う）。 */
  setBody(body: string): void;
  /** 送信中はフォームを固める。 */
  setBusy(busy: boolean): void;
  /** 状態表示。 */
  setStatus(message: string, kind?: 'ok' | 'error'): void;
}

export const bindEditor = (root: HTMLElement, ports: EditorPorts): BoundEditor => {
  // **先に全部の存在を確かめる。** 1 つでも欠けたらここで投げる。
  const inputs = FIELD_IDS.map((id) =>
    require$<HTMLInputElement | HTMLTextAreaElement>(root, `#${id}`),
  );
  const draftInput = require$<HTMLInputElement>(root, '#draft');
  const preview = require$<HTMLElement>(root, '#preview');
  const problemList = require$<HTMLElement>(root, '#problems');
  const submit = require$<HTMLButtonElement>(root, '#submit');
  const status = require$<HTMLElement>(root, '#status');

  /**
   * **世代カウンタ。** デバウンスを使わないのは、使うと DOM テストが
   * 時計依存になるため。遅い描画が後から返っても、世代が古ければ捨てる。
   */
  let generation = 0;
  let busy = false;
  let current: DraftProblem[] = [];

  const renderProblems = (problems: DraftProblem[]): void => {
    current = problems;
    problemList.replaceChildren(
      ...problems.map((problem) => {
        const item = document.createElement('li');
        item.dataset['field'] = problem.field;
        item.textContent = `${problem.field}: ${problem.message}`;
        return item;
      }),
    );
    submit.disabled = busy || problems.length > 0;
  };

  const update = (): void => {
    const fields = readFields(root);
    // 検証は同期。プレビューだけが非同期なので、ボタンの状態は即座に決まる。
    renderProblems(draftProblems(fields, Date.now()));
    ports.onChange(fields);

    const mine = ++generation;
    void ports
      .renderPreview(fields.body)
      .then((html) => {
        // **古い世代の結果は捨てる。** 新しい描画を上書きしない。
        if (mine !== generation) return;
        // 一致判定を DOM 経由の読み戻しではなく innerHTML に渡す**文字列**で
        // 行っているのと同じ理由で、ここも innerHTML にそのまま入れる。
        preview.innerHTML = html;
      })
      .catch(() => {
        if (mine !== generation) return;
        preview.textContent = 'プレビューを描けなかった';
      });
  };

  for (const element of [...inputs, draftInput]) {
    // **input と change の両方を購読する。** checkbox は change しか
    // 出さないブラウザがある。
    element.addEventListener('input', update);
    element.addEventListener('change', update);
  }

  update();

  return {
    fields: () => readFields(root),
    problems: () => current,
    setBody: (body: string) => {
      require$<HTMLTextAreaElement>(root, '#body').value = body;
      update();
    },
    setBusy: (next: boolean) => {
      busy = next;
      submit.disabled = busy || current.length > 0;
    },
    setStatus: (message: string, kind?: 'ok' | 'error') => {
      status.textContent = message;
      if (kind === undefined) delete status.dataset['kind'];
      else status.dataset['kind'] = kind;
    },
  };
};
