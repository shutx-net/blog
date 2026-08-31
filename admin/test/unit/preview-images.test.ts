import { unified } from '@astrojs/markdown-remark';
import type { MarkdownRenderer } from '@astrojs/markdown-remark';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  RELATIVE_IMAGE_WARNING,
  relativeImagePaths,
} from '../../src/preview/images.ts';
import { SHARED_RENDER_OPTIONS } from '../../src/preview/shared-options.ts';
import { renderPreview } from '../../src/preview/pipeline.ts';

/**
 * admin が `render()` に fileURL を渡さない設計の正当性そのもの。
 *
 * astro のビルドでは fileURL が渡るので `remarkCollectImages` が動き、
 * 集まった画像を `rehypeImages` が `__ASTRO_IMAGE_` 属性に書き換えて、その後
 * astro の画像パイプラインが実 `<img>` を作る。**admin にはそのパイプラインが無い。**
 *
 * ただし `remarkCollectImages` が集めるのは
 *   - `URL.canParse(url)` かつ `isRemoteAllowed`（domains / remotePatterns 由来）
 *   - `/` で始まらないローカルパス
 * の 2 種類だけで、site は image を設定していないので前者は常に空になる。
 * つまり **乖離するのは相対パスの画像だけ**であり、それは AGENTS.md が禁じている
 * 書き方でもある（本番のビルドが落ちる）。
 */
const FILE_URL = new URL('file:///repo/site/src/content/posts/example.md');

let renderer: MarkdownRenderer;

beforeAll(async () => {
  renderer = await unified().createRenderer(SHARED_RENDER_OPTIONS);
});

const renderWithFileUrl = async (markdown: string): Promise<string> => {
  const { code } = await renderer.render(markdown.trim(), { fileURL: FILE_URL });
  return code;
};

describe('fileURL の有無で出力が変わらない書き方', () => {
  it('/media/... の画像は fileURL の有無で完全一致する', async () => {
    const markdown = '![アップロード](/media/2026/08/x.png)';
    // `/` 始まりは remarkCollectImages が localImagePaths に入れない
    // （`!url.startsWith('/')` の条件に掛からない）。
    expect(await renderPreview(markdown)).toBe(await renderWithFileUrl(markdown));
  });

  it('https:// の画像は fileURL の有無で完全一致する', async () => {
    const markdown = '![リモート](https://example.com/x.png)';
    // 既定の image.domains / image.remotePatterns が空なので isRemoteAllowed が
    // 常に false になり、remoteImagePaths に入らない。
    expect(await renderPreview(markdown)).toBe(await renderWithFileUrl(markdown));
  });

  it('コーパスの images.md 全体が fileURL の有無で完全一致する', async () => {
    const markdown = [
      '![a](/media/2026/08/a.png)',
      '',
      '![b](https://example.com/b.png "title")',
      '',
      '![c][ref]',
      '',
      '[ref]: /media/2026/08/c.png',
    ].join('\n');
    expect(await renderPreview(markdown)).toBe(await renderWithFileUrl(markdown));
  });
});

describe('**相対パスだけが乖離する**', () => {
  const markdown = '![相対](./x.png)';

  it('fileURL 有りでは __ASTRO_IMAGE_ が現れる', async () => {
    expect(await renderWithFileUrl(markdown)).toContain('__ASTRO_IMAGE_');
  });

  it('fileURL 無しでは __ASTRO_IMAGE_ が現れない', async () => {
    expect(await renderPreview(markdown)).not.toContain('__ASTRO_IMAGE_');
  });

  it('この 1 件だけが一致しない', async () => {
    // **乖離が相対パスのときだけ起きることを明示的に固定する。** これが
    // 「プレビューが一致しない入力は、そもそも公開できない入力である」という
    // 閉じ方の根拠になる。
    expect(await renderPreview(markdown)).not.toBe(await renderWithFileUrl(markdown));
  });
});

describe('relativeImagePaths', () => {
  it.each([
    ['![a](./x.png)', ['./x.png']],
    ['![a](x.png)', ['x.png']],
    ['![a](../up/x.png)', ['../up/x.png']],
    ['![a](./x.png "title")', ['./x.png']],
    ['![a](<./sp ace.png>)', ['./sp ace.png']],
    ['![a][ref]\n\n[ref]: ./x.png', ['./x.png']],
  ])('%s を検出する', (markdown, expected) => {
    expect(relativeImagePaths(markdown)).toEqual(expected);
  });

  it.each([
    ['![a](/media/x.png)'],
    ['![a](/media/2026/08/x.png)'],
    ['![a](https://h/x.png)'],
    ['![a](http://h/x.png)'],
    ['![a](data:image/png;base64,AAAA)'],
    ['![a][ref]\n\n[ref]: /media/x.png'],
    // 画像ではなくリンク。相対でも警告しない（壊れるのは画像だけ）。
    ['[a](./page.md)'],
  ])('%s は検出しない', (markdown) => {
    expect(relativeImagePaths(markdown)).toEqual([]);
  });

  it('コードフェンスの中の相対パス画像を検出しない', () => {
    // Markdown の書き方を記事で説明しているだけの本文で、送信が止まると困る。
    expect(relativeImagePaths('```md\n![a](./x.png)\n```')).toEqual([]);
  });

  it('インラインコードの中の相対パス画像を検出しない', () => {
    expect(relativeImagePaths('`![a](./x.png)` と書く')).toEqual([]);
  });

  it('同じパスが 2 回出ても 1 件にまとまる', () => {
    expect(relativeImagePaths('![a](./x.png)\n\n![b](./x.png)')).toEqual(['./x.png']);
  });

  it('複数の相対パスを出現順に返す', () => {
    expect(relativeImagePaths('![a](./a.png)\n\n![b](./b.png)')).toEqual(['./a.png', './b.png']);
  });

  it('本文が空でも落ちない', () => {
    expect(relativeImagePaths('')).toEqual([]);
  });
});

describe('警告文言', () => {
  it('site のビルドが落ちることと、正しい書き方の両方を言う', () => {
    expect(RELATIVE_IMAGE_WARNING).toContain('相対パス');
    expect(RELATIVE_IMAGE_WARNING).toContain('ビルドを落とす');
    expect(RELATIVE_IMAGE_WARNING).toContain('/media/');
  });
});
