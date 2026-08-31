import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RULE_COUNT,
  findRawFetchUsages,
  scanDirectory,
  typeScriptFiles,
} from '../support/scan.ts';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));

/**
 * **素の fetch は 2 本だけ。**
 *
 *   src/api/client.ts … `/api/*`。x-amz-content-sha256 を必ず付ける。
 *   src/api/upload.ts … S3 への presigned PUT。**逆に付けない。**
 *
 * 規則が正反対の 2 本なので、3 本目が生えると必ずどちらかを取り違える。
 */
const ALLOWED = ['api/client.ts', 'api/upload.ts'];

describe('**走査関数そのものが検出できる**', () => {
  // 先にこれを確かめないと、あとの「違反が無い」は
  // 「検出できないから無いように見える」と区別がつかない。
  const violating = readFileSync(`${FIXTURE_DIR}violating.ts`, 'utf8');
  const clean = readFileSync(`${FIXTURE_DIR}clean.ts`, 'utf8');

  it('検出規則の表が空でない', () => {
    expect(RULE_COUNT).toBeGreaterThan(0);
  });

  it('フィクスチャが 2 本とも実在する', () => {
    expect(existsSync(`${FIXTURE_DIR}violating.ts`)).toBe(true);
    expect(existsSync(`${FIXTURE_DIR}clean.ts`)).toBe(true);
  });

  it('違反フィクスチャから 1 件以上検出する', () => {
    expect(findRawFetchUsages(violating, 'violating.ts').length).toBeGreaterThan(0);
  });

  it.each([
    'bare-fetch',
    'globalThis.fetch',
    'window.fetch',
    'new Request',
    'XMLHttpRequest',
    'sendBeacon',
  ])('%s を検出する', (kind) => {
    // **規則ごとに 1 件ずつ確かめる。** 合計件数だけ見ると、1 つの規則が
    // 壊れても他が拾って緑のままになる。
    expect(findRawFetchUsages(violating, 'violating.ts').map((usage) => usage.kind)).toContain(kind);
  });

  it('清潔なフィクスチャからは 0 件（誤検出しない）', () => {
    // caller.fetchImpl(...) のようなドット付き呼び出しや、
    // 語としての fetch に反応しないこと。
    expect(findRawFetchUsages(clean, 'clean.ts')).toEqual([]);
  });

  it('検出結果に行番号が入る（場所が分かる）', () => {
    const usages = findRawFetchUsages(violating, 'violating.ts');
    expect(usages.every((usage) => usage.line > 0)).toBe(true);
  });
});

describe('走査対象', () => {
  const files = typeScriptFiles(SRC_DIR);

  it('ファイル一覧が空でない', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(ALLOWED)('許可リストの %s が実在する', (relative) => {
    // リネームで許可リストが空振りしていないこと。空振りすると
    // 「許可されたファイルが無いので違反も無い」で緑になる。
    expect(files).toContain(relative);
  });
});

describe('**src/ の素の fetch は許可リストの 2 本だけ**', () => {
  const usages = scanDirectory(SRC_DIR);

  it('許可リスト以外のどのファイルも検出に引っかからない', () => {
    const offenders = usages.filter((usage) => !ALLOWED.includes(usage.file));
    expect(
      offenders.map((usage) => `${usage.file}:${usage.line} (${usage.kind})`),
    ).toEqual([]);
  });

  it('許可リストの 2 本は実際に検出される（走査が src まで届いている）', () => {
    // 届いていないなら上のテストは無意味に緑になる。
    const detected = new Set(usages.map((usage) => usage.file));
    for (const allowed of ALLOWED) {
      expect(detected, `${allowed} が走査に掛かっていない`).toContain(allowed);
    }
  });
});
