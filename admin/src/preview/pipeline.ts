import { unified } from '@astrojs/markdown-remark';
import type { MarkdownRenderer } from '@astrojs/markdown-remark';

import { SHARED_RENDER_OPTIONS } from './shared-options.ts';

/**
 * **site が `markdown.processor` に置いているのと同じ `unified()`。**
 *
 * 引数を渡さないことが要件。`unified({ gfm: false })` のように 1 つでも渡すと
 * `processor.options.gfm ?? shared.gfm` の左辺が勝ち、site と出力が変わる。
 * test/unit/preview-shared-options.test.ts が `unified().options` を site の
 * processor の options と突き合わせて固定している。
 */
const processor = unified();

/**
 * renderer の生成は shiki の oniguruma wasm 読み込みを伴うので**モジュール内で 1 度だけ**。
 *
 * 毎回作ると、打鍵ごとに wasm を読み直してプレビューが実用にならない。
 */
let rendererPromise: Promise<MarkdownRenderer> | undefined;

const renderer = (): Promise<MarkdownRenderer> => {
  rendererPromise ??= processor.createRenderer(SHARED_RENDER_OPTIONS);
  return rendererPromise;
};

/**
 * 本文の Markdown を、公開されたページの `<article>` の中身と 1 バイト違わない
 * HTML にする。
 *
 * **`.trim()` は astro の挙動に合わせている。** glob ローダは
 * `markdownContentEntryType.getEntryInfo` で `body: parsed.content.trim()` として
 * から processor に渡す（`astro/dist/vite-plugin-markdown/content-entry-type.js`）。
 * trim を忘れると先頭・末尾の空行の分だけ出力がずれる。
 *
 * **`render()` の第 2 引数を渡さないこと。** `fileURL` を渡すと
 * `remarkCollectImages` が動き出し（あれは `vfile.path` が文字列のときだけ働く）、
 * 相対パスの画像を集めて `rehypeImages` が `<img>` を `__ASTRO_IMAGE_` 属性に
 * 書き換える。admin には astro の画像パイプラインが無いので、渡すほうが出力が壊れる。
 * test/unit/preview-images.test.ts が「渡さないほうが site と一致する」ことを
 * 明示的に固定している。
 */
export const renderPreview = async (markdown: string): Promise<string> => {
  const { code } = await (await renderer()).render(markdown.trim());
  return code;
};
