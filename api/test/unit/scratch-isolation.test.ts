import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **テストが `os.tmpdir()` に書かないことを固定する。**
 *
 * `github-token.test.ts` の「一時ディレクトリにファイルを作らない」は、
 * installation token をディスクに残さないという設計判断を `readdirSync(tmpdir())` の
 * 前後スナップショットで確認している。**同時に走るどのプロセスであれ tmpdir に
 * ディレクトリを作れば、あの主張は落ちる。**
 *
 * 実際に 4 つのテストがそこへ書いており（api の build、infra の deploy-guard /
 * freshness / race）、`infra` と `api` の同時実行で断続的に赤くなっていた。
 * **あのセキュリティテストを緩めるのは誤り。直すのは書く側**で、置き場は
 * `api/test/support/scratch.ts` の `scratchDir`（リポジトリ配下）に統一してある。
 *
 * 同じ形の事故が 3 回起きている: `api/dist` を共有して壊す、書きかけを
 * `Code.fromAsset` の対象に置く、そして `os.tmpdir()`。**プロセスを跨いで見える
 * 場所に書くテストは、他のスイートから観測されうる。**
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 走査対象。**admin と site も含める** — 同時に走れば同じことが起きる。 */
const TEST_DIRS = ['api/test', 'infra/test', 'admin/test', 'site/test'];

/**
 * 読む側だけは例外。ここが監視の主体で、tmpdir を参照しないと成立しない。
 */
const READER = 'api/test/unit/github-token.test.ts';

/**
 * **コメントを剥がしてから走査する。**
 *
 * 剥がさないと、この不変条件を説明した散文そのものに引っかかる。
 * 実際に同じ罠を踏んだことがある（`secrets.` を禁じる主張がコメントで落ちた）。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 探すパターンを**組み立てて**作る。
 *
 * 正規表現リテラルにそのまま書くと、この主張がこのファイル自身を違反として数える。
 * 除外リストで逃げると、ガードが自分に適用されなくなる。**組み立てれば両方避けられる。**
 */
const FORBIDDEN = new RegExp(`\\b${['tmp', 'dir'].join('')}\\s*\\(`);

const walk = (dir: string): string[] => {
  const entries = readdirSync(dir, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);

    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
};

describe('テストの一時ファイルの置き場', () => {
  // 題名に禁止したい呼び出しをそのまま書くと、この主張が自分を違反として数える。
  it('**どのテストも OS の一時ディレクトリに書かない**', () => {
    const offenders = TEST_DIRS.flatMap((relative) => walk(join(REPO_ROOT, relative)))
      .filter((file) => !file.endsWith(READER))
      .filter((file) => FORBIDDEN.test(stripComments(readFileSync(file, 'utf8'))));

    expect(offenders.map((file) => file.slice(REPO_ROOT.length))).toEqual([]);
  });

  it('走査が空振りしていない（対象ファイルを実際に読んでいる）', () => {
    const files = TEST_DIRS.flatMap((relative) => walk(join(REPO_ROOT, relative)));

    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith(READER))).toBe(true);
  });
});
