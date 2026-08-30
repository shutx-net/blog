import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
// infra 側の定数と突き合わせる。CloudFront のビヘイビアと S3 のキー空間と
// IAM のリソース ARN の 3 つが同じ接頭辞で揃っていないと動かない。
import { MEDIA_PATH_PATTERN } from '../../../infra/lib/site-stack.ts';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  MEDIA_KEY_PREFIX,
  PRESIGN_EXPIRES_IN_SECONDS,
  createMediaPresigner,
} from '../../src/media/presign.ts';

const BUCKET = 'blogsitestack-mediabuckete52fc6e4-b1oxcxj9xnmq';
const SITE_BUCKET = 'blogsitestack-sitebucket397a1860-e3zopw1xfjqy';

/** AWS 公式ドキュメントの例示キー。実在しない。 */
const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const NOW_MS = Date.UTC(2026, 7, 30, 12, 0, 0);

const presigner = (log = logger(), bucket = BUCKET) =>
  createMediaPresigner({
    bucket,
    region: 'ap-northeast-1',
    credentials: CREDENTIALS,
    logger: log,
    now: () => NOW_MS,
  });

const presign = async (
  overrides: Partial<{ contentType: string; size: number; filename: string }> = {},
) => presigner().presign({ contentType: 'image/png', size: 1024, ...overrides });

const queryOf = async (
  overrides: Partial<{ contentType: string; size: number; filename: string }> = {},
): Promise<URLSearchParams> => new URL((await presign(overrides)).url).searchParams;

describe('署名対象のヘッダ（本 step の核心）', () => {
  it('**X-Amz-SignedHeaders に content-type と content-length と host が入る**', async () => {
    // 実測: PutObjectCommand に ContentType を渡すだけでは SignedHeaders は host だけになり、
    // **content type は署名に一切入らない**。getSignedUrl に signableHeaders を渡して初めて
    // content-length;content-type;host になる。素朴な実装は静かに要件を満たさないので、
    // このアサーションが唯一の防波堤になる。
    const signed = (await queryOf()).get('X-Amz-SignedHeaders') ?? '';
    const headers = signed.split(';').sort();
    expect(headers).toContain('content-type');
    expect(headers).toContain('content-length');
    expect(headers).toContain('host');
  });

  it('SignedHeaders がちょうど content-length;content-type;host である', async () => {
    expect((await queryOf()).get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });

  it('**requiredHeaders に実際の content type と size が入る**', async () => {
    // SignedHeaders を見るだけでは足りない。signableHeaders に 'content-type' を入れつつ
    // PutObjectCommand に ContentType を渡し忘れても、SignedHeaders には content-type が
    // 載る（＝ 空の content type が署名される）。何を送るべきかを API 側から明示する。
    const result = await presign({ contentType: 'image/webp', size: 4096 });
    expect(result.requiredHeaders).toEqual({
      'content-type': 'image/webp',
      'content-length': '4096',
    });
  });

  it('署名した ContentLength が申告された size と一致する', async () => {
    // S3 は署名された content-length と完全一致を要求する。「最大サイズ」は
    // 「API が上限を検証したうえで申告値を署名に焼く」という形で実現される。
    for (const size of [1, 1024, MAX_UPLOAD_BYTES]) {
      const result = await presign({ size });
      expect(result.requiredHeaders['content-length']).toBe(String(size));
    }
  });
});

describe('チェックサムのクエリが焼き込まれない', () => {
  it('**x-amz-checksum-* も x-amz-sdk-checksum-algorithm も現れない**', async () => {
    // 実測: 既定の S3Client は x-amz-checksum-crc32=AAAAAA==（空ボディの CRC32）を
    // 署名済みクエリに焼き込む。ブラウザが実ボディを PUT した瞬間に不一致で失敗する。
    const query = await queryOf();
    for (const key of [...query.keys()]) {
      expect(key.toLowerCase(), `${key} が署名済みクエリに入っている`).not.toMatch(
        /^x-amz-checksum-/,
      );
      expect(key.toLowerCase()).not.toBe('x-amz-sdk-checksum-algorithm');
    }
  });

  it('URL 全体を見ても checksum の痕跡が無い', async () => {
    const { url } = await presign();
    expect(url.toLowerCase()).not.toContain('checksum');
  });
});

describe('content type の allowlist', () => {
  it.each([...ALLOWED_CONTENT_TYPES])('%s は通る', async (contentType) => {
    expect((await presign({ contentType })).url).toContain('https://');
  });

  it('allowlist が画像 5 種ちょうどである', () => {
    expect([...ALLOWED_CONTENT_TYPES].sort()).toEqual([
      'image/avif',
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'text/plain',
    'application/pdf',
    'video/mp4',
    'application/octet-stream',
    'IMAGE/PNG',
    'image/png; charset=utf-8',
    '',
  ])('%o は 400 相当の例外になる', async (contentType) => {
    // **text/html と image/svg+xml を名指しで落とす。** どちらもメディアバケットに
    // 置かれると CloudFront 経由で実行可能なコンテンツになる。
    await expect(presign({ contentType })).rejects.toThrow();
  });
});

describe('サイズの検証', () => {
  it('上限がちょうど 10 MiB である', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(10485760);
  });

  it('上限ちょうどは通る', async () => {
    expect((await presign({ size: MAX_UPLOAD_BYTES })).requiredHeaders['content-length']).toBe(
      String(MAX_UPLOAD_BYTES),
    );
  });

  it.each([0, -1, MAX_UPLOAD_BYTES + 1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    'size が %o なら例外',
    async (size) => {
      await expect(presign({ size })).rejects.toThrow();
    },
  );
});

describe('生成されるキー', () => {
  it('MEDIA_KEY_PREFIX が infra の MEDIA_PATH_PATTERN から導出できる形である', () => {
    // '/media/*' -> 'media/'。CloudFront のビヘイビア・S3 のキー空間・
    // IAM のリソース ARN の 3 つが揃っていないと動かない。
    expect(MEDIA_PATH_PATTERN).toBe('/media/*');
    expect(MEDIA_KEY_PREFIX).toBe('media/');
    expect(`/${MEDIA_KEY_PREFIX}*`).toBe(MEDIA_PATH_PATTERN);
  });

  it('キーが media/ で始まる', async () => {
    expect((await presign()).key.startsWith(MEDIA_KEY_PREFIX)).toBe(true);
  });

  it.each([
    '../../etc/passwd',
    'a b.png',
    '日本語.png',
    'evil.html',
    '../../../root/.ssh/id_rsa',
    'x'.repeat(500),
    '',
    'a/b/c.png',
    'file%00.png',
  ])('ファイル名 %o がそのままキーに入らない', async (filename) => {
    const { key } = await presign({ filename });
    expect(key).toMatch(/^media\/\d{4}\/\d{2}\/[a-z0-9]{16,}\.(png|jpe?g|webp|gif|avif)$/);
    expect(key).not.toContain('..');
    expect(key).not.toContain(' ');
  });

  it('拡張子が content type から導出される（ファイル名の拡張子を信用しない）', async () => {
    expect((await presign({ filename: 'evil.html', contentType: 'image/png' })).key).toMatch(
      /\.png$/,
    );
    expect((await presign({ filename: 'a.png', contentType: 'image/jpeg' })).key).toMatch(/\.jpg$/);
    expect((await presign({ filename: 'a.png', contentType: 'image/avif' })).key).toMatch(/\.avif$/);
  });

  it('注入したクロックの年月がキーに入る', async () => {
    expect((await presign()).key.startsWith('media/2026/08/')).toBe(true);
  });

  it('毎回異なるキーになる（既存を上書きしない）', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i += 1) keys.add((await presign()).key);
    expect(keys.size).toBe(20);
  });
});

describe('URL のかたち', () => {
  it('X-Amz-Expires が 900（15 分）である', async () => {
    expect(PRESIGN_EXPIRES_IN_SECONDS).toBe(900);
    expect((await queryOf()).get('X-Amz-Expires')).toBe('900');
    expect((await presign()).expiresIn).toBe(900);
  });

  it('7 日を超える有効期限はライブラリが拒否する', async () => {
    // 実測: 604801 で 'Signature version 4 presigned URLs must have an expiration
    // date less than one week in the future'。
    const p = createMediaPresigner({
      bucket: BUCKET,
      region: 'ap-northeast-1',
      credentials: CREDENTIALS,
      logger: logger(),
      now: () => NOW_MS,
      expiresIn: 604801,
    });
    await expect(p.presign({ contentType: 'image/png', size: 10 })).rejects.toThrow(/week|expiration/i);
  });

  it('ホストが **メディアバケット**で、サイト配信用バケットではない', async () => {
    const { url } = await presign();
    const host = new URL(url).host;
    expect(host).toContain(BUCKET);
    expect(host).not.toContain(SITE_BUCKET);
    expect(url).not.toContain(SITE_BUCKET);
  });

  it('SigV4 で署名されている', async () => {
    const query = await queryOf();
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(query.get('X-Amz-Credential')).toContain('ap-northeast-1');
  });

  it('ServerSideEncryption を署名に含めない', async () => {
    // 含めるとブラウザ側で x-amz-server-side-encryption を必ず付ける必要が出る。
    // バケットは既に SSE-S3 が既定なので、渡さなくても暗号化される。
    expect((await queryOf()).get('X-Amz-SignedHeaders')).not.toContain('server-side-encryption');
    expect((await presign()).url).not.toContain('server-side-encryption');
  });

  it('URL のパスが生成したキーと一致する', async () => {
    const result = await presign();
    expect(decodeURIComponent(new URL(result.url).pathname)).toBe(`/${result.key}`);
  });
});

/**
 * **署名そのものを検証する。**
 *
 * SignedHeaders と requiredHeaders を見るだけでは足りない。signableHeaders に
 * 'content-type' を入れつつ PutObjectCommand に ContentType を渡し忘れても、
 * SignedHeaders には content-type が載る（＝空の content type が署名される）し、
 * requiredHeaders は入力から組み立てているので何も変わらない。
 * **実測でその実装は他の 52 件を全部通した。**
 *
 * そこで、宣言した content type と content-length で正準リクエストを組み直し、
 * SigV4 を自分で計算して X-Amz-Signature と突き合わせる。一致すれば
 * 「署名がその値を本当に含んでいる」ことの証明になる。
 */
const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const recomputeSignature = (
  url: string,
  headers: { 'content-type': string; 'content-length': string },
): string => {
  const parsed = new URL(url);
  const query = parsed.searchParams;
  const canonicalQuery = [...query.entries()]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .sort()
    .join('&');

  const signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
  const headerValues: Record<string, string> = {
    'content-length': headers['content-length'],
    'content-type': headers['content-type'],
    host: parsed.host,
  };
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${headerValues[name] ?? ''}\n`)
    .join('');

  const payloadHash = query.get('X-Amz-Content-Sha256') ?? 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [
    'PUT',
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const amzDate = query.get('X-Amz-Date') ?? '';
  const scope = (query.get('X-Amz-Credential') ?? '').split('/').slice(1).join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const [dateStamp, region, service] = scope.split('/');
  const kDate = createHmac('sha256', `AWS4${CREDENTIALS.secretAccessKey}`).update(dateStamp ?? '').digest();
  const kRegion = createHmac('sha256', kDate).update(region ?? '').digest();
  const kService = createHmac('sha256', kRegion).update(service ?? '').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  return createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
};

describe('署名が宣言どおりの値を含んでいる（自前で SigV4 を再計算して照合）', () => {
  it.each([
    ['image/png', 1024],
    ['image/jpeg', 1],
    ['image/webp', MAX_UPLOAD_BYTES],
    ['image/avif', 65536],
  ] as Array<[string, number]>)(
    'contentType=%s size=%d の署名が再計算と一致する',
    async (contentType, size) => {
      const result = await presign({ contentType, size });
      const actual = new URL(result.url).searchParams.get('X-Amz-Signature');
      expect(actual).toBe(
        recomputeSignature(result.url, {
          'content-type': contentType,
          'content-length': String(size),
        }),
      );
    },
  );

  it('**別の content type で再計算すると一致しない**（照合が空虚でないこと）', async () => {
    const result = await presign({ contentType: 'image/png', size: 1024 });
    const actual = new URL(result.url).searchParams.get('X-Amz-Signature');
    expect(actual).not.toBe(
      recomputeSignature(result.url, { 'content-type': 'image/jpeg', 'content-length': '1024' }),
    );
    expect(actual).not.toBe(
      recomputeSignature(result.url, { 'content-type': '', 'content-length': '1024' }),
    );
  });

  it('**別の size で再計算すると一致しない**（上限ではなく申告値が署名されている）', async () => {
    const result = await presign({ contentType: 'image/png', size: 1024 });
    const actual = new URL(result.url).searchParams.get('X-Amz-Signature');
    expect(actual).not.toBe(
      recomputeSignature(result.url, {
        'content-type': 'image/png',
        'content-length': String(MAX_UPLOAD_BYTES),
      }),
    );
  });
});

describe('署名済み URL が漏れない', () => {
  it('ログに URL も署名も出ない（キーだけは出してよい）', async () => {
    // URL には X-Amz-Signature が含まれ、期限内なら誰でもそのキーに書き込める。
    const log = logger();
    const result = await presigner(log).presign({ contentType: 'image/png', size: 10 });
    const logged = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(logged).not.toContain(result.url);
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).not.toContain(new URL(result.url).searchParams.get('X-Amz-Signature') ?? 'IMPOSSIBLE');
    expect(logged).not.toContain(CREDENTIALS.secretAccessKey);
    expect(logged).not.toContain(CREDENTIALS.accessKeyId);
  });

  it('検証で落ちるときも例外に URL が出ない', async () => {
    const log = logger();
    let text = '';
    try {
      await presigner(log).presign({ contentType: 'text/html', size: 10 });
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).not.toContain(CREDENTIALS.secretAccessKey);
  });
});
