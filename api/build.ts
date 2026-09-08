import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { BuildOptions } from 'esbuild';

/**
 * Lambda のバンドルを作る、**ただ 1 つの定義**。
 *
 * `npm run -w api build` も、infra の synth も、ここを呼ぶ。
 *
 * なぜ 1 つにまとめるか。infra は `lambda.Code.fromAsset('api/dist')` で
 * **ディスク上の成果物をそのまま固める**。ビルドの定義が package.json の
 * スクリプトと infra の 2 箇所にあると、片方だけ変えた日に「テストが検証した
 * バンドル」と「本番に載るバンドル」が別物になる。**それを型でもテストでも
 * 検出できない**のは、この工事で実際に起きた事故と同じ形である。
 *
 * 事故の記録: 変異テストが pretest 経由で dist を汚し、ソースだけ復旧したため、
 * ソースと本番の Lambda が 6 バイト食い違ったままデプロイされた
 * （dispatch の成功判定が 2xx ではなく 204 ちょうどのままだった）。
 * テスト 2119 件は緑、`git status` もクリーンで、誰も気づかなかった。
 */

/** esbuild が展開する起点。 */
export const API_ENTRY = fileURLToPath(new URL('./src/index.ts', import.meta.url));

/** infra が `Code.fromAsset` に渡すディレクトリ。 */
export const API_BUNDLE_DIR = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * バンドルの出力先。
 *
 * **拡張子は `.mjs` でなければならない。** `.js` にすると node が package.json の
 * `"type"` を見に行き、Lambda のアセットには package.json が無いので CommonJS として
 * 読み、起動時に SyntaxError で落ちる。
 */
export const API_BUNDLE_FILE = `${API_BUNDLE_DIR}/index.mjs`;

/**
 * 書きかけのバンドルを置く場所。**`outfile` のディレクトリの外**でなければならない。
 *
 * infra は `lambda.Code.fromAsset(API_BUNDLE_DIR)` で dist を丸ごと固める。CDK の
 * 指紋計算は `readdirSync` で**ディレクトリ全体を先に列挙**し、そのあとループの中で
 * 各エントリを `statSync` する（aws-cdk-lib/core/lib/fs/fingerprint.js の
 * `_processDirectory` と `_contentFingerprint`）。列挙に写ってから stat される前に
 * rename で消えるファイルがあると ENOENT で落ちる。
 *
 * 事故の記録: staging を dist の中に `index.mjs.<pid>.tmp` として置いていたため、
 * vitest の並列ワーカーが同時に synth すると infra のテストが断続的に落ちていた。
 * **失敗するとファイルごと実行されずに終わるので、件数を見ないと緑に見える**
 * （480 件が 439 件になる）。
 *
 * `dist` の 1 つ上に置くのは、rename が不可分であるためには同じファイルシステムに
 * なければならないから。`os.tmpdir()` は別のファイルシステムでありうる。
 */
export const stagingPathFor = (outfile: string): string =>
  join(dirname(dirname(outfile)), '.build-staging', `${basename(outfile)}.${process.pid}.tmp`);

/**
 * ESM 出力に足す `require` の定義。
 *
 * 推移依存に CommonJS のものが残っており、ESM には `require` が無い。
 * これが無いと、そのコードに到達した時点で ReferenceError になる。
 */
export const API_BUNDLE_BANNER =
  "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);";

export interface BuildApiBundleOptions {
  /** 既定は `API_ENTRY`。テストが差し替える。 */
  entry?: string;
  /** 既定は `API_BUNDLE_FILE`。テストが差し替える。 */
  outfile?: string;
}

/**
 * エントリごとのビルド結果。
 *
 * **同じプロセスで何度も呼ばれる**（synth は SiteStack を組み立てるたびに通る）。
 * esbuild は 100ms 前後かかるので、1 プロセス 1 回に抑える。
 *
 * ソースが実行中に変わることは想定しない — CDK CLI の 1 回の起動は短命で、
 * その間にソースが書き換わるなら、どのみち同じ synth の出力は信用できない。
 */
const bundleCache = new Map<string, Uint8Array>();

/**
 * esbuild に渡す設定。**テストはこの関数の戻り値を検査する。**
 *
 * 設定を別に書き写して主張すると「書き写したものが正しい」ことしか言えない。
 * 実際に `buildSync` へ渡すものをそのまま返す。
 */
export const apiBundleOptions = (entry: string, outfile: string): BuildOptions => ({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  // **Lambda のランタイムと合わせる**（nodejs24.x）。下げると使える構文が変わり、
  // 上げるとランタイムに無い構文が出力されうる。
  target: 'node24',
  // **.mjs を CommonJS として読ませない。** format と拡張子はセットで意味を持つ。
  format: 'esm',
  minify: true,
  banner: { js: API_BUNDLE_BANNER },
  // 生成と書き出しを分け、書き出しを不可分にする。
  write: false,
});

const compile = (entry: string, outfile: string): Uint8Array => {
  const cached = bundleCache.get(entry);
  if (cached !== undefined) return cached;

  const result = buildSync(apiBundleOptions(entry, outfile));

  // apiBundleOptions は write: false を返すので outputFiles が入る。ただし型は
  // 汎用の BuildOptions なので、esbuild 側の型はそれを狭められない。**握り潰さず、
  // 無ければ落とす** — 空のバンドルを固めるくらいなら synth を失敗させる。
  const output = result.outputFiles?.[0]?.contents;
  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }

  bundleCache.set(entry, output);

  return output;
};

/** 既にディスク上の内容が期待どおりなら true。 */
const alreadyWritten = (outfile: string, expected: Uint8Array): boolean => {
  try {
    return Buffer.from(expected).equals(readFileSync(outfile));
  } catch {
    // 無い・読めないなら書く。
    return false;
  }
};

/**
 * バンドルを作り、`outfile` の内容がそれと一致していることを保証して、そのパスを返す。
 *
 * **既にあるかどうかではなく、内容が一致しているかで判断する。** 「成果物が存在する」
 * だけを条件にすると、まさに事故の状況（古い成果物が居座っている）を通してしまう。
 */
export const buildApiBundle = (options: BuildApiBundleOptions = {}): string => {
  const entry = options.entry ?? API_ENTRY;
  const outfile = options.outfile ?? API_BUNDLE_FILE;

  const expected = compile(entry, outfile);
  if (alreadyWritten(outfile, expected)) return outfile;

  mkdirSync(dirname(outfile), { recursive: true });

  // **別のディレクトリに書いてから rename する。** vitest はテストファイルを並列の
  // ワーカーで走らせるので、複数のプロセスが同じ outfile に書きうる。直接書くと
  // 途中まで書かれたバンドルを別のプロセスが読む。rename は同一ファイルシステム上で
  // 不可分なので、読み手が見るのは常に「前の完全な内容」か「新しい完全な内容」になる。
  //
  // **書きかけを outfile のディレクトリに置いてはいけない。** そこは CDK が
  // Code.fromAsset で丸ごと指紋を取る対象で、列挙に写ったファイルが stat の前に
  // rename で消えると ENOENT になる。理由は stagingPathFor を参照。
  const staging = stagingPathFor(outfile);
  mkdirSync(dirname(staging), { recursive: true });
  try {
    writeFileSync(staging, expected);
    renameSync(staging, outfile);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }

  return outfile;
};

// `node build.ts` で実行されたときだけ走らせる。import されただけでは何もしない
// （infra は明示的に buildApiBundle を呼ぶ）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildApiBundle();
}
