import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { API_OPERATIONS, createApiClient } from '../../src/api/client.ts';
import type { ApiOperation } from '../../src/api/client.ts';
import { createStubAuthTransport } from '../../src/auth/session.ts';
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

describe('**認証の知識が session.ts の外に無い**', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(`${dir}${entry.name}/`)
        : entry.name.endsWith('.ts')
          ? [`${dir}${entry.name}`]
          : [],
    );

  const files = sourceFiles(SRC_DIR).filter((path) => !path.endsWith('src/auth/session.ts'));

  it('走査対象が空でない', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('session.ts が実在する（許可リストが空振りしていない）', () => {
    expect(sourceFiles(SRC_DIR)).toContain(`${SRC_DIR}auth/session.ts`);
  });

  it.each(['Cognito', 'cognito', 'document.cookie', 'localStorage', 'sessionStorage'])(
    '%s が session.ts 以外に現れない',
    (needle) => {
      const offenders = files.filter((path) => readFileSync(path, 'utf8').includes(needle));
      expect(offenders.map((path) => path.replace(SRC_DIR, ''))).toEqual([]);
    },
  );

  it('Authorization という綴りが api/client.ts の防御以外に現れない', () => {
    // client.ts は「authorization を投げる」ための 1 箇所だけ知っている。
    // それ以外のファイルは綴りすら持たない。
    const offenders = files
      .filter((path) => !path.endsWith('src/api/client.ts'))
      .filter((path) => /authorization/i.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => path.replace(SRC_DIR, ''))).toEqual([]);
  });
});
