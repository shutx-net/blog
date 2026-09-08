import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';

import { scratchDir } from '../../api/test/support/scratch.ts';

import { API_BUNDLE_FILENAME } from '../../api/build.ts';
import { SiteStack } from '../lib/site-stack.ts';

/**
 * **synth が、いまのソースから作り直したバンドルを固めることを固定する。**
 *
 * 事故: `lambda.Code.fromAsset('api/dist')` はディスク上の成果物をそのまま固める。
 * 変異テストが pretest 経由で dist を汚し、ソースだけ戻したので、**本番の Lambda が
 * ソースと 6 バイト食い違ったまま動いた**（GitHub が返す 200 を失敗と判定した）。
 * テスト 2119 件は緑、`git status` もクリーンだった。
 *
 * **既存の synth-artifact.test.ts はこれを捕まえられない。** infra の pretest が
 * `cdk synth` を先に走らせるので、テストが始まる時点で dist は必ず新鮮。
 * 検知したい状況を、テスト自身の準備が壊している。
 *
 * だからここでは **成果物を実際に汚してから合成し、直っていることを見る。**
 * 「新鮮かどうか調べる」実装では、調べる入力の選び方に必ず取りこぼしが残る
 * （node_modules の入れ替え、mtime を保つコピー）。作り直す実装にはそれが無い。
 *
 * **汚すのは本物の `api/dist` ではなく、このテスト専用のディレクトリ。**
 * かつては本物を `writeFileSync` で壊し `rmSync` で消していたため、同時に走る
 * `site-stack.test.ts` の synth や `api` の `bundle.test.ts` が、消えた成果物を
 * 読んで断続的に落ちていた（`ENOENT: stat 'api/dist/index.mjs'`）。
 * **成果物は 2 つのテストスイートが共有する可変状態で、そこを片方が壊していた。**
 * seam は `SiteStackProps.apiBundleDir`。既定が本物であることは
 * posting-api.test.ts が別に固定している。
 */

/** 汚染の目印。バンドルの出力にこの文字列が現れることはない。 */
const CORRUPTION = '/* stale bundle planted by lambda-bundle-freshness.test.ts */';

/** このテスト専用の成果物ディレクトリを 1 つ作る。 */
const isolatedBundleDir = (): string => join(scratchDir('blog-freshness-'), 'dist');

/**
 * 隔離したディレクトリを指して合成する。
 *
 * Code.fromAsset はコンストラクト生成時にアセットを読むので、合成まで進める必要はない。
 * 返すのは、その中の成果物のパス。
 */
const synthesizeInto = (bundleDir: string): string => {
  new SiteStack(new App(), 'BundleFreshnessStack', { apiBundleDir: bundleDir });

  return join(bundleDir, API_BUNDLE_FILENAME);
};

describe('Lambda のバンドルは synth のたびにソースから作り直される', () => {
  it('**古い成果物を置いてから合成すると、作り直されている**', () => {
    const bundleDir = isolatedBundleDir();
    // まず 1 度作らせてから汚す。「無いから作った」ではなく「あるものを作り直した」を見る。
    const bundle = synthesizeInto(bundleDir);
    writeFileSync(bundle, CORRUPTION, 'utf8');
    expect(readFileSync(bundle, 'utf8')).toBe(CORRUPTION);

    synthesizeInto(bundleDir);

    const built = readFileSync(bundle, 'utf8');
    expect(built, '古い成果物がそのまま残っている').not.toContain(CORRUPTION);
    // 中身が本物のバンドルであること。空ファイルで置き換えても通る主張にしない。
    expect(built.length).toBeGreaterThan(100_000);
    expect(built).toContain('createRequire');
  });

  it('**成果物が消えていても合成できる**', () => {
    const bundleDir = isolatedBundleDir();
    const bundle = synthesizeInto(bundleDir);
    rmSync(bundle, { force: true });
    expect(existsSync(bundle)).toBe(false);

    synthesizeInto(bundleDir);

    expect(existsSync(bundle)).toBe(true);
  });

  it('**固められる中身がいまのソースを反映している**', () => {
    const bundleDir = isolatedBundleDir();
    const bundle = synthesizeInto(bundleDir);
    writeFileSync(bundle, CORRUPTION, 'utf8');

    synthesizeInto(bundleDir);

    // dispatch の成功判定は 2xx。204 ちょうどに戻す変異が本番に載った事故の再発検知。
    expect(readFileSync(bundle, 'utf8')).toContain('t>=200&&t<300');
  });
});
