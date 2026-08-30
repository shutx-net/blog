import {
  isUnifiedProcessor,
  markdownConfigDefaults,
  syntaxHighlightDefaults,
  unified,
} from '@astrojs/markdown-remark';
import { describe, expect, it } from 'vitest';

import siteConfig from '@blog/site/astro.config.mjs';
import { SHARED_RENDER_OPTIONS } from '../../src/preview/shared-options.ts';

/**
 * プレビュー一致の土台。
 *
 * astro は `markdown.processor.createRenderer(shared)` にちょうど 5 キーを渡す
 * （`astro/dist/content/content-layer.js` の `#processMarkdown`）:
 *
 *     { image, syntaxHighlight, shikiConfig, gfm, smartypants }
 *
 * admin はこの 5 キーを **site の設定と astro の既定から導出**して同じものを渡す。
 * ベタ書きするとastro を上げたときに admin だけが古い値に固定され、
 * **テストは緑のまま出力だけがずれる**という最悪の壊れ方をする。
 */
describe('site の astro.config.mjs を実モジュールとして読む', () => {
  it('markdown.processor が unified() である', () => {
    // クロスワークスペースの実モジュール import が admin の vitest ルートからも
    // 通ることの証明でもある（ワークスペースのシンボリックリンク依存）。
    expect(siteConfig.markdown.processor.name).toBe('unified');
    expect(isUnifiedProcessor(siteConfig.markdown.processor)).toBe(true);
  });

  it('**markdown が processor 以外のキーを持たない**', () => {
    // 誰かが markdown.gfm や markdown.shikiConfig を site に足したら、admin は
    // それを shared に載せないと出力がずれる。ここが赤くなることで追随を強制する。
    expect(Object.keys(siteConfig.markdown).sort()).toEqual(['processor']);
  });

  it('**image を設定していない**（未設定なので astro の既定が使われる）', () => {
    // image.domains / image.remotePatterns は remarkCollectImages にそのまま渡り、
    // リモート画像を収集するかどうかを決める。site が設定した瞬間に
    // admin の SHARED_RENDER_OPTIONS も追随しないと挙動がずれる。
    expect(siteConfig.image).toBeUndefined();
  });
});

describe('SHARED_RENDER_OPTIONS', () => {
  it('astro が processor に渡す 5 キーちょうどである', () => {
    expect(Object.keys(SHARED_RENDER_OPTIONS).sort()).toEqual([
      'gfm',
      'image',
      'shikiConfig',
      'smartypants',
      'syntaxHighlight',
    ]);
  });

  it('site の config と astro の既定から導出した値と一致する', () => {
    // 期待値は **その場で導出する**。markdownConfigDefaults は
    // @astrojs/markdown-remark の実物なので、astro を上げて既定が動けば
    // 期待値も実装も同時に動く（= site と admin がずれない）。
    expect(SHARED_RENDER_OPTIONS).toEqual({
      // site が image を設定していないので astro の zod 既定（どちらも []）。
      image: { domains: [], remotePatterns: [] },
      syntaxHighlight: syntaxHighlightDefaults,
      shikiConfig: markdownConfigDefaults.shikiConfig,
      gfm: undefined,
      smartypants: undefined,
    });
  });

  it('syntaxHighlight / shikiConfig が実物の既定への参照である（コピーではない）', () => {
    // toEqual だけだと「たまたま同じ形のベタ書き」でも通る。参照同一性まで見る。
    expect(SHARED_RENDER_OPTIONS.syntaxHighlight).toBe(syntaxHighlightDefaults);
    expect(SHARED_RENDER_OPTIONS.shikiConfig).toBe(markdownConfigDefaults.shikiConfig);
  });

  it('**gfm と smartypants が undefined である**', () => {
    // astro の zod スキーマ上どちらも `.optional()` で既定を持たない
    // （`astro/dist/core/config/schemas/base.js`）。undefined のまま渡すと
    // unified() 側の `processor.options.gfm ?? shared.gfm` を経て
    // createMarkdownProcessor の既定 true に落ちる。
    // **ここに true を書き込むと、将来 site が false にしたとき追随できない。**
    expect(SHARED_RENDER_OPTIONS.gfm).toBeUndefined();
    expect(SHARED_RENDER_OPTIONS.smartypants).toBeUndefined();
    expect('gfm' in SHARED_RENDER_OPTIONS).toBe(true);
    expect('smartypants' in SHARED_RENDER_OPTIONS).toBe(true);
  });

  it('syntaxHighlight が false でない（shiki が実際に走る設定である）', () => {
    // false にすると 4.3 のコーパスから astro-code が消える。
    // **公開済み記事にコードフェンスが 1 つも無いため、4.4 の dist 比較では
    // このドリフトを検出できない**（実測）。ここと 4.3 が唯一の防波堤。
    expect(SHARED_RENDER_OPTIONS.syntaxHighlight).not.toBe(false);
  });
});

describe('admin の processor が site と同じ引数で作られている', () => {
  it('unified() の options が site の processor の options と一致する', () => {
    // site が `unified({ remarkPlugins: [...] })` に変えたらここが赤くなり、
    // admin 側（src/preview/pipeline.ts）の追随を強制する。
    expect(unified().options).toEqual(siteConfig.markdown.processor.options);
  });

  it('site の processor が引数なしの unified() である（プラグイン追加が無い）', () => {
    const options = siteConfig.markdown.processor.options;
    expect(options.remarkPlugins).toEqual([]);
    expect(options.rehypePlugins).toEqual([]);
    expect(options.remarkRehype).toEqual({});
    expect(options.gfm).toBeUndefined();
    expect(options.smartypants).toBeUndefined();
  });
});
