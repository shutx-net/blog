import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeployDispatcher } from '../../src/github/dispatch.ts';
import { GITHUB_API_VERSION } from '../../src/github/token.ts';

const TOKEN = 'ghs_dispatch_token';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const installFetch = (responder: (call: FetchCall) => Response) => {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body:
          init?.body === undefined
            ? undefined
            : (JSON.parse(String(init.body)) as Record<string, unknown>),
      };
      calls.push(call);
      return responder(call);
    }),
  );
  return { calls };
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** 解決したら失敗させる。**catch だけ書くと「投げなかった」が緑になる。** */
const rejection = async (promise: Promise<void>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the dispatch to reject, but it resolved');
};

const dispatcher = (log = logger()) =>
  createDeployDispatcher({
    tokenProvider: { getToken: vi.fn(async () => TOKEN) },
    owner: 'shutx-net',
    repo: 'blog',
    workflowFile: 'deploy.yml',
    logger: log,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workflow_dispatch の送信', () => {
  it('POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches に ref:main を送る', async () => {
    // docs: "Create a workflow dispatch event" — body は {ref} が必須。
    // ref をブランチ名にすると GITHUB_REF が refs/heads/main になり、
    // OIDC の sub が DEPLOY_SUBJECT と一致する（infra/lib/cicd-stack.ts）。
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    await dispatcher().dispatch();

    expect(calls).toHaveLength(1);
    const call = calls[0] as FetchCall;
    expect(call.url).toBe(
      'https://api.github.com/repos/shutx-net/blog/actions/workflows/deploy.yml/dispatches',
    );
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ ref: 'main' });
  });

  it('API バージョンを固定して送る', () => {
    expect(GITHUB_API_VERSION).toBe('2026-03-10');
  });

  it('固定した API バージョンヘッダを付ける', async () => {
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    await dispatcher().dispatch();
    expect((calls[0] as FetchCall).headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
  });

  it('installation token を Bearer で送る', async () => {
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    await dispatcher().dispatch();
    expect((calls[0] as FetchCall).headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('ワークフローファイル名を URL エンコードする', async () => {
    // 設定ミスでパス片が混ざったとき、別のエンドポイントに化けさせない。
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    await createDeployDispatcher({
      tokenProvider: { getToken: vi.fn(async () => TOKEN) },
      owner: 'shutx-net',
      repo: 'blog',
      workflowFile: 'a/b.yml',
      logger: logger(),
    }).dispatch();
    expect((calls[0] as FetchCall).url).toContain('/actions/workflows/a%2Fb.yml/dispatches');
  });
});

describe('失敗の扱い', () => {
  it('**dispatch の失敗はレスポンス本文を読まない**', async () => {
    // 本文をそのまま例外に載せる書き癖を作らない（token.ts と同じ規律）。
    // 応答が要求をエコーする実装に変わったとき、トークンが例外経由で漏れる。
    const secret = 'ghs_leaked_secret_value';
    const { calls } = installFetch(
      () => new Response(JSON.stringify({ message: secret }), { status: 403 }),
    );
    const error = await rejection(dispatcher().dispatch());

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('403');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(TOKEN);
  });

  it('fetch の例外は name だけを転記する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error(`connect ECONNREFUSED https://api.github.com/?t=${TOKEN}`);
        error.name = 'TypeError';
        throw error;
      }),
    );
    const error = await rejection(dispatcher().dispatch());

    expect(error.message).toContain('TypeError');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('204 以外の 2xx も成功として扱わない', async () => {
    // docs の Response は 204 のみ。200 が返るのは想定外の経路なので、
    // 「起動した」と言い切らずに失敗として扱う。
    installFetch(() => new Response(null, { status: 200 }));
    await expect(dispatcher().dispatch()).rejects.toThrow(/200/);
  });

  it('トークンをログに出さない', async () => {
    const log = logger();
    installFetch(() => new Response(null, { status: 204 }));
    await dispatcher(log).dispatch();

    const written = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join(' ');
    expect(written).not.toContain(TOKEN);
  });
});
