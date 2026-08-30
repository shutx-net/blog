import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONTENT_TYPES,
  EXTENSIONS,
  MAX_UPLOAD_BYTES,
  MEDIA_KEY_PREFIX,
} from '../../src/media/limits.ts';

/**
 * `limits.ts` はブラウザ（`admin/`）から import される。
 * **依存が 1 つでも入ると、そこで壊れる。**
 */
describe('media/limits.ts は依存ゼロである', () => {
  const source = (): string =>
    readFileSync(fileURLToPath(new URL('../../src/media/limits.ts', import.meta.url)), 'utf8');

  it('import 文が 1 つも無い', () => {
    const imports = source()
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(
      imports,
      'limits.ts に import を足すとブラウザから読めなくなる。値の定義だけを置くこと',
    ).toEqual([]);
  });

  it('node の組み込みモジュールを参照していない', () => {
    // **コメントを除いてから走査する。** そうしないと、この制約を説明する
    // コメント（「presign.ts は node:crypto を読むので…」）自身が引っかかる。
    // ワークフローの `${ '$' }{{ }}` で同じ罠を踏んでいる。
    const code = source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bnode:/);
    expect(code).not.toMatch(/\bprocess\./);
  });

  it('中身が空になっていない（アサーションの空振り防止）', () => {
    expect(ALLOWED_CONTENT_TYPES.size).toBeGreaterThan(0);
    expect(Object.keys(EXTENSIONS).length).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MEDIA_KEY_PREFIX).toBe('media/');
  });

  it('許可 content type と拡張子表が 1 対 1 で対応している', () => {
    // 片方だけ足すと、許可されたのにキーを作れない content type が生まれる。
    expect(Object.keys(EXTENSIONS).sort()).toEqual([...ALLOWED_CONTENT_TYPES].sort());
  });

  it('実行可能になりうる content type を許可していない', () => {
    for (const dangerous of ['text/html', 'image/svg+xml', 'application/javascript']) {
      expect(ALLOWED_CONTENT_TYPES.has(dangerous), `${dangerous} は許可してはいけない`).toBe(false);
    }
  });
});
