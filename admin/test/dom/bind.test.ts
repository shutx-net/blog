import { describe, expect, it, vi } from 'vitest';

// **実物の index.html を Vite の ?raw で読む。** node:fs を使わないのは、
// jsdom 環境では import.meta.url が file: スキームにならず fileURLToPath が
// TypeError で落ちるため（実測）。
import INDEX_HTML from '../../index.html?raw';
import { bindEditor, readFields } from '../../src/editor/bind.ts';
import { renderPreview } from '../../src/preview/pipeline.ts';

/**
 * **実物の index.html を読む。** テスト用に別の HTML を書くと、フォームの
 * id を index.html だけ変えたときに気づけない。
 */
const mount = (): HTMLElement => {
  document.body.innerHTML = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<main'),
    INDEX_HTML.indexOf('</main>') + '</main>'.length,
  );
  const root = document.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('index.html から #editor を切り出せなかった');
  return root;
};

const set = (root: HTMLElement, id: string, value: string): void => {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (element === null) throw new Error(`#${id} が無い`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const check = (root: HTMLElement, id: string, checked: boolean): void => {
  const element = root.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) throw new Error(`#${id} が無い`);
  element.checked = checked;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const noopPorts = {
  renderPreview: async () => '',
  onChange: () => {},
};

describe('readFields', () => {
  it('7 フィールドを DraftFields に読み出す', () => {
    const root = mount();
    set(root, 'slug', 'a-post');
    set(root, 'title', 'A title');
    set(root, 'description', 'A description');
    set(root, 'pubDate', '2026-08-31T11:30');
    set(root, 'tags', 'astro, nix');
    check(root, 'draft', false);
    set(root, 'body', '## H');

    expect(readFields(root)).toEqual({
      slug: 'a-post',
      title: 'A title',
      description: 'A description',
      pubDate: '2026-08-31T11:30',
      tags: 'astro, nix',
      draft: false,
      body: '## H',
    });
  });

  it('checkbox は checked を読む（value ではない）', () => {
    const root = mount();
    check(root, 'draft', true);
    expect(readFields(root).draft).toBe(true);
    check(root, 'draft', false);
    expect(readFields(root).draft).toBe(false);
  });
});

describe('必須要素が無ければ即座に投げる', () => {
  it.each(['#preview', '#body', '#problems', '#submit', '#slug'])(
    '%s が無いと bindEditor が投げる',
    (selector) => {
      // 存在チェックを黙って握りつぶすと、UI が「動いているように見えて
      // 何も起きない」状態になる。
      const root = mount();
      root.querySelector(selector)?.remove();
      expect(() => bindEditor(root, noopPorts)).toThrow();
    },
  );

  it('揃っていれば投げない', () => {
    expect(() => bindEditor(mount(), noopPorts)).not.toThrow();
  });
});

describe('プレビューが実パイプラインで更新される', () => {
  it('本文を打つと #preview が site と同じ HTML になる', async () => {
    const root = mount();
    bindEditor(root, { renderPreview, onChange: () => {} });

    set(root, 'body', '## Heading two\n\nA ~~struck~~ word.');

    // **非同期。`await tick()` を 2 回では足りない**（renderer の生成が
    // shiki の wasm 読み込みを含む。実測で失敗した）。vi.waitFor で待つ。
    await vi.waitFor(
      () => {
        const preview = root.querySelector('#preview');
        expect(preview?.innerHTML).toContain('<del>struck</del>');
      },
      { timeout: 20000, interval: 20 },
    );

    const preview = root.querySelector('#preview');
    expect(preview?.innerHTML).toContain('id="heading-two"');
  }, 25000);
});

describe('**遅い描画が新しい描画を上書きしない**', () => {
  it('世代カウンタで最新だけが残る', async () => {
    const root = mount();
    const calls: string[] = [];
    // 1 回目は 30ms、2 回目以降は即座に返す偽の renderPreview。
    const slowThenFast = async (markdown: string): Promise<string> => {
      calls.push(markdown);
      if (calls.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return '<p>OLD</p>';
      }
      return '<p>NEW</p>';
    };

    bindEditor(root, { renderPreview: slowThenFast, onChange: () => {} });

    set(root, 'body', 'first');
    set(root, 'body', 'second');

    await vi.waitFor(() => {
      expect(root.querySelector('#preview')?.innerHTML).toBe('<p>NEW</p>');
    });

    // 遅い 1 回目が後から返ってきても NEW を上書きしない。
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(root.querySelector('#preview')?.innerHTML).toBe('<p>NEW</p>');
  });
});

describe('検証エラーの表示と送信ボタン', () => {
  it('エラーが #problems に field 名つきで出る', async () => {
    const root = mount();
    bindEditor(root, noopPorts);
    set(root, 'slug', 'Bad Slug');

    await vi.waitFor(() => {
      const problems = root.querySelector('#problems');
      expect(problems?.textContent).toContain('slug');
    });
  });

  it('エラーがある間は送信ボタンが disabled', async () => {
    const root = mount();
    bindEditor(root, noopPorts);
    set(root, 'slug', '');

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(true);
    });
  });

  it('全部埋めると送信ボタンが有効になる', async () => {
    const root = mount();
    bindEditor(root, noopPorts);
    set(root, 'slug', 'a-post');
    set(root, 'title', 'A title');
    set(root, 'description', 'A description');
    set(root, 'body', 'Body.');

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(false);
    });
    expect(root.querySelector('#problems')?.textContent).toBe('');
  });

  it('**相対パス画像の警告が出る**', async () => {
    const root = mount();
    bindEditor(root, noopPorts);
    set(root, 'slug', 'a-post');
    set(root, 'title', 'A title');
    set(root, 'description', 'A description');
    set(root, 'body', '![a](./x.png)');

    await vi.waitFor(() => {
      expect(root.querySelector('#problems')?.textContent).toContain('相対パス');
    });
    // 公開できない入力なので送信させない。
    expect(root.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(true);
  });
});

describe('onChange', () => {
  it('入力のたびに最新の DraftFields が渡る', async () => {
    const root = mount();
    const seen: string[] = [];
    bindEditor(root, { renderPreview: async () => '', onChange: (fields) => seen.push(fields.slug) });

    set(root, 'slug', 'one');
    set(root, 'slug', 'two');

    await vi.waitFor(() => {
      expect(seen.at(-1)).toBe('two');
    });
  });

  it('checkbox の change でも発火する', async () => {
    const root = mount();
    const seen: boolean[] = [];
    bindEditor(root, {
      renderPreview: async () => '',
      onChange: (fields) => seen.push(fields.draft),
    });

    // checkbox は input を出さないブラウザがあるので change も購読している。
    check(root, 'draft', false);

    await vi.waitFor(() => {
      expect(seen.at(-1)).toBe(false);
    });
  });
});
