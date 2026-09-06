import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { afterEach, describe, expect, it } from 'vitest';

import { API_BUNDLE_FILE } from '../../api/build.ts';
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
 * `npm run build -w ../api` を先に走らせるので、テストが始まる時点で dist は必ず新鮮。
 * 検知したい状況を、テスト自身の準備が壊している。
 *
 * だからここでは **dist を実際に汚してから合成し、直っていることを見る。**
 * 「新鮮かどうか調べる」実装では、調べる入力の選び方に必ず取りこぼしが残る
 * （node_modules の入れ替え、mtime を保つコピー）。作り直す実装にはそれが無い。
 */

/** 汚染の目印。バンドルの出力にこの文字列が現れることはない。 */
const CORRUPTION = '/* stale bundle planted by lambda-bundle-freshness.test.ts */';

const synthesizeSiteStack = (): void => {
  // Code.fromAsset はコンストラクト生成時にアセットを読む。合成まで進める必要はない。
  new SiteStack(new App(), 'BundleFreshnessStack');
};

afterEach(() => {
  // 何が起きてもリポジトリに壊れた成果物を残さない。
  synthesizeSiteStack();
});

describe('Lambda のバンドルは synth のたびにソースから作り直される', () => {
  it('**古い成果物を置いてから合成すると、作り直されている**', () => {
    writeFileSync(API_BUNDLE_FILE, CORRUPTION, 'utf8');
    expect(readFileSync(API_BUNDLE_FILE, 'utf8')).toBe(CORRUPTION);

    synthesizeSiteStack();

    const built = readFileSync(API_BUNDLE_FILE, 'utf8');
    expect(built, '古い成果物がそのまま残っている').not.toContain(CORRUPTION);
    // 中身が本物のバンドルであること。空ファイルで置き換えても通る主張にしない。
    expect(built.length).toBeGreaterThan(100_000);
    expect(built).toContain('createRequire');
  });

  it('**成果物が消えていても合成できる**', () => {
    rmSync(API_BUNDLE_FILE, { force: true });
    expect(existsSync(API_BUNDLE_FILE)).toBe(false);

    synthesizeSiteStack();

    expect(existsSync(API_BUNDLE_FILE)).toBe(true);
  });

  it('**固められる中身がいまのソースを反映している**', () => {
    writeFileSync(API_BUNDLE_FILE, CORRUPTION, 'utf8');

    synthesizeSiteStack();

    // dispatch の成功判定は 2xx。204 ちょうどに戻す変異が本番に載った事故の再発検知。
    expect(readFileSync(API_BUNDLE_FILE, 'utf8')).toContain('t>=200&&t<300');
  });
});
