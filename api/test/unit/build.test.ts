import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { API_BUNDLE_FILE, API_ENTRY, buildApiBundle } from '../../build.ts';

/**
 * **ビルドの定義がここに 1 つだけあることを固定する。**
 *
 * 事故の経緯: infra は `lambda.Code.fromAsset('api/dist')` でディスク上の成果物を
 * そのまま固める。変異テストが pretest 経由で dist を汚し、ソースだけ戻したため、
 * **ソースと本番の Lambda が 6 バイト食い違ったまま** デプロイされた。
 * テストは 2119 件緑、git status もクリーンで、誰も気づかなかった。
 *
 * だから「成果物が古くないか確かめる」ではなく、**synth のたびにソースから作り直す**。
 * このファイルはその生成器そのものを、実際に走らせて検証する。
 */

const tempWorkspace = (): string => mkdtempSync(join(tmpdir(), 'blog-api-build-'));

/** テスト用の自己完結したエントリを書き、そのパスを返す。 */
const writeEntry = (dir: string, source: string, name = 'entry.ts'): string => {
  const path = join(dir, name);
  writeFileSync(path, source, 'utf8');

  return path;
};

describe('buildApiBundle', () => {
  it('ソースから実際にバンドルを生成する', () => {
    const dir = tempWorkspace();
    // 定数畳み込みが起きる形にしておく。**出力を実際に読んで確かめる**ため、
    // 「ソースをそのままコピーしただけ」では通らない主張になる。
    const entry = writeEntry(dir, 'export const answer = 40 + 2;\n');
    const outfile = join(dir, 'out', 'index.mjs');

    const written = buildApiBundle({ entry, outfile });

    expect(written).toBe(outfile);
    expect(existsSync(outfile)).toBe(true);
    expect(readFileSync(outfile, 'utf8')).toContain('42');
  });

  it('**古い成果物を、いまのソースで作り直したもので上書きする**', () => {
    // これが事故そのもの。**成果物が残っていても、内容が古ければ意味がない。**
    const dir = tempWorkspace();
    const entry = writeEntry(dir, 'export const marker = "fresh-content";\n');
    const outfile = join(dir, 'out', 'index.mjs');

    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(outfile, 'export const marker = "stale-content";\n', 'utf8');

    buildApiBundle({ entry, outfile });

    const built = readFileSync(outfile, 'utf8');
    expect(built).toContain('fresh-content');
    expect(built, '古い内容が残っている').not.toContain('stale-content');
  });

  it('別のソースを渡せば別の中身になる（結果を使い回さない）', () => {
    const dir = tempWorkspace();
    const outfile = join(dir, 'out', 'index.mjs');

    buildApiBundle({ entry: writeEntry(dir, 'export const v = "one";\n', 'a.ts'), outfile });
    expect(readFileSync(outfile, 'utf8')).toContain('one');

    buildApiBundle({ entry: writeEntry(dir, 'export const v = "two";\n', 'b.ts'), outfile });
    const second = readFileSync(outfile, 'utf8');
    expect(second).toContain('two');
    expect(second).not.toContain('one');
  });

  it('出力先のディレクトリが無ければ作る', () => {
    const dir = tempWorkspace();
    const entry = writeEntry(dir, 'export const x = 1;\n');
    const outfile = join(dir, 'does', 'not', 'exist', 'index.mjs');

    buildApiBundle({ entry, outfile });

    expect(existsSync(outfile)).toBe(true);
  });

  it('**Lambda が読める ESM として出力する**', () => {
    // .mjs を CommonJS として読ませると起動時に SyntaxError で落ちる。
    // banner の createRequire が無いと、CJS only の推移依存を読んだ時点で落ちる。
    const dir = tempWorkspace();
    const entry = writeEntry(dir, 'export const handler = () => 1;\n');
    const outfile = join(dir, 'out', 'index.mjs');

    const built = readFileSync(buildApiBundle({ entry, outfile }), 'utf8');

    expect(built).toContain('createRequire');
    expect(built).toMatch(/^import /);
  });

  it('既定の入出力が api のエントリと dist/index.mjs である', () => {
    // infra はこの既定値の場所を Code.fromAsset に渡す。ずれると別物が固められる。
    expect(API_ENTRY.endsWith('/api/src/index.ts')).toBe(true);
    expect(API_BUNDLE_FILE.endsWith('/api/dist/index.mjs')).toBe(true);
  });

  it('引数なしで呼ぶと api/dist/index.mjs を実ソースから作る', () => {
    const written = buildApiBundle();

    expect(written).toBe(API_BUNDLE_FILE);
    // 実ソースの中身が反映されていること。dispatch の成功判定は 2xx である。
    expect(readFileSync(written, 'utf8')).toContain('t>=200&&t<300');
  });
});
