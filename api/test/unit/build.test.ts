import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { API_BUNDLE_DIR, API_BUNDLE_FILE, API_ENTRY, buildApiBundle, stagingPathFor } from '../../build.ts';

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

describe('書きかけの置き場', () => {
  /**
   * **これが競合の本体だった。**
   *
   * infra は `Code.fromAsset(API_BUNDLE_DIR)` で dist を丸ごと固める。CDK は
   * `readdirSync` でディレクトリを先に列挙し、そのあと各エントリを `statSync` する。
   * 書きかけを dist の中に置くと、列挙に写ってから stat の前に rename で消え、
   * `ENOENT` で synth が落ちる。実測で並列 2 プロセス 4 秒あたり 200〜800 件出ていた。
   */
  it('**書きかけを outfile のディレクトリの中に置かない**', () => {
    const staging = stagingPathFor(API_BUNDLE_FILE);

    expect(staging.startsWith(`${API_BUNDLE_DIR}/`)).toBe(false);
    expect(dirname(staging)).not.toBe(API_BUNDLE_DIR);
  });

  it('任意の outfile でも、その親ディレクトリの外に置く', () => {
    const dir = tempWorkspace();
    const outfile = join(dir, 'out', 'index.mjs');

    const staging = stagingPathFor(outfile);

    expect(staging.startsWith(`${join(dir, 'out')}/`)).toBe(false);
  });

  it('同時に走るプロセス同士でぶつからない名前にする', () => {
    expect(stagingPathFor(API_BUNDLE_FILE)).toContain(String(process.pid));
  });

  /**
   * **この主張はこのバグを捕まえない。** rename のあとに見ているので、書きかけを
   * dist の中に置く実装でも通る。捕まえるのは「staging を消し忘れて残骸が積む」
   * 別の壊れ方のほう。競合そのものを見ているのは
   * infra/test/bundle-staging-race.test.ts と、この上の 2 件である。
   */
  it('ビルドのあと、成果物のディレクトリには出力ファイルしか無い', () => {
    const dir = tempWorkspace();
    const entry = writeEntry(dir, 'export const value = 1;\n');
    const outfile = join(dir, 'out', 'index.mjs');

    buildApiBundle({ entry, outfile });

    expect(readdirSync(join(dir, 'out'))).toEqual(['index.mjs']);
  });
});
