import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **テストが一時ファイルを置く場所。`os.tmpdir()` を使ってはならない。**
 *
 * `api/test/unit/github-token.test.ts` は「installation token をディスクに残さない」
 * という設計判断を、`readdirSync(tmpdir())` の前後スナップショットで確認している。
 * **同時に走るどのプロセスであれ tmpdir にディレクトリを作れば、あの主張は落ちる。**
 * 実際に 4 つのテストがそこへ書いており、同時実行で断続的に赤くなっていた。
 *
 * あのテストを緩めるのは誤り — 守りたい性質そのものだから。**直すのは書く側。**
 * 置き場をリポジトリ配下にすれば、tmpdir のスナップショットに写らない。
 *
 * 同じ形の事故が既に 2 回起きている（`api/dist` を共有して壊す、
 * 書きかけを `Code.fromAsset` の対象ディレクトリに置く）。**プロセスを跨いで
 * 見える場所に書くテストは、他のスイートから観測されうる。**
 */
export const SCRATCH_ROOT = fileURLToPath(new URL('../../../.test-scratch/', import.meta.url));

/** `prefix` で始まる、このテスト専用のディレクトリを作って返す。 */
export const scratchDir = (prefix: string): string => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });

  return mkdtempSync(join(SCRATCH_ROOT, prefix));
};
