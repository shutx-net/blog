/**
 * Function URL の HTTP 層。Lambda のイベント形とは切り離してある
 * （index.ts がイベントをこの形に変換する）。ルータもハンドラも
 * aws-lambda の型を知らないので、単体テストが実イベントの形に縛られない。
 */
export interface ApiRequest {
  /** 'GET' / 'POST' など。大文字。 */
  method: string;
  /** '/api/posts'。**CloudFront に originPath を設定していないので削られない。** */
  path: string;
  /** キーは小文字化済み。HTTP ヘッダ名は大文字小文字を区別しない。 */
  headers: Record<string, string>;
  /** クエリ文字列。値は 1 つだけ持つ（同名複数は Function URL がカンマ連結する）。 */
  query: Record<string, string>;
  /** base64 デコード済みの生ボディ。JSON パースはルータが行う。 */
  rawBody: string | undefined;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * ボディが JSON として壊れているときに投げる。
 *
 * **メッセージにボディの中身を含めない。** 本文に誤って貼られた資格情報が
 * ログや 500 応答に出る事故を防ぐ。JSON.parse の SyntaxError は
 * 'Unexpected token } in JSON at position 42' のように **入力の断片を含む**ので、
 * そのまま伝播させてはいけない。
 */
export class InvalidJsonBodyError extends Error {
  constructor() {
    super('request body is not a JSON object');
    this.name = 'InvalidJsonBodyError';
  }
}

/**
 * すべての応答に付ける共通ヘッダ。
 *
 * Cache-Control: no-store は CloudFront の CACHING_DISABLED と **二重化**している。
 * キャッシュポリシー ID を取り違えても API 側で守られる。
 */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

export const jsonResponse = (statusCode: number, payload: unknown): ApiResponse => ({
  statusCode,
  headers: { ...COMMON_HEADERS },
  body: JSON.stringify(payload),
});

/** 機械可読なエラーコードだけを返す。内部構造も例外メッセージも載せない。 */
export const errorResponse = (statusCode: number, code: string): ApiResponse =>
  jsonResponse(statusCode, { error: code });

/**
 * Content-Type が application/json か。charset などのパラメータは許す。
 * ヘッダが無い場合は false（既定を application/json とみなさない）。
 */
export const isJsonContentType = (headers: Record<string, string>): boolean => {
  const value = headers['content-type'];
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
};

/**
 * JSON オブジェクトとしてパースする。配列・数値・null・文字列は受け付けない
 * （どれもフィールドを持たず、後段の検証が「全部欠けている」と報告するしかなくなる）。
 */
export const parseJsonObject = (rawBody: string | undefined): Record<string, unknown> => {
  if (rawBody === undefined || rawBody.length === 0) throw new InvalidJsonBodyError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // SyntaxError は入力の断片をメッセージに含むので握りつぶす。
    throw new InvalidJsonBodyError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidJsonBodyError();
  }
  return parsed as Record<string, unknown>;
};
