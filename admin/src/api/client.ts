import type { AuthTransport } from '../auth/session.ts';
import { EMPTY_PAYLOAD_SHA256, sha256Hex, utf8Bytes } from './sha256.ts';

/** ルート表の 1 行。api/src/router.ts の `Route` から method と path だけを取ったもの。 */
export interface ApiOperation {
  method: string;
  path: string;
}

/**
 * admin が叩く API の全経路。
 *
 * **`api/src/router.ts` の `ROUTES` と集合として一致していること**を
 * test/unit/api-client.test.ts が主張している。api に経路が増えたらここが
 * 赤くなるので、「admin が古い表のまま新しい経路を素の fetch で叩く」という
 * 壊れ方が構造的に起きない。
 *
 * **router.ts をブラウザから import しない。** router.ts は media/presign.ts 経由で
 * `@aws-sdk/*` と `node:crypto` を引き込むのでバンドルできない。突き合わせは
 * node 環境のテストの仕事にしてある。
 */
export const API_OPERATIONS: readonly ApiOperation[] = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/health/github-app' },
  { method: 'POST', path: '/api/posts' },
  { method: 'POST', path: '/api/media/presign' },
];

/**
 * API が返した非 2xx。
 *
 * **パラメータプロパティを使っていない。** `erasableSyntaxOnly` は
 * `constructor(readonly status: number)` を TS1294 で拒否する。
 * api/src/posts/validate.ts の `PostValidationError` と同じ書き方に揃えている。
 *
 * **メッセージに入力値を含めない**（api 側と同じ規律）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(status: number, code: string, field?: string) {
    super(`api request failed with ${status}: ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** JSON でないボディが返ってきたときのコード。CloudFront の 404 HTML がこれになる。 */
export const NON_JSON_RESPONSE = 'non_json_response';

export interface ApiClientDeps {
  /** 既定は同一オリジン。テストと smoke が差し替える。 */
  origin?: string;
  auth: AuthTransport;
  /** 注入可能な fetch。テストはスパイを刺す（api/src/deps.ts と同じ思想）。 */
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  call(operation: ApiOperation, body?: unknown): Promise<unknown>;
}

/**
 * **API に触る唯一の入口。**
 *
 * `x-amz-content-sha256` の付与をここ 1 箇所に閉じ込めているのが要点。
 * test/unit/no-raw-fetch.test.ts が「素の fetch は client.ts と upload.ts に
 * しか無い」ことを走査で固定しているので、**この関数を通らない API 呼び出しは
 * 書けない。**
 */
export const createApiClient = (deps: ApiClientDeps): ApiClient => {
  const origin = deps.origin ?? '';
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const call = async (operation: ApiOperation, body?: unknown): Promise<unknown> => {
    // **バイト列は 1 度だけ作る。** 同じ列をハッシュし、同じ列を fetch に渡す。
    // 文字列を渡して別途ハッシュする形にすると、いつか片方だけ変わる。
    const bytes = body === undefined ? undefined : utf8Bytes(JSON.stringify(body));

    const authHeaders = await deps.auth.authHeaders();
    for (const name of Object.keys(authHeaders)) {
      if (name.toLowerCase() === 'authorization') {
        // 黙って無視すると、CloudFront が OAC の SigV4 で上書きした結果
        // 「認証が通らない理由が分からない」状態になる。その場で落とす。
        throw new Error(
          'AuthTransport must not set `authorization`: CloudFront overwrites it with the OAC SigV4 signature. Use a custom header (e.g. x-blog-authorization) or a cookie.',
        );
      }
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      ...(bytes === undefined ? {} : { 'content-type': 'application/json' }),
      // **最後に置くことが要件。** transport が何を返しても、実際に送られる
      // ハッシュは body のものに上書きされる。
      // GET にも付ける — 実測で空ペイロードの定数を付けた GET は 200 で通る。
      // body の有無で分岐すると「GET には要らない」という知識が呼び出し側に漏れる。
      'x-amz-content-sha256': bytes === undefined ? EMPTY_PAYLOAD_SHA256 : await sha256Hex(bytes),
    };

    const response = await fetchImpl(`${origin}${operation.path}`, {
      method: operation.method,
      headers,
      credentials: deps.auth.credentials,
      ...(bytes === undefined ? {} : { body: bytes }),
    });

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      // 署名が失敗すると 403 が CustomErrorResponses で **404 の HTML** に化ける。
      // ここで JSON.parse を投げさせると「何が起きたか分からない例外」になる。
      payload = undefined;
    }

    if (!response.ok) {
      const record = (payload ?? {}) as Record<string, unknown>;
      const code = typeof record['error'] === 'string' ? record['error'] : NON_JSON_RESPONSE;
      const field = typeof record['field'] === 'string' ? record['field'] : undefined;
      throw new ApiError(response.status, code, field);
    }

    return payload;
  };

  return { call };
};
