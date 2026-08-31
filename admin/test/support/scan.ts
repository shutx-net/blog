import { readFileSync, readdirSync } from 'node:fs';

/**
 * 素のネットワーク呼び出しの走査。
 *
 * **走査関数そのものをフィクスチャで検証している**（test/fixtures/scan/）ので、
 * 素朴な正規表現でも「何も検出できない走査が緑を出す」ことはない。
 * 検出できない走査は、走査が無いのと同じどころか、**守られているという
 * 誤った確信を与える分だけ悪い。**
 */
export interface RawFetchUsage {
  /** 走査ルートからの相対パス。 */
  file: string;
  /** 1 始まり。 */
  line: number;
  /** どの規則に当たったか。 */
  kind: string;
}

/**
 * 検出規則。
 *
 * `fetch` は **ドットに続かないもの**だけを見る（`caller.fetchImpl(...)` のような
 * 注入された関数呼び出しは違反ではない）。`globalThis.fetch` と `window.fetch` は
 * ドット付きなので別の規則で拾う。
 */
const RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'bare-fetch', pattern: /(^|[^.\w$])fetch\s*\(/ },
  { kind: 'globalThis.fetch', pattern: /globalThis\s*\.\s*fetch\b/ },
  { kind: 'window.fetch', pattern: /window\s*\.\s*fetch\b/ },
  { kind: 'new Request', pattern: /new\s+Request\s*\(/ },
  { kind: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { kind: 'sendBeacon', pattern: /\bsendBeacon\s*\(/ },
];

/** 走査に使っている規則の数。テストが「表が空でない」ことを主張するため。 */
export const RULE_COUNT = RULES.length;

/** 1 ファイル分の走査。行ごとに見るので、失敗時に場所が分かる。 */
export const findRawFetchUsages = (source: string, file: string): RawFetchUsage[] => {
  const found: RawFetchUsage[] = [];
  source.split('\n').forEach((text, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(text)) {
        found.push({ file, line: index + 1, kind: rule.kind });
      }
    }
  });
  return found;
};

/** ディレクトリ以下の *.ts を再帰的に集める。 */
export const typeScriptFiles = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? typeScriptFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
      : entry.name.endsWith('.ts')
        ? [`${prefix}${entry.name}`]
        : [],
  );

/** ディレクトリ以下を走査する。 */
export const scanDirectory = (dir: string): RawFetchUsage[] =>
  typeScriptFiles(dir).flatMap((file) => findRawFetchUsages(readFileSync(dir + file, 'utf8'), file));
