import { markdownConfigDefaults, syntaxHighlightDefaults } from '@astrojs/markdown-remark';
import type { AstroMarkdownOptions } from '@astrojs/markdown-remark';

/**
 * astro が `markdown.processor.createRenderer(shared)` に渡す 5 キー。
 *
 * 導出元は astro の実装そのもの（`astro/dist/content/content-layer.js` の
 * `#processMarkdown`）:
 *
 *     markdown.processor.createRenderer({
 *       image,                              // astro.config.mjs の image（未設定なら zod の既定）
 *       syntaxHighlight: markdown.syntaxHighlight,
 *       shikiConfig:     markdown.shikiConfig,
 *       gfm:             markdown.gfm,
 *       smartypants:     markdown.smartypants,
 *     })
 *
 * **マップ型で 5 キーを必須にしている。** `Partial` のままだと 1 つ書き忘れても
 * 型が通り、プレビューだけが静かにずれる。ここは「忘れられないこと」が要件なので、
 * 値が undefined でよいキーもプロパティ自体は必須にする。
 */
export type SharedRenderOptions = {
  [K in 'image' | 'syntaxHighlight' | 'shikiConfig' | 'gfm' | 'smartypants']: AstroMarkdownOptions[K];
};

/**
 * site と 1 バイト違わない HTML を出すための共有オプション。
 *
 * **このモジュールはブラウザ安全でなければならない。**
 * `@blog/site/astro.config.mjs` を import してはいけない — あれは `astro/config` と
 * `@astrojs/sitemap` と `./src/site-url.ts` を引き込む。import してよいのは
 * `@astrojs/markdown-remark` の公開エクスポートだけ。
 * site の設定が変わっていないことは test/unit/preview-shared-options.test.ts が
 * （node 環境で実物を読んで）主張しており、**片方向ではなく両方向から掛かっている。**
 *
 * **値をベタ書きしないこと。** `markdownConfigDefaults` / `syntaxHighlightDefaults` は
 * @astrojs/markdown-remark の実物なので、astro を上げて既定が動けば admin も
 * 自動で追随する。ベタ書きすると admin だけが古い値に固定され、
 * 「テストは通るのに出力がずれる」という最悪の壊れ方をする。
 */
export const SHARED_RENDER_OPTIONS: SharedRenderOptions = {
  // site/astro.config.mjs は image を設定していないので astro の zod 既定。
  // どちらも空なので `isRemoteAllowed` が常に false になり、リモート画像は
  // 収集されない（= admin が fileURL を渡さなくても出力が一致する根拠の半分）。
  image: { domains: [], remotePatterns: [] },
  syntaxHighlight: syntaxHighlightDefaults,
  shikiConfig: markdownConfigDefaults.shikiConfig,
  // **undefined のまま渡す。** astro の zod スキーマ上どちらも `.optional()` で
  // 既定を持たない。unified() 側の `processor.options.gfm ?? shared.gfm` を経て
  // createMarkdownProcessor の既定 true に落ちる。ここに true を書き込むと、
  // 将来 site が false にしたときに追随できなくなる。
  gfm: undefined,
  smartypants: undefined,
};
