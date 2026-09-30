import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { bindEditor } from '../../src/editor/bind.ts';

/** bind.test.ts と同じく**実物の index.html** から #editor を切り出す。 */
const mount = (): HTMLElement => {
  document.body.innerHTML = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<main'),
    INDEX_HTML.indexOf('</main>') + '</main>'.length,
  );
  const root = document.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('index.html から #editor を切り出せなかった');
  return root;
};

const get = <T extends HTMLElement>(root: HTMLElement, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} が無い`);
  return element;
};

const noopPorts = { renderPreview: async () => '', onChange: () => {} };

const press = (element: HTMLElement, key: string): void => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

/** 開いているパネル。**hidden 属性だけ**で判定する（CSS は jsdom で効かない）。 */
const visible = (root: HTMLElement): { code: boolean; preview: boolean } => ({
  code: !get(root, '#panel-code').hidden,
  preview: !get(root, '#panel-preview').hidden,
});

describe('本文の Code / Preview タブ', () => {
  it('最初は Code が開いていて Preview は隠れている', () => {
    const root = mount();
    bindEditor(root, noopPorts);

    expect(visible(root)).toEqual({ code: true, preview: false });
    expect(get(root, '#tab-code').getAttribute('aria-selected')).toBe('true');
    expect(get(root, '#tab-preview').getAttribute('aria-selected')).toBe('false');
  });

  it('Preview を押すと入れ替わり、Code で戻る', () => {
    const root = mount();
    bindEditor(root, noopPorts);

    get(root, '#tab-preview').click();
    expect(visible(root)).toEqual({ code: false, preview: true });
    expect(get(root, '#tab-preview').getAttribute('aria-selected')).toBe('true');
    expect(get(root, '#tab-code').getAttribute('aria-selected')).toBe('false');

    get(root, '#tab-code').click();
    expect(visible(root)).toEqual({ code: true, preview: false });
  });

  // **<form> の中の <button> は既定が submit。** type="button" を落とすと、
  // タブを押しただけで記事が公開される。
  it('タブを押してもフォームは送信されない', () => {
    const root = mount();
    bindEditor(root, noopPorts);
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    get(root, '#post-form').addEventListener('submit', onSubmit);

    get(root, '#tab-preview').click();
    get(root, '#tab-code').click();

    expect(onSubmit).not.toHaveBeenCalled();
    for (const tab of root.querySelectorAll<HTMLButtonElement>('#body-tabs [role="tab"]')) {
      expect(tab.type).toBe('button');
    }
  });

  it('選択中のタブだけが Tab キーの巡回に入る（roving tabindex）', () => {
    const root = mount();
    bindEditor(root, noopPorts);

    expect(get(root, '#tab-code').tabIndex).toBe(0);
    expect(get(root, '#tab-preview').tabIndex).toBe(-1);

    get(root, '#tab-preview').click();
    expect(get(root, '#tab-code').tabIndex).toBe(-1);
    expect(get(root, '#tab-preview').tabIndex).toBe(0);
  });

  it('矢印キー / Home / End でタブを移り、移った先が開いてフォーカスを持つ', () => {
    const root = mount();
    bindEditor(root, noopPorts);
    const code = get(root, '#tab-code');
    const preview = get(root, '#tab-preview');

    press(code, 'ArrowRight');
    expect(visible(root)).toEqual({ code: false, preview: true });
    expect(document.activeElement).toBe(preview);

    // 端で折り返す。
    press(preview, 'ArrowRight');
    expect(visible(root)).toEqual({ code: true, preview: false });
    expect(document.activeElement).toBe(code);

    press(code, 'ArrowLeft');
    expect(visible(root)).toEqual({ code: false, preview: true });

    press(preview, 'Home');
    expect(visible(root)).toEqual({ code: true, preview: false });

    press(code, 'End');
    expect(visible(root)).toEqual({ code: false, preview: true });
  });

  // **描画はタブと独立。** Code を開いている間の入力も Preview に反映されている。
  it('Code を開いている間に打った本文が、Preview を開いた時点で描かれている', async () => {
    const root = mount();
    bindEditor(root, {
      renderPreview: async (markdown) => `<p>${markdown}</p>`,
      onChange: () => {},
    });

    const body = get<HTMLTextAreaElement>(root, '#body');
    body.value = 'hello';
    body.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => {
      expect(get(root, '#preview').innerHTML).toBe('<p>hello</p>');
    });

    get(root, '#tab-preview').click();
    expect(get(root, '#preview').innerHTML).toBe('<p>hello</p>');
  });

  it('aria-controls の指す先が無ければ bindEditor が投げる', () => {
    const root = mount();
    get(root, '#tab-preview').setAttribute('aria-controls', 'no-such-panel');
    expect(() => bindEditor(root, noopPorts)).toThrow();
  });
});
