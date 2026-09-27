import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **oxlint が実際に何を走査しているかを固定する。**
 *
 * `.oxlintrc.json` の ignore を間違えても、**oxlint は緑のまま走査対象だけを縮める**。
 * 実測（1.85.0）:
 *
 *   ignore なし                       173 ファイル
 *   ignorePatterns に admin/** infra/**  73 ファイル  ← exit 0 のまま
 *
 * ルール名の typo は `Rule 'xxx' not found in plugin` で exit 1 になり、
 * 走査対象が 1 件も無ければ exit 1 になる（どちらも実測）。**無言で通る経路は
 * 「一部だけ ignore」だけ**なので、そこにだけ床を置く。
 *
 * この repo は「テストは緑なのに実物が壊れている」を 7 回踏んでいる。
 * リンタを入れた初日に同じ形を作らないための主張。
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** `npx` を挟まない。起動が速く、解決先が曖昧にならない。 */
const OXLINT = 'node_modules/.bin/oxlint';

interface OxlintSummary {
  number_of_files: number;
  number_of_rules: number;
}

/**
 * oxlint を走らせて要約を返す。**走査対象が 0 件なら `undefined`。**
 *
 * 違反があると exit 1 になるが stdout には JSON が出る。走査対象が 0 件のときも
 * exit 1 だが、そのときは JSON が出ない。**この 2 つを区別することが目的**なので、
 * 終了コードではなく「JSON が読めたか」で判定する。
 */
const summarize = (...args: readonly string[]): OxlintSummary | undefined => {
  let stdout = '';
  try {
    stdout = execFileSync(OXLINT, ['--format=json', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
  }

  try {
    return JSON.parse(stdout) as OxlintSummary;
  } catch {
    return undefined;
  }
};

/**
 * 走査ファイル数の下限。
 *
 * **現在 174。下限 150 は「どのワークスペースを 1 つ落としても割る」値**として選んだ。
 * 実測の残存数:
 *
 *   api を除外    125
 *   admin を除外  105
 *   infra を除外  143
 *   site を除外   149  ← 最小の脱落。これを捕まえられる値でなければ意味が無い
 *
 * 余裕は 24 ファイル。**「0 より大きい」では 73 ファイルを素通しする**ので、
 * 具体値でなければならない。正当にファイルが減って割ったときは、
 * 上の数字を測り直して下限を下げること。
 */
const MINIMUM_FILES = 150;

/** 実測 96。`categories.correctness` を明示しているので、既定が動いても揺れない。 */
const MINIMUM_RULES = 96;

/**
 * **ルールを効かせたい場所が実際に走査されているか。**
 *
 * `.oxlintrc.json` の overrides は `files` グロブで場所を絞る。対象が走査から
 * 外れていれば、グロブが正しくてもルールは静かに無効になる。
 */
const SCANNED_DIRECTORIES = [
  'api/src',
  'api/test',
  'admin/src',
  'admin/test',
  'infra/lib',
  'infra/test',
  'infra/functions',
  'site/src',
  'site/test',
] as const;

describe('oxlint の走査範囲', () => {
  it(`走査ファイル数が ${MINIMUM_FILES} 以上である`, () => {
    const summary = summarize();

    expect(summary, 'oxlint が JSON を返さなかった（走査対象が 0 件）').toBeDefined();
    expect(
      summary?.number_of_files,
      'ignore パターンで走査対象が縮んでいないか。oxlint は縮んでも緑のまま通る',
    ).toBeGreaterThanOrEqual(MINIMUM_FILES);
  });

  it(`有効なルール数が ${MINIMUM_RULES} 以上である`, () => {
    const summary = summarize();

    expect(summary?.number_of_rules).toBeGreaterThanOrEqual(MINIMUM_RULES);
  });

  it.each(SCANNED_DIRECTORIES)('%s が走査に含まれている', (directory) => {
    const summary = summarize(directory);

    expect(summary, `${directory} が走査から外れている（ignore パターンを確認）`).toBeDefined();
    expect(summary?.number_of_files).toBeGreaterThan(0);
  });
});

/**
 * **規約ルールが設定に残っていることの主張。テキスト一致であることを承知で置く。**
 *
 * 上の床は「走査対象が縮む」を捕まえるが、**overrides の `files` グロブを 1 文字
 * 変えても、ルールを丸ごと消しても落ちない**（実測で確認済み）。どちらもルールを
 * 静かに無効にする。
 *
 * **本来は違反を実際に書いて落ちることを見たい**が、走査対象のディレクトリに
 * 一時ファイルを作ると、同時に走る別のスイートの oxlint や `npm run lint` が
 * それを拾う。**この repo はプロセス横断の共有状態で 3 回事故を起こしている**
 * （`api/dist` を壊す、書きかけを `Code.fromAsset` の対象に置く、`os.tmpdir()`）。
 * 同じ形を作るくらいなら、弱い主張で止めるほうがよい。
 *
 * **振る舞いの証明は導入時に 1 度だけ手で行った**（各 override の対象で違反が
 * 実際に報告され、対象外では報告されないことを 12 通り確認）。ここが守るのは
 * 「そのとき確かめた設定が黙って書き換わらないこと」だけで、**グロブが本当に
 * 意図した場所に当たるかまでは見ていない。**
 */
const EXPECTED_OVERRIDES: ReadonlyArray<{ label: string; glob: string; rule: string }> = [
  { label: 'テストは OS の一時ディレクトリに書かない', glob: '**/test/**/*.ts', rule: 'no-restricted-imports' },
  { label: 'ブラウザにも載るコードは node 組み込みに触らない', glob: 'api/src/posts/**/*.ts', rule: 'no-restricted-imports' },
  { label: 'admin は XMLHttpRequest を使わない', glob: 'admin/src/**/*.ts', rule: 'no-restricted-globals' },
];

describe('oxlint の規約ルール', () => {
  const config = (): string =>
    execFileSync('cat', ['.oxlintrc.json'], { cwd: REPO_ROOT, encoding: 'utf8' });

  it('主張の表が空でない', () => {
    expect(EXPECTED_OVERRIDES.length).toBeGreaterThan(0);
  });

  it.each(EXPECTED_OVERRIDES)('「$label」の override が残っている', ({ glob, rule }) => {
    const source = config();

    expect(source, `${glob} の override が消えている`).toContain(JSON.stringify(glob));
    expect(source, `${rule} が設定から消えている`).toContain(JSON.stringify(rule));
  });
});
