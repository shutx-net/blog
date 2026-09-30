/**
 * 本文の「Code」/「Preview」タブ。GitHub の Markdown エディタと同じ切り替え方。
 *
 * **表示を切り替えるだけで、プレビューの描画には関わらない。** 描画は bind.ts が
 * 入力のたびに Preview のパネルの中身を差し替えるので、タブを開いた時点で最新になっている。
 * タブを開いたときに描く形にすると、描画の経路が 2 本になり、世代カウンタが
 * 片方しか守らなくなる。
 *
 * WAI-ARIA の Tabs パターンに合わせる。選択中のタブだけを Tab キーの巡回に入れ
 * （roving tabindex）、タブ間は矢印キー / Home / End で移る。移ったタブはその場で開く。
 */

/** 必須要素。**欠けたら即座に投げる**（bind.ts と同じ方針）。 */
const require$ = <T extends Element>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`admin editor: ${selector} が見つからない`);
  return element;
};

export interface BoundTabs {
  /** 開いているタブの id。 */
  selected(): string;
  /** id のタブを開く。 */
  select(id: string): void;
}

export const bindBodyTabs = (root: ParentNode): BoundTabs => {
  const tablist = require$<HTMLElement>(root, '#body-tabs');
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  if (tabs.length === 0) throw new Error('admin editor: #body-tabs にタブが無い');

  // **パネルも先に全部引く。** aria-controls の指す先が無いタブは、
  // 押しても何も起きない — 黙って壊れるより、構築時に投げる。
  const panels = tabs.map((tab) => {
    const id = tab.getAttribute('aria-controls');
    if (id === null) throw new Error(`admin editor: #${tab.id} に aria-controls が無い`);
    return require$<HTMLElement>(root, `#${id}`);
  });

  let current = tabs[0]!.id;

  const select = (id: string): void => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) throw new Error(`admin editor: タブ #${id} は無い`);
    current = id;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i]!.hidden = !on;
    });
  };

  const KEY_TO_INDEX: Record<string, (i: number) => number> = {
    ArrowRight: (i) => (i + 1) % tabs.length,
    ArrowLeft: (i) => (i - 1 + tabs.length) % tabs.length,
    Home: () => 0,
    End: () => tabs.length - 1,
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab.id));
    tab.addEventListener('keydown', (event) => {
      const next = KEY_TO_INDEX[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[next(i)]!;
      select(target.id);
      target.focus();
    });
  });

  // **HTML の初期値を信用せず、ここで 1 回揃える。** aria-selected と hidden が
  // 食い違った HTML でも、構築後は必ず一貫する。
  select(current);

  return { selected: () => current, select };
};
