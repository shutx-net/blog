import { describe, expect, it } from 'vitest';

import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  MEDIA_KEY_PREFIX,
} from '@blog/api/src/media/limits.ts';
import { createApiClient } from '../../src/api/client.ts';
import {
  PRESIGN_OPERATION,
  UploadSizeMismatchError,
  UploadValidationError,
  checkUploadable,
  mediaMarkdown,
  presignMedia,
  uploadToPresignedUrl,
} from '../../src/api/upload.ts';
import type { PresignResult } from '../../src/api/upload.ts';
import type { AuthTransport } from '../../src/auth/session.ts';

const auth: AuthTransport = {
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => true,
};

interface Captured {
  url: string;
  init: RequestInit;
}

const spyFetch = (
  response: () => Response,
): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { calls, impl };
};

const headerKeys = (captured: Captured | undefined): string[] =>
  Object.keys((captured?.init.headers ?? {}) as Record<string, string>)
    .map((key) => key.toLowerCase())
    .sort();

const presignResult = (overrides: Partial<PresignResult> = {}): PresignResult => ({
  url: 'https://bucket.s3.ap-northeast-1.amazonaws.com/media/2026/08/ab.png?X-Amz-Signature=x',
  key: 'media/2026/08/ab.png',
  expiresIn: 900,
  requiredHeaders: { 'content-type': 'image/png', 'content-length': '4' },
  ...overrides,
});

/** ブラウザの File の代わり。`size` と `type` だけ使う。 */
const blob = (size: number, type: string): Blob =>
  new Blob([new Uint8Array(size)], { type });

describe('限度と許可 content type は api の実物を使う', () => {
  it('MEDIA_KEY_PREFIX が media/ である', () => {
    // **コピーを持っていない。** api/src/media/limits.ts は依存ゼロなので
    // ブラウザ向けバンドルにそのまま入る。値がずれる余地が構造的に無い。
    expect(MEDIA_KEY_PREFIX).toBe('media/');
  });

  it('image/svg+xml と text/html が許可されていない', () => {
    // どちらもメディアバケットに置かれると CloudFront 経由で実行可能になる。
    expect(ALLOWED_CONTENT_TYPES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_CONTENT_TYPES.has('text/html')).toBe(false);
  });

  it('MAX_UPLOAD_BYTES が 10 MiB である', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('checkUploadable（ダイアログを開いた時点の検査）', () => {
  it.each([...ALLOWED_CONTENT_TYPES])('%s を通す', (type) => {
    expect(() => checkUploadable(blob(10, type))).not.toThrow();
  });

  it.each(['image/svg+xml', 'text/html', 'application/pdf', ''])('%s を拒否する', (type) => {
    expect(() => checkUploadable(blob(10, type))).toThrow(UploadValidationError);
  });

  it('**10 MiB 超をその場で拒否する**（presign を呼びに行かない）', () => {
    const error = (() => {
      try {
        checkUploadable(blob(0, 'image/png'), MAX_UPLOAD_BYTES + 1);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(UploadValidationError);
    expect((error as UploadValidationError).field).toBe('size');
  });

  it('ちょうど 10 MiB は通す（境界を off-by-one にしない）', () => {
    expect(() => checkUploadable(blob(0, 'image/png'), MAX_UPLOAD_BYTES)).not.toThrow();
  });

  it('0 バイトを拒否する', () => {
    expect(() => checkUploadable(blob(0, 'image/png'), 0)).toThrow(UploadValidationError);
  });
});

describe('presignMedia は 4.6 のラッパを通る', () => {
  it('contentType / size / filename を送り、必須ヘッダが付く', async () => {
    const fetchSpy = spyFetch(
      () =>
        new Response(JSON.stringify(presignResult()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createApiClient({ origin: '', auth, fetchImpl: fetchSpy.impl });
    await presignMedia(client, { contentType: 'image/png', size: 4, filename: 'photo.png' });

    const captured = fetchSpy.calls[0];
    expect(captured?.url).toBe('/api/media/presign');
    expect(captured?.init.method).toBe('POST');
    // **署名は 4.6 のラッパが付ける。** upload.ts はヘッダを知らない。
    expect(headerKeys(captured)).toEqual(['content-type', 'x-amz-content-sha256']);
    expect(JSON.parse(new TextDecoder().decode(captured?.init.body as Uint8Array))).toEqual({
      contentType: 'image/png',
      size: 4,
      filename: 'photo.png',
    });
  });

  it('PRESIGN_OPERATION が api のルート表の経路と一致する', () => {
    expect(PRESIGN_OPERATION).toEqual({ method: 'POST', path: '/api/media/presign' });
  });
});

describe('presigned PUT', () => {
  it('**x-amz-content-sha256 を付けない**', async () => {
    // 署名はクエリ文字列側にあり、S3 は presigned URL を UNSIGNED-PAYLOAD として
    // 扱う。実ハッシュのヘッダを足すと署名と食い違って 403 になる。
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await uploadToPresignedUrl(presignResult(), blob(4, 'image/png'), fetchSpy.impl);
    expect(headerKeys(fetchSpy.calls[0])).toEqual(['content-type']);
  });

  it('**content-length を Headers に入れない**', async () => {
    // fetch の禁止ヘッダ名。ブラウザは黙って捨てるが、**Node の undici は
    // 捨てずに通してしまう**ので「送られなかったこと」はテストできない。
    // だから「入れないこと」を直接主張する。
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await uploadToPresignedUrl(presignResult(), blob(4, 'image/png'), fetchSpy.impl);
    expect(headerKeys(fetchSpy.calls[0])).not.toContain('content-length');
  });

  it('PUT で presigned URL に、body に blob を渡す', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    const result = presignResult();
    const file = blob(4, 'image/png');
    await uploadToPresignedUrl(result, file, fetchSpy.impl);
    expect(fetchSpy.calls[0]?.init.method).toBe('PUT');
    expect(fetchSpy.calls[0]?.url).toBe(result.url);
    expect(fetchSpy.calls[0]?.init.body).toBe(file);
  });

  it('mode: cors / credentials: omit で送る', async () => {
    // メディアバケットは別オリジン。**資格情報は送らない**（presigned URL が
    // それ自体で認可を持っている）。
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await uploadToPresignedUrl(presignResult(), blob(4, 'image/png'), fetchSpy.impl);
    expect(fetchSpy.calls[0]?.init.mode).toBe('cors');
    expect(fetchSpy.calls[0]?.init.credentials).toBe('omit');
  });

  it('**サイズが content-length と違えば fetch を 1 度も呼ばずに落ちる**', async () => {
    // 署名済みの content-length と実バイト数がずれると S3 が 403 を返す。
    // 送る前に落とす（= ブラウザが content-length を送れないことの代替検査）。
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await expect(
      uploadToPresignedUrl(presignResult(), blob(5, 'image/png'), fetchSpy.impl),
    ).rejects.toThrow(UploadSizeMismatchError);
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('requiredHeaders に content-type が無ければ落ちる', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await expect(
      uploadToPresignedUrl(
        presignResult({ requiredHeaders: { 'content-length': '4' } }),
        blob(4, 'image/png'),
        fetchSpy.impl,
      ),
    ).rejects.toThrow(UploadValidationError);
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('requiredHeaders に content-length が無ければ落ちる', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await expect(
      uploadToPresignedUrl(
        presignResult({ requiredHeaders: { 'content-type': 'image/png' } }),
        blob(4, 'image/png'),
        fetchSpy.impl,
      ),
    ).rejects.toThrow(UploadValidationError);
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('**presign が返した contentType が許可外なら送る前に落ちる**', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    await expect(
      uploadToPresignedUrl(
        presignResult({ requiredHeaders: { 'content-type': 'image/svg+xml', 'content-length': '4' } }),
        blob(4, 'image/svg+xml'),
        fetchSpy.impl,
      ),
    ).rejects.toThrow(UploadValidationError);
    expect(fetchSpy.calls.length).toBe(0);
  });

  it('S3 が非 2xx を返したら落ちる', async () => {
    const fetchSpy = spyFetch(() => new Response('<Error/>', { status: 403 }));
    await expect(
      uploadToPresignedUrl(presignResult(), blob(4, 'image/png'), fetchSpy.impl),
    ).rejects.toThrow(/403/);
  });

  it('成功したら key を返す', async () => {
    const fetchSpy = spyFetch(() => new Response('', { status: 200 }));
    expect(await uploadToPresignedUrl(presignResult(), blob(4, 'image/png'), fetchSpy.impl)).toBe(
      'media/2026/08/ab.png',
    );
  });
});

describe('mediaMarkdown', () => {
  it('**先頭スラッシュを付ける**', () => {
    // 付けないと相対パスになり、4.5 の警告に引っかかる（本番のビルドも落ちる）。
    expect(mediaMarkdown('media/2026/08/ab.png', '説明')).toBe('![説明](/media/2026/08/ab.png)');
  });

  it('既に先頭スラッシュがあっても二重にしない', () => {
    expect(mediaMarkdown('/media/2026/08/ab.png', '説明')).toBe('![説明](/media/2026/08/ab.png)');
  });

  it('alt が空でも壊れない', () => {
    expect(mediaMarkdown('media/x.png', '')).toBe('![](/media/x.png)');
  });

  it('出力が 4.5 の相対パス検出に引っかからない', async () => {
    const { relativeImagePaths } = await import('../../src/preview/images.ts');
    expect(relativeImagePaths(mediaMarkdown('media/2026/08/ab.png', 'alt'))).toEqual([]);
  });

  it('alt の ] と改行をエスケープする', () => {
    // ファイル名や説明に ] が入ると Markdown が壊れる。
    expect(mediaMarkdown('media/x.png', 'a]b')).toBe('![a\\]b](/media/x.png)');
    expect(mediaMarkdown('media/x.png', 'a\nb')).toBe('![a b](/media/x.png)');
  });
});
