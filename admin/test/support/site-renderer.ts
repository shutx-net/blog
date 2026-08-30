import { markdownConfigDefaults, syntaxHighlightDefaults } from '@astrojs/markdown-remark';
import type { AstroMarkdownOptions, MarkdownRenderer } from '@astrojs/markdown-remark';

import siteConfig from '@blog/site/astro.config.mjs';

/**
 * **site の設定だけから** shared オプションを導出する。
 *
 * `admin/src/preview/shared-options.ts` を参照してはいけない。参照すると
 * admin 側の設定ドリフトが期待値にも同じだけ伝播し、**両辺が一緒にずれて
 * テストが緑のまま**になる。プレビュー一致の証明は「独立に導いた 2 つの値が
 * 一致すること」でなければ意味がない。
 *
 * 導出規則は astro の実装の写し（`astro/dist/content/content-layer.js` の
 * `#processMarkdown` と `astro/dist/core/config/schemas/base.js` の zod 既定）。
 * astro が既定を変えれば `markdownConfigDefaults` 経由でこちらも動く。
 */
export const siteSharedRenderOptions = (): AstroMarkdownOptions => {
  const markdown = siteConfig.markdown;
  return {
    // zod 既定は domains / remotePatterns とも []。site は image を設定していない。
    image: siteConfig.image ?? { domains: [], remotePatterns: [] },
    syntaxHighlight: markdown.syntaxHighlight ?? syntaxHighlightDefaults,
    shikiConfig: markdown.shikiConfig ?? markdownConfigDefaults.shikiConfig,
    // どちらも zod で `.optional()`。既定を持たないので undefined のまま渡る。
    gfm: markdown.gfm,
    smartypants: markdown.smartypants,
  };
};

/**
 * site の processor が作る renderer。**期待値はここからしか作らない。**
 *
 * スナップショットで固定しないのは、スナップショットが「admin の出力を
 * そのまま焼き付けたもの」になりうるから。site の processor を毎回動かせば、
 * site 側が変わったときも admin 側が変わったときも必ず赤くなる。
 *
 * shiki の wasm 読み込みを伴うのでモジュール内で 1 度だけ作る。
 */
let cached: Promise<MarkdownRenderer> | undefined;

export const siteRenderer = (): Promise<MarkdownRenderer> => {
  cached ??= siteConfig.markdown.processor.createRenderer(siteSharedRenderOptions());
  return cached;
};

/**
 * site 側で 1 記事を描く。
 *
 * **`.trim()` は astro の glob ローダの挙動**（`markdownContentEntryType.getEntryInfo`
 * が `body: parsed.content.trim()` で渡す）。**fileURL は渡さない** — admin には
 * astro の画像パイプラインが無いので、渡すと `rehypeImages` が `<img>` を
 * `__ASTRO_IMAGE_` 属性に書き換えて比較が壊れる（4.5 で明示的に固定している）。
 */
export const renderWithSiteProcessor = async (markdown: string): Promise<string> => {
  const { code } = await (await siteRenderer()).render(markdown.trim());
  return code;
};
