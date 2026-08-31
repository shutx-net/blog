import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { API_OPERATIONS, createApiClient } from '../../src/api/client.ts';
import { utf8Bytes } from '../../src/api/sha256.ts';
import { base64UrlEncode } from '../../src/auth/base64url.ts';
import { AUTH_CONFIG } from '../../src/auth/config.ts';
import { saveSession } from '../../src/auth/session-state.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore } from '../../src/storage/session-store.ts';
import type { ApiOperation } from '../../src/api/client.ts';
import { createCognitoAuthTransport, createStubAuthTransport } from '../../src/auth/session.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

interface Captured {
  url: string;
  init: RequestInit;
}

const spyFetch = (): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
};

const headersOf = (captured: Captured | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((captured?.init.headers ?? {}) as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
};

const bodyFor = (operation: ApiOperation): Record<string, unknown> | undefined =>
  operation.method === 'POST' ? { slug: 'x' } : undefined;

const callWith = async (
  operation: ApiOperation,
  auth: AuthTransport,
): Promise<{ calls: Captured[] }> => {
  const fetchSpy = spyFetch();
  await createApiClient({ origin: '', auth, fetchImpl: fetchSpy.impl }).call(
    operation,
    bodyFor(operation),
  );
  return { calls: fetchSpy.calls };
};

/**
 * **認証の継ぎ目が 1 ファイルに閉じていることの機械的な確認。**
 *
 * 輸送方式（カスタムヘッダか Cookie か）は別エージェントが決める。ここが
 * 固定しているのは「どちらに決まっても署名が壊れない」ことだけで、
 * 他のすべてのテストは偽の transport を注入して動く。
 */
describe('スタブの transport', () => {
  it('isAuthenticated() が false、authHeaders() が {}、credentials が same-origin', async () => {
    const auth = createStubAuthTransport();
    expect(auth.isAuthenticated()).toBe(false);
    expect(await auth.authHeaders()).toEqual({});
    expect(auth.credentials).toBe('same-origin');
  });
});

describe('transport が返したヘッダが全経路に乗る', () => {
  it.each(API_OPERATIONS)('$method $path に乗る', async (operation) => {
    const auth: AuthTransport = {
      authHeaders: async () => ({ 'x-blog-authorization': 'Bearer test-token' }),
      credentials: 'same-origin',
      isAuthenticated: () => true,
    };
    const { calls } = await callWith(operation, auth);
    expect(headersOf(calls[0])['x-blog-authorization']).toBe('Bearer test-token');
  });
});

describe('**authorization を絶対に設定しない**', () => {
  it.each(API_OPERATIONS)('$method $path に authorization が無い', async (operation) => {
    // CloudFront は OAC の SigV4（SigningBehavior: always）で閲覧者の
    // Authorization を上書きするので、ここに書いても届かない。
    const { calls } = await callWith(operation, createStubAuthTransport());
    const names = Object.keys(headersOf(calls[0]));
    expect(names).not.toContain('authorization');
  });

  it('transport が authorization を返したら**例外を投げる**', async () => {
    // 黙って無視すると「認証が通らない理由が分からない」状態になる。
    // 上書きされて静かに失敗するより、その場で落ちるほうが直せる。
    const auth: AuthTransport = {
      authHeaders: async () => ({ Authorization: 'Bearer nope' }),
      credentials: 'same-origin',
      isAuthenticated: () => true,
    };
    await expect(callWith({ method: 'GET', path: '/api/health' }, auth)).rejects.toThrow(
      /authorization/i,
    );
  });
});

describe('**transport が x-amz-content-sha256 を上書きできない**', () => {
  it.each(API_OPERATIONS)('$method $path で body のハッシュが勝つ', async (operation) => {
    const auth: AuthTransport = {
      authHeaders: async () => ({ 'x-amz-content-sha256': 'deadbeef' }),
      credentials: 'same-origin',
      isAuthenticated: () => true,
    };
    const { calls } = await callWith(operation, auth);
    const sent = headersOf(calls[0])['x-amz-content-sha256'];
    expect(sent).not.toBe('deadbeef');
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * **本物の transport を実物の client に刺した往復。**
 *
 * 上の describe 群は偽 transport で「どんな値が来ても署名が壊れない」ことを見ている。
 * ここは逆に「本物が返す値が実際に全経路へ正しく乗る」ことを 1 件だけ確かめる。
 * 片方だけだと「実装したが繋がっていない」で緑になる。
 */
describe('**本物の transport を createApiClient に刺した往復**', () => {
  const NOW_MS = 1_800_000_000_000;

  const signedInStore = (): { store: SessionStore; idToken: string } => {
    const entries = new Map<string, string>();
    const store = createSessionStore({
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    });
    const idToken = [
      'eyJhbGciOiJSUzI1NiJ9',
      base64UrlEncode(
        utf8Bytes(
          JSON.stringify({
            exp: NOW_MS / 1000 + 3600,
            aud: AUTH_CONFIG.clientId,
            iss: AUTH_CONFIG.issuer,
            token_use: 'id',
            'cognito:username': 'shutx',
          }),
        ),
      ),
      'sig',
    ].join('.');
    saveSession(
      store,
      { ok: true, idToken, refreshToken: 'R' },
      { clientId: AUTH_CONFIG.clientId, issuer: AUTH_CONFIG.issuer },
    );
    return { store, idToken };
  };

  it.each(API_OPERATIONS)('$method $path に本物のトークンが乗る', async (operation) => {
    const { store, idToken } = signedInStore();
    const auth = createCognitoAuthTransport({
      store,
      now: () => NOW_MS,
      fetchImpl: async () => {
        throw new Error('リフレッシュは起きないはず');
      },
    });

    const { calls } = await callWith(operation, auth);
    const headers = headersOf(calls[0]);
    expect(headers['x-blog-authorization']).toBe(`Bearer ${idToken}`);
    expect(Object.keys(headers)).not.toContain('authorization');
    // 本物でも body のハッシュは client.ts のものが勝つ。
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('未認証の本物 transport では認証ヘッダが乗らない（api が 401 を返すのが正しい）', async () => {
    const entries = new Map<string, string>();
    const auth = createCognitoAuthTransport({
      store: createSessionStore({
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
          entries.set(key, value);
        },
        removeItem: (key) => {
          entries.delete(key);
        },
      }),
      now: () => NOW_MS,
    });

    const { calls } = await callWith({ method: 'GET', path: '/api/health' }, auth);
    expect(Object.keys(headersOf(calls[0]))).not.toContain('x-blog-authorization');
  });
});

describe('credentials が transport の値どおりに渡る', () => {
  it.each(['same-origin', 'include', 'omit'] as const)('%s がそのまま fetch に渡る', async (mode) => {
    // Cookie 方式に差し替えたときに 'include' が効くことの担保。
    const auth: AuthTransport = {
      authHeaders: async () => ({}),
      credentials: mode,
      isAuthenticated: () => true,
    };
    const { calls } = await callWith({ method: 'GET', path: '/api/health' }, auth);
    expect(calls[0]?.init.credentials).toBe(mode);
  });
});

/**
 * **走査規則。Phase 5 で 1 本の許可リストから 4 本の規則に張り替えた。**
 *
 * Phase 4 までは「`Cognito` / `document.cookie` / `localStorage` / `sessionStorage` の
 * どれも `src/auth/session.ts` にしか現れない」という 1 本だった。実装が 1 ファイルに
 * 収まらなくなったときに、**その形を守るために実装を 1 ファイルへ押し込むのは本末転倒**
 * なので、規則を分解した。**合計としては今より厳しい。**
 *
 *   | 綴り | Phase 4 の許可先 | Phase 5 の許可先 |
 *   | --- | --- | --- |
 *   | localStorage / sessionStorage | auth/session.ts（何にでも使えた） | **storage/session-store.ts の 1 本だけ** |
 *   | document.cookie | auth/session.ts | **どこにも無い（0 件）** |
 *   | Cognito | auth/session.ts | auth/ 配下（+ main.ts の import 行） |
 *   | authorization | api/client.ts, auth/session.ts | 同じ（`authorization_code` は別物として除外） |
 *
 * **各規則について「違反サンプルを実際に検出できること」を先に主張する。**
 * 検出できない走査は、走査が無いのと同じどころか、守られているという誤った確信を
 * 与える分だけ悪い（test/unit/no-raw-fetch.test.ts と同じ規律）。
 */
interface SeamRule {
  name: string;
  pattern: RegExp;
  /** その行にこの綴りがあってよいか。**行単位**なので import 行だけ許すこともできる。 */
  allows(relative: string, line: string): boolean;
  /** **空振り検出。** これらのファイルで実際に検出されなければ規則は無意味。 */
  mustDetect: string[];
  /** 規則が検出できることの確認用。 */
  violating: string;
  /** 誤検出しないことの確認用。 */
  clean: string;
}

const SEAM_RULES: SeamRule[] = [
  {
    name: 'Web Storage',
    // **Web Storage を名指しできるのは 1 ファイルだけ。** トークンも下書きも
    // ここを経由するので、保存先を変えるときに読む場所が 1 つに決まる。
    pattern: /\b(?:localStorage|sessionStorage)\b/,
    allows: (relative) => relative === 'storage/session-store.ts',
    mustDetect: ['storage/session-store.ts'],
    violating: "const raw = window.sessionStorage.getItem('token');",
    clean: "const raw = store.get('token');",
  },
  {
    name: 'document.cookie',
    // **Phase 5 で 1 -> 0 に締めた。** Cookie 方式は採らないと決めた
    // （api/src/auth/transport.ts が理由を書いている）ので、綴りごと禁じる。
    pattern: /document\s*\.\s*cookie/,
    allows: () => false,
    mustDetect: [],
    violating: "document.cookie = 'session=1; path=/';",
    clean: 'const store = createSessionStore();',
  },
  {
    name: 'Cognito',
    // 認可サーバ固有の知識（ドメイン・パラメータ・エンドポイント）を auth/ に閉じる。
    // **main.ts は import 行でだけ名前を書ける** — 継ぎ目に本物を差し込むのが
    // main.ts の唯一の仕事であり、そこに知識は無い（値は auth/config.ts が持つ）。
    pattern: /cognito/i,
    allows: (relative, line) =>
      relative.startsWith('auth/') || (relative === 'main.ts' && /^import\b/.test(line.trim())),
    mustDetect: ['auth/session.ts'],
    violating: "const domain = 'https://x.auth.ap-northeast-1.amazoncognito.com';",
    clean: "const domain = config.loginDomain;",
  },
  {
    name: 'authorization',
    // ヘッダ名を手で書かせない。**`AUTH_HEADER` の import 経由だけが正。**
    // `authorization_code` は OAuth の grant_type であってヘッダ名ではないので除外する
    // （除外しないと token-endpoint.ts が RFC どおりの grant_type を書けなくなる）。
    pattern: /authorization(?!_code)/i,
    allows: (relative) => relative === 'api/client.ts' || relative === 'auth/session.ts',
    mustDetect: ['api/client.ts', 'auth/session.ts'],
    violating: "headers['Authorization'] = 'Bearer ' + token;",
    clean: "body.set('grant_type', 'authorization_code');",
  },
];

describe('**走査規則そのものが機能する**', () => {
  it('規則の表が空でない', () => {
    expect(SEAM_RULES.length).toBeGreaterThan(0);
  });

  it.each(SEAM_RULES)('$name の規則が違反サンプルを検出する', (rule) => {
    expect(rule.pattern.test(rule.violating)).toBe(true);
  });

  it.each(SEAM_RULES)('$name の規則が清潔なサンプルを誤検出しない', (rule) => {
    expect(rule.pattern.test(rule.clean)).toBe(false);
  });

  it('authorization の規則は grant_type=authorization_code を見逃すが、ヘッダ名は捕まえる', () => {
    // 除外が広すぎないことの確認。**`authorization_code` だけを外している。**
    const rule = SEAM_RULES.find((candidate) => candidate.name === 'authorization');
    expect(rule).toBeDefined();
    expect(rule?.pattern.test("grant_type=authorization_code")).toBe(false);
    expect(rule?.pattern.test("'x-blog-authorization'")).toBe(true);
    expect(rule?.pattern.test('Authorization: Bearer')).toBe(true);
  });

  it('Cognito の規則は main.ts の import 行だけを許し、それ以外の行は許さない', () => {
    const rule = SEAM_RULES.find((candidate) => candidate.name === 'Cognito');
    expect(rule).toBeDefined();
    expect(rule?.allows('main.ts', "import { createCognitoAuthTransport } from './auth/session.ts';")).toBe(true);
    expect(rule?.allows('main.ts', "const domain = 'https://x.amazoncognito.com';")).toBe(false);
    expect(rule?.allows('editor/app.ts', "import { x } from './cognito.ts';")).toBe(false);
  });
});

describe('**認証の知識が src/auth/ の外に漏れていない**', () => {
  const sourceFiles = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
        : entry.name.endsWith('.ts')
          ? [`${prefix}${entry.name}`]
          : [],
    );

  const files = sourceFiles(SRC_DIR);

  /** 規則に違反している `相対パス:行番号` の一覧。 */
  const offenders = (rule: SeamRule): string[] =>
    files.flatMap((relative) =>
      readFileSync(SRC_DIR + relative, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          rule.pattern.test(line) && !rule.allows(relative, line)
            ? [`${relative}:${index + 1}`]
            : [],
        ),
    );

  /** その規則に実際に引っかかったファイルの集合。 */
  const detectedIn = (rule: SeamRule): string[] =>
    files.filter((relative) => rule.pattern.test(readFileSync(SRC_DIR + relative, 'utf8')));

  it('走査対象が空でない', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(SEAM_RULES.flatMap((rule) => rule.mustDetect.map((file) => ({ rule, file }))))(
    '許可リストの $file が実在する（$rule.name）',
    ({ file }) => {
      // リネームで許可リストが空振りしていないこと。空振りすると
      // 「許可されたファイルが無いので違反も無い」で緑になる。
      expect(files).toContain(file);
    },
  );

  it.each(SEAM_RULES.flatMap((rule) => rule.mustDetect.map((file) => ({ rule, file }))))(
    '$file が $rule.name の走査に実際に掛かる（空振りしていない）',
    ({ rule, file }) => {
      expect(detectedIn(rule)).toContain(file);
    },
  );

  it.each(SEAM_RULES)('$name が許可された場所以外に現れない', (rule) => {
    expect(offenders(rule)).toEqual([]);
  });

  it('**document.cookie はどのファイルにも現れない**（許可先が 0 件）', () => {
    // 上の it.each とは別に、0 件であること自体を名指しで固定する。
    const rule = SEAM_RULES.find((candidate) => candidate.name === 'document.cookie');
    expect(rule).toBeDefined();
    expect(detectedIn(rule as SeamRule)).toEqual([]);
  });

  it('**Web Storage を名指しするファイルがちょうど 1 本**', () => {
    const rule = SEAM_RULES.find((candidate) => candidate.name === 'Web Storage');
    expect(detectedIn(rule as SeamRule)).toEqual(['storage/session-store.ts']);
  });

  it.each(['editor/', 'api/', 'preview/', 'storage/'])(
    'src/%s の下に Cognito の綴りが 1 つも無い',
    (directory) => {
      const rule = SEAM_RULES.find((candidate) => candidate.name === 'Cognito');
      expect(detectedIn(rule as SeamRule).filter((file) => file.startsWith(directory))).toEqual([]);
    },
  );
});
