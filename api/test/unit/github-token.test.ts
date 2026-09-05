import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_API_VERSION, createTokenProvider } from '../../src/github/token.ts';

let privateKeyPem = '';

beforeAll(() => {
  privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString();
});

const TOKEN = 'ghs_1_eyJhbGciOiJIUzI1NiJ9.THIS_IS_LONGER_THAN_FORTY_CHARACTERS_XXXX';
const NOW_MS = Date.UTC(2026, 7, 30, 0, 0, 0);
const EXPIRES_AT = new Date(NOW_MS + 3600_000).toISOString();

interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const okJson = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** fetch のスパイ。**モックするのはこれだけ** — JWT 署名も時刻計算も本物を動かす。 */
const installFetch = (responder: (call: FetchCall) => Response) => {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const call: FetchCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return responder(call);
  });
  vi.stubGlobal('fetch', spy);
  return { calls, spy };
};

/** 既定の応答。installation 解決 -> トークン交換 の 2 本に答える。 */
const defaultResponder = (call: FetchCall): Response => {
  if (call.url.endsWith('/repos/shutx-net/blog/installation')) return okJson({ id: 12345678 });
  if (call.url.endsWith('/app/installations/12345678/access_tokens')) {
    return okJson({ token: TOKEN, expires_at: EXPIRES_AT }, 201);
  }
  return okJson({ message: 'unexpected' }, 500);
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const provider = (log = logger(), now: () => number = () => NOW_MS) =>
  createTokenProvider({
    secretReader: { readPrivateKey: vi.fn(async () => privateKeyPem) },
    clientId: 'Iv23liABC',
    owner: 'shutx-net',
    installationRepo: 'blog',
    repositories: ['blog'],
    permissions: { contents: 'write' },
    logger: log,
    now,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installation id の解決とトークン交換', () => {
  beforeEach(() => {
    installFetch(defaultResponder);
  });

  it('GET /repos/{owner}/{repo}/installation を App JWT で呼ぶ', async () => {
    // docs: "You must use a JWT to access this endpoint."
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    const first = calls[0] as FetchCall;
    expect(first.method).toBe('GET');
    expect(first.url).toBe('https://api.github.com/repos/shutx-net/blog/installation');
    expect(first.headers['authorization']).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('続いて POST /app/installations/{id}/access_tokens を同じ App JWT で呼ぶ', async () => {
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    expect(calls).toHaveLength(2);
    const second = calls[1] as FetchCall;
    expect(second.method).toBe('POST');
    expect(second.url).toBe('https://api.github.com/app/installations/12345678/access_tokens');
    expect(second.headers['authorization']).toBe((calls[0] as FetchCall).headers['authorization']);
  });

  it('呼び出し列が [GET installation, POST access_tokens] ちょうど 2 本である', async () => {
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/repos/shutx-net/blog/installation'],
      ['POST', '/app/installations/12345678/access_tokens'],
    ]);
  });

  it('両方のリクエストに Accept と X-GitHub-Api-Version が付く', async () => {
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers['accept']).toBe('application/vnd.github+json');
      expect(call.headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
    }
  });

  it('X-GitHub-Api-Version が 2026-03-10 に固定されている', () => {
    // GET https://api.github.com/versions は ["2026-03-10","2022-11-28"] を返す。
    // 既定任せにすると将来の破壊的変更を無防備に受ける。
    expect(GITHUB_API_VERSION).toBe('2026-03-10');
  });

  it('access_tokens のボディで権限をスコープダウンしている', async () => {
    // docs: "If permissions is not specified, the installation access token will
    // have all of the permissions that were granted to the app."
    // 本 API は site/src/content/posts/ しか書かないので contents: write だけでよい
    // （.github/workflows/ を書くときだけ workflows: write が要る）。
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    expect((calls[1] as FetchCall).body).toEqual({
      repositories: ['blog'],
      permissions: { contents: 'write' },
    });
  });

  it('**repositories と permissions は deps の値をそのまま送る**', async () => {
    // 記事用（blog-content に contents:write）とデプロイ起動用（blog に actions:write）で
    // 権限が違う。固定値に戻すと、片方のトークンがもう片方の権限まで持つ。
    const { calls } = installFetch((call) => {
      if (call.url.endsWith('/repos/shutx-net/blog-content/installation')) return okJson({ id: 12345678 });
      if (call.url.endsWith('/app/installations/12345678/access_tokens')) {
        return okJson({ token: TOKEN, expires_at: EXPIRES_AT }, 201);
      }
      return okJson({ message: 'unexpected' }, 500);
    });
    const contentProvider = createTokenProvider({
      secretReader: { readPrivateKey: vi.fn(async () => privateKeyPem) },
      clientId: 'Iv23liABC',
      owner: 'shutx-net',
      installationRepo: 'blog-content',
      repositories: ['blog-content'],
      permissions: { contents: 'write' },
      logger: logger(),
      now: () => NOW_MS,
    });
    await contentProvider.getToken();
    expect((calls[1] as FetchCall).body).toEqual({
      repositories: ['blog-content'],
      permissions: { contents: 'write' },
    });
  });

  it('**actions:write の provider は contents を要求しない**', async () => {
    const { calls } = installFetch(defaultResponder);
    const codeProvider = createTokenProvider({
      secretReader: { readPrivateKey: vi.fn(async () => privateKeyPem) },
      clientId: 'Iv23liABC',
      owner: 'shutx-net',
      installationRepo: 'blog',
      repositories: ['blog'],
      permissions: { actions: 'write' },
      logger: logger(),
      now: () => NOW_MS,
    });
    await codeProvider.getToken();
    expect((calls[1] as FetchCall).body).toEqual({
      repositories: ['blog'],
      permissions: { actions: 'write' },
    });
  });

  it('**installation の解決先と、トークンを効かせる範囲は別々に指定できる**', async () => {
    // App は 1 つの installation に複数リポジトリを持つので、どのリポジトリから
    // installation を引くかと、発行するトークンをどこに効かせるかは独立している。
    // ここを同一視すると「範囲を狭めたつもりが解決先まで変わる」事故になる。
    const { calls } = installFetch(defaultResponder);
    await createTokenProvider({
      secretReader: { readPrivateKey: vi.fn(async () => privateKeyPem) },
      clientId: 'Iv23liABC',
      owner: 'shutx-net',
      installationRepo: 'blog',
      repositories: ['blog-content'],
      permissions: { contents: 'write' },
      logger: logger(),
      now: () => NOW_MS,
    }).getToken();

    expect((calls[0] as FetchCall).url).toContain('/repos/shutx-net/blog/installation');
    expect((calls[1] as FetchCall).body).toEqual({
      repositories: ['blog-content'],
      permissions: { contents: 'write' },
    });
  });

  it('**2 つの provider がトークンキャッシュを共有しない**', async () => {
    // キャッシュがモジュールスコープに漏れると、先に呼ばれたほうのトークンが
    // もう片方に返る = 権限の違うトークンが混ざる。
    const { calls } = installFetch(defaultResponder);
    const a = provider();
    const b = provider();
    await a.getToken();
    const afterFirst = calls.length;
    await b.getToken();
    // b は自分で交換をやり直す（キャッシュを引き継がない）。
    expect(calls.length).toBeGreaterThan(afterFirst);
    expect(calls.some((call) => call.url.endsWith('/access_tokens'))).toBe(true);
  });

  it('installation 解決のリクエストにボディを付けない', async () => {
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    expect((calls[0] as FetchCall).body).toBeUndefined();
  });

  it('取得したトークンをそのまま返す', async () => {
    installFetch(defaultResponder);
    expect(await provider().getToken()).toBe(TOKEN);
  });

  it('トークンの長さや形式を検査しない', async () => {
    // GitHub は 2026-04-27 からステートレス形式（ghs_APPID_JWT）へ段階移行しており、
    // 「40 文字」を前提にした実装は壊れる。**不透明な文字列として扱う。**
    const long = `ghs_${'x'.repeat(300)}`;
    const short = 'gh';
    for (const token of [long, short, TOKEN]) {
      installFetch((call) =>
        call.url.endsWith('/installation')
          ? okJson({ id: 12345678 })
          : okJson({ token, expires_at: EXPIRES_AT }, 201),
      );
      expect(await provider().getToken()).toBe(token);
    }
  });
});

describe('実行環境キャッシュ', () => {
  it('2 回目の呼び出しでは fetch を追加で呼ばない', async () => {
    const { calls } = installFetch(defaultResponder);
    const p = provider();
    await p.getToken();
    expect(calls).toHaveLength(2);
    await p.getToken();
    await p.getToken();
    expect(calls, 'キャッシュが効いていれば増えない').toHaveLength(2);
  });

  it('expires_at の 60 秒前を過ぎたら取り直す', async () => {
    // TTL ぴったりだと飛行中のリクエストが 401 になる。早め更新のマージンを取る。
    let now = NOW_MS;
    const { calls } = installFetch(defaultResponder);
    const p = provider(logger(), () => now);
    await p.getToken();
    expect(calls).toHaveLength(2);

    // 期限の 61 秒前: まだ使う。
    now = NOW_MS + 3600_000 - 61_000;
    await p.getToken();
    expect(calls).toHaveLength(2);

    // 期限の 59 秒前: 取り直す。installation id はキャッシュに残るので
    // 呼び直すのは access_tokens だけ（下の「再解決しない」ケースと対）。
    now = NOW_MS + 3600_000 - 59_000;
    await p.getToken();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  });

  it('installation id もキャッシュに同居し、再解決しない', async () => {
    let now = NOW_MS;
    const { calls } = installFetch(defaultResponder);
    const p = provider(logger(), () => now);
    await p.getToken();
    now = NOW_MS + 3600_000;
    await p.getToken();
    // 2 回目は access_tokens だけを呼び直す（installation の再解決は不要）。
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  });

  it('provider ごとに状態が独立している（テスト間で漏れない）', async () => {
    const { calls } = installFetch(defaultResponder);
    await provider().getToken();
    await provider().getToken();
    // モジュールスコープの変数にキャッシュすると 2 本目の provider が
    // 1 本目のトークンを再利用してしまい、ここが 2 になる。
    expect(calls).toHaveLength(4);
  });
});

describe('401 の扱い', () => {
  it('installation を解決し直して 1 度だけ再試行し、それでも 401 なら投げる', async () => {
    const { calls } = installFetch((call) =>
      call.url.endsWith('/installation')
        ? okJson({ id: 12345678 })
        : okJson({ message: 'Bad credentials' }, 401),
    );
    await expect(provider().getToken()).rejects.toThrow(/401/);
    // **無限ループを作らない。** 初回 + 再試行のちょうど 2 回でやめる。
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('1 度目が 401 でも 2 度目が通れば回復する', async () => {
    let posts = 0;
    const { calls } = installFetch((call) => {
      if (call.url.endsWith('/installation')) return okJson({ id: 12345678 });
      posts += 1;
      return posts === 1
        ? okJson({ message: 'Bad credentials' }, 401)
        : okJson({ token: TOKEN, expires_at: EXPIRES_AT }, 201);
    });
    expect(await provider().getToken()).toBe(TOKEN);
    expect(calls).toHaveLength(4);
  });

  it('500 では再試行せずに投げる', async () => {
    const { calls } = installFetch((call) =>
      call.url.endsWith('/installation')
        ? okJson({ id: 12345678 })
        : okJson({ message: 'oops' }, 500),
    );
    await expect(provider().getToken()).rejects.toThrow(/500/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('installation の解決が 404 なら分かるメッセージで投げる', async () => {
    installFetch(() => okJson({ message: 'Not Found' }, 404));
    await expect(provider().getToken()).rejects.toThrow(/installation/i);
  });
});

describe('トークンが漏れない', () => {
  const scanLogger = (log: ReturnType<typeof logger>): string =>
    JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);

  it('成功系: ログにトークンも JWT も出ない', async () => {
    const { calls } = installFetch(defaultResponder);
    const log = logger();
    await provider(log).getToken();
    const logged = scanLogger(log);
    expect(logged).not.toContain(TOKEN);
    const jwt = (calls[0] as FetchCall).headers['authorization']?.slice('Bearer '.length) ?? '';
    expect(jwt.length).toBeGreaterThan(20);
    expect(logged).not.toContain(jwt);
    expect(logged).not.toContain('-----BEGIN');
  });

  it('401 系: ログにも例外にもトークンが出ない', async () => {
    installFetch((call) =>
      call.url.endsWith('/installation')
        ? okJson({ id: 12345678 })
        : okJson({ token: TOKEN, message: 'Bad credentials' }, 401),
    );
    const log = logger();
    let text = '';
    try {
      await provider(log).getToken();
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain(TOKEN);
    expect(scanLogger(log)).not.toContain(TOKEN);
  });

  it('500 系: レスポンス本文をそのまま例外に載せない', async () => {
    const leak = 'ghs_LEAKED_IN_ERROR_BODY_0123456789';
    installFetch((call) =>
      call.url.endsWith('/installation')
        ? okJson({ id: 12345678 })
        : okJson({ message: `boom ${leak}`, token: leak }, 500),
    );
    const log = logger();
    let text = '';
    try {
      await provider(log).getToken();
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain(leak);
    expect(scanLogger(log)).not.toContain(leak);
  });

  it('ネットワーク例外系: 元の例外を素通しせず、鍵もトークンも出さない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED with key ${privateKeyPem}`);
      }),
    );
    const log = logger();
    let text = '';
    try {
      await provider(log).getToken();
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain('-----BEGIN');
    expect(scanLogger(log)).not.toContain('-----BEGIN');
  });
});

describe('トークンを永続化しない', () => {
  it('process.env が前後で 1 バイトも変わらない', async () => {
    installFetch(defaultResponder);
    const before = JSON.stringify(process.env);
    await provider().getToken();
    expect(JSON.stringify(process.env)).toBe(before);
    expect(JSON.stringify(process.env)).not.toContain(TOKEN);
  });

  it('一時ディレクトリにファイルを作らない', async () => {
    // 「保管しない」（設計判断9）を実際のファイルシステムで確認する。
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const before = readdirSync(tmpdir()).sort().join('\n');
    installFetch(defaultResponder);
    await provider().getToken();
    expect(readdirSync(tmpdir()).sort().join('\n')).toBe(before);
  });
});
