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
 * **素の fetch は 3 本だけ。それぞれ規則が違う。**
 *
 *   src/api/client.ts        … 同一オリジンの `/api/*`。
 *                              **`x-amz-content-sha256` を必ず付ける。** JSON。
 *   src/api/upload.ts        … S3 への presigned PUT。**逆に絶対に付けない。**
 *                              署名済みヘッダをそのまま送る。
 *   src/auth/token-endpoint.ts … **別オリジン**の認可サーバ。**どちらのヘッダも付けない。**
 *                              `content-type: application/x-www-form-urlencoded` 1 個だけ、
 *                              `credentials: 'omit'`。
 *
 * **3 本とも規則が違うので、4 本目が生えれば必ずどれかを取り違える。**
 * Phase 4 のコメントは「規則が正反対の 2 本」と書いていた。Phase 5 で 3 本目が
 * 生えたので、3 つを並べて書いてある。**増やさないのではなく、増やしたぶん
 * 機械的に縛る**（下の「3 本目の規則」を参照）。
 */
const ALLOWED = ['api/client.ts', 'api/upload.ts', 'auth/token-endpoint.ts'];

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

describe('**src/ の素の fetch は許可リストの 3 本だけ**', () => {
  const usages = scanDirectory(SRC_DIR);

  it('許可リスト以外のどのファイルも検出に引っかからない', () => {
    const offenders = usages.filter((usage) => !ALLOWED.includes(usage.file));
    expect(
      offenders.map((usage) => `${usage.file}:${usage.line} (${usage.kind})`),
    ).toEqual([]);
  });

  it('許可リストの 3 本は実際に検出される（走査が src まで届いている）', () => {
    // 届いていないなら上のテストは無意味に緑になる。
    const detected = new Set(usages.map((usage) => usage.file));
    for (const allowed of ALLOWED) {
      expect(detected, `${allowed} が走査に掛かっていない`).toContain(allowed);
    }
  });

  it('許可リストがちょうど 3 本である（黙って増えていない）', () => {
    expect(ALLOWED).toHaveLength(3);
  });
});

/**
 * **3 本目の規則を機械的に固定する。**
 *
 * `token-endpoint.ts` は別オリジンの認可サーバを叩くので、api 用のヘッダを
 * 1 つも付けてはいけない。取り違えると「署名が壊れる」ではなく
 * 「認可サーバが 400 を返す」という別の壊れ方をするので、綴りごと禁じる。
 */
describe('**3 本目（auth/token-endpoint.ts）の規則**', () => {
  const TOKEN_ENDPOINT = 'auth/token-endpoint.ts';

  const RULES: ReadonlyArray<{ label: string; pattern: RegExp; violating: string }> = [
    {
      label: 'x-amz-content-sha256 を付けない（api 用のヘッダを認可サーバに送らない）',
      pattern: /x-amz-content-sha256/i,
      violating: "headers['x-amz-content-sha256'] = await sha256Hex(bytes);",
    },
    {
      label: 'AUTH_HEADER を送らない（api 用のトークンヘッダを認可サーバに送らない）',
      pattern: /AUTH_HEADER/,
      violating: "headers[AUTH_HEADER] = `${AUTH_SCHEME} ${token}`;",
    },
    {
      label: "credentials: 'include' を使わない（Cookie を送らない・受け取らない）",
      pattern: /credentials\s*:\s*['"]include['"]/,
      violating: "const init = { credentials: 'include' };",
    },
  ];

  it('規則の表が空でない', () => {
    expect(RULES.length).toBeGreaterThan(0);
  });

  it.each(RULES)('規則「$label」が違反サンプルを検出する', (rule) => {
    // 検出できない規則は、無いのと同じどころか誤った確信を与える分だけ悪い。
    expect(rule.pattern.test(rule.violating)).toBe(true);
  });

  it('token-endpoint.ts が実在する（規則が空振りしていない）', () => {
    expect(typeScriptFiles(SRC_DIR)).toContain(TOKEN_ENDPOINT);
  });

  it.each(RULES)('$label', (rule) => {
    expect(rule.pattern.test(readFileSync(SRC_DIR + TOKEN_ENDPOINT, 'utf8'))).toBe(false);
  });

  it("credentials: 'omit' を実際に指定している（既定に頼らない）", () => {
    // 実測で認可サーバは応答に Set-Cookie: XSRF-TOKEN=... を返す。
    // 送る必要も受け取る必要も無いので、明示的に omit する。
    expect(readFileSync(SRC_DIR + TOKEN_ENDPOINT, 'utf8')).toMatch(
      /credentials\s*:\s*['"]omit['"]/,
    );
  });
});
