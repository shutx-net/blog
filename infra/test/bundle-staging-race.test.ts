import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystem } from 'aws-cdk-lib/core';
import { describe, expect, it } from 'vitest';

import { scratchDir } from '../../api/test/support/scratch.ts';

/**
 * **infra のテストが断続的に落ちていた競合を、実際に起こして塞がっていることを見る。**
 *
 * 症状は `ENOENT: stat 'api/dist/index.mjs.<pid>.tmp'` が
 * `_contentFingerprint` から投げられるもの。CDK は `readdirSync` でディレクトリを
 * 先に列挙し、そのあとループの中で各エントリを `statSync` する
 * （aws-cdk-lib/core/lib/fs/fingerprint.js）。書きかけを成果物のディレクトリに
 * 置いていたため、列挙に写ってから stat の前に rename で消えていた。
 *
 * **失敗すると infra のテストはファイルごと実行されずに終わる**（480 件が 439 件に
 * なる）ので、件数を見ていないと緑に見えた。
 *
 * **このテストの限界を正直に書いておく。** 競合は確率的なので、これは
 * 「窓が開いていない」ことの証明ではなく「開いていれば高確率で見つかる」網である。
 * 実測: 書きかけを dist の中に置く実装では 5 試行 5 回とも再現し、1 試行あたり
 * 200〜800 件のエラーが出た。修正後は 0 件。時間を延ばせば網は細かくなるが、
 * テストの実行時間と引き換えになるので下の DURATION_MS で妥協している。
 */

const BUILD_MODULE = fileURLToPath(new URL('../../api/build.ts', import.meta.url));

/** 網の細かさと実行時間の妥協点。修正前の実装ならこの長さで必ず再現する。 */
const DURATION_MS = 1_500;

/** 同時に書き込むプロセス数。1 では窓が開かない（自分の rename を自分で待つため）。 */
const BUILDERS = 2;

const builderSource = `
import { buildApiBundle } from ${JSON.stringify(BUILD_MODULE)};

const dir = process.env['RACE_DIR'];
const deadline = Date.now() + Number(process.env['RACE_MS']);
const entries = [dir + '/a.ts', dir + '/b.ts'];
let writes = 0;
while (Date.now() < deadline) {
  buildApiBundle({ entry: entries[writes % 2], outfile: dir + '/out/index.mjs' });
  writes += 1;
}
process.stdout.write(String(writes));
`;

const startBuilder = (dir: string): Promise<{ code: number | null; writes: number }> => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', builderSource], {
    env: { ...process.env, RACE_DIR: dir, RACE_MS: String(DURATION_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += String(chunk)));
  child.stderr.on('data', (chunk) => (out += String(chunk)));

  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, writes: Number.parseInt(out, 10) || 0 }));
  });
};

describe('成果物のディレクトリを固めるあいだの書き込み', () => {
  it('**書き込みと同時に指紋を取っても ENOENT にならない**', async () => {
    const dir = scratchDir('blog-race-');
    // 中身の違う 2 つのエントリを交互に使い、毎回 rename が起きるようにする。
    // 同じ内容だと alreadyWritten が真になって書き込みが止まり、窓が開かない。
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, 'b.ts'), 'export const b = "bbbbbbbbbbbbbbbbbbbb";\n', 'utf8');

    const builders = Array.from({ length: BUILDERS }, () => startBuilder(dir));

    const outDir = join(dir, 'out');

    // **最初の 1 本が書かれるまで待つ。** 待たずに数え始めると、まだ存在しない
    // ディレクトリへの lstat が ENOENT を積み上げ、競合とは無関係な理由で赤くなる。
    const appeared = Date.now() + DURATION_MS;
    while (!existsSync(join(outDir, 'index.mjs')) && Date.now() < appeared) {
      // ビルダーは別プロセスなので、ここは同期の待ちで足りる。
    }
    expect(existsSync(join(outDir, 'index.mjs'))).toBe(true);

    const deadline = Date.now() + DURATION_MS;
    const errors: string[] = [];
    let loops = 0;
    while (Date.now() < deadline) {
      loops += 1;
      try {
        FileSystem.fingerprint(outDir);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }

    const results = await Promise.all(builders);

    // **空虚に緑にならないための足場。** 指紋を 1 度も取っていない、あるいは
    // 書き込みが 1 度も起きていないなら、このテストは何も見ていない。
    expect(loops).toBeGreaterThan(0);
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.reduce((sum, r) => sum + r.writes, 0)).toBeGreaterThan(BUILDERS);

    expect(errors).toEqual([]);
  }, 30_000);
});
