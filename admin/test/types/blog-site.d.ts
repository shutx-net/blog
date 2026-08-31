/**
 * `@blog/site/astro.config.mjs` の最小宣言。
 *
 * 素の `.mjs` には型宣言が無いので、`noImplicitAny` の下では TS7016
 * （宣言ファイルが見つからない）になる。`api/test/js-yaml.d.ts` と同じ手口で、
 * **テストからだけ**使う最小の形をここで宣言する。ブラウザに配る側は
 * この設定ファイルを import しない（`astro/config` と `@astrojs/sitemap` を
 * 引き込むため。計画の toolchain.rationale 参照）。
 *
 * **形を自前で書き下さないこと。** `@astrojs/markdown-remark` の公開型を借りている。
 * 自前定義にすると astro を上げたとき型だけが古いまま食い違いを隠す
 * （実測: `image` を `unknown[]` で書いたら `RemotePattern[]` と非互換で tsc が落ちた）。
 */
declare module '@blog/site/astro.config.mjs' {
  import type {
    AstroMarkdownOptions,
    MarkdownProcessor,
    UnifiedResolvedOptions,
  } from '@astrojs/markdown-remark';

  /**
   * astro の `defineConfig` は入力をそのまま返す（zod による解決はビルド時に別途走る）。
   * したがってここに見えるのは **書いたとおりの値** であって、既定値が入った後の
   * 解決済み設定ではない。`image` が undefined であることを test が主張しているのは
   * そのため — 未設定なら astro の既定（domains: [], remotePatterns: []）が使われる。
   */
  const config: {
    site: string;
    integrations: unknown[];
    markdown: {
      processor: MarkdownProcessor<UnifiedResolvedOptions>;
    } & Omit<AstroMarkdownOptions, 'image'>;
    image?: AstroMarkdownOptions['image'];
  };

  export default config;
}
