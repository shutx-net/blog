import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ワークフロー全ファイルに対する GitHub 式構文のガード。
 *
 * **なぜ必要か。** かつて存在した `oidc-probe.yml`（役目を終えて削除済み）は `run: |` ブロックの中に
 * `# ${{ }} を使わないので…` というコメントを持っていて、GitHub に
 * `HTTP 422 An expression was expected` で拒否された。ワークフローが
 * **一度も起動できない**状態だったが、テスト 715 件は全部グリーンだった。
 *
 * 理由は、`yaml` にとって `${{ }}` はただの文字列で YAML としては完全に妥当だから。
 * **YAML として妥当なことと GitHub が受理することは別物である。**
 *
 * `run: |` ブロックの中では `#` は YAML コメントではなく素のシェル文字列であり、
 * GitHub はスカラー全体を式展開する。つまり run の中に書いたコメントの `${{ }}` も
 * 評価される。ステップレベルの本物の YAML コメントは YAML パーサが捨てるので届かない。
 * この差は目視ではまず気づけないので、機械的に禁じる。
 */

const workflowsDir = fileURLToPath(new URL('../../.github/workflows', import.meta.url));

const workflowFiles = (): string[] =>
  readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** 中身が空、または空白だけの `${{ }}`。GitHub はこれを式として評価しようとして落ちる。 */
const EMPTY_EXPRESSION = /\$\{\{\s*\}\}/;

/** step から `run` のスカラーだけを取り出す。 */
const runScalars = (doc: unknown): string[] => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'run' && typeof value === 'string') out.push(value);
        walk(value);
      }
    }
  };
  walk(doc);
  return out;
};

describe('ワークフローの GitHub 式構文', () => {
  it('ワークフローファイルが 1 つ以上ある（空振りしていないこと）', () => {
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it.each(workflowFiles())('%s: run ブロックの中に空の ${{ }} が無い', (file) => {
    const text = readFileSync(`${workflowsDir}/${file}`, 'utf8');
    const scalars = runScalars(parse(text));
    for (const scalar of scalars) {
      const bad = scalar
        .split('\n')
        .filter((line) => EMPTY_EXPRESSION.test(line))
        .map((line) => line.trim());
      expect(
        bad,
        `${file} の run ブロックに空の \${{ }} がある。GitHub は起動時に ` +
          `"An expression was expected" (HTTP 422) で拒否する。` +
          `run の中では # もシェル文字列であって YAML コメントではない:\n  ${bad.join('\n  ')}`,
      ).toEqual([]);
    }
  });

  it.each(workflowFiles())('%s: ファイル全体でも空の ${{ }} を書かない（run へ移動されると壊れるため）', (file) => {
    // ステップレベルの YAML コメントなら今は無害だが、後から run の中へ
    // 移されただけで起動不能になる。安いので一律に禁じる。
    const text = readFileSync(`${workflowsDir}/${file}`, 'utf8');
    const offending = text
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((entry) => EMPTY_EXPRESSION.test(entry.line));
    expect(offending, `${file}: ${JSON.stringify(offending)}`).toEqual([]);
  });
});
