import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { ApiRequest, ApiResponse } from './http.ts';
import { errorResponse } from './http.ts';
import type { Logger } from './deps.ts';

/**
 * Function URL のイベントを ApiRequest に変換する。
 *
 * **このモジュールは副作用を持たない。** index.ts はモジュールスコープで設定を
 * 検証して throw する設計なので、変換だけを使いたいテストが巻き込まれないよう分けてある。
 */
export const toApiRequest = (event: LambdaFunctionURLEvent): ApiRequest => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }

  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(event.rawQueryString ?? '')) {
    query[name] = value;
  }

  // **rawPath は '/api/posts' のまま届く。** CloudFront の /api/* ビヘイビアに
  // originPath を設定していないので、パスは削られない。
  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    headers,
    query,
    rawBody:
      event.body === undefined
        ? undefined
        : event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body,
  };
};

/**
 * Lambda に返す形。
 *
 * LambdaFunctionURLResult は「構造化レスポンス | 文字列 | void」の union なので、
 * そのまま戻り値の型にするとテストが statusCode を読めない。ここで具体形を宣言し、
 * **Lambda の契約から外れていないことは下の型レベルの表明で固定する。**
 */
export interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** FunctionUrlResponse が Lambda の受け付ける形であることの静的表明（実行時コード無し）。 */
type AssertResponseMatchesLambdaContract =
  FunctionUrlResponse extends LambdaFunctionURLResult ? true : never;
export type _FunctionUrlResponseIsValid = AssertResponseMatchesLambdaContract;

/**
 * ハンドラを組み立てる。
 *
 * **ここにロジックを置かない。** イベントの変換と、想定外の例外を 500 にすること
 * だけを担当する。ロジックを持たせると「200 が返った」しか言えないテストしか書けなくなる。
 */
export const createHandler =
  (run: (request: ApiRequest) => Promise<ApiResponse>, logger: Logger) =>
  async (event: LambdaFunctionURLEvent): Promise<FunctionUrlResponse> => {
    let response: ApiResponse;
    try {
      response = await run(toApiRequest(event));
    } catch (error) {
      // **本文に例外メッセージもスタックも載せない。** 内部構造を漏らさない。
      // ログには名前だけを出す（メッセージには入力の断片が入りうる）。
      logger.error('unhandled error', { name: (error as Error).name });
      response = errorResponse(500, 'internal_error');
    }
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  };
