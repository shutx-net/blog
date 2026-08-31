import { base64UrlDecodeToBytes } from './base64url.ts';

/**
 * ID トークンのクレームを**読むだけ**のモジュール。**検証はしない。**
 *
 * # ここは検証器ではない
 *
 * **検証の権威は api ただ 1 つ。** `api/src/auth/cognito.ts` が `aws-jwt-verify` で
 * iss / aud / token_use / exp / 署名を見たうえ、`cognito:username` の完全一致まで見ている。
 * admin が同じ検証を二重にやっても**セキュリティ上の利得はゼロ**で、鍵の取得・鍵の
 * キャッシュ・署名照合という一式（＝ ブラウザ向け JWT ライブラリを入れる唯一の理由）が
 * 丸ごと不要になる。
 *
 * `test/unit/auth-claims.test.ts` が「このファイルに署名照合の綴りが 1 つも現れない」
 * ことを走査で固定している。**ここに検証を生やさせない。**
 *
 * # ここで読む値の用途は 2 つだけ
 *
 * 1. `expiresAtMs` -> リフレッシュの判断（`refresh.ts`）
 * 2. `audience` / `issuer` / `tokenUse` -> **トークンエンドポイントの応答が
 *    想定どおりかの健全性チェック**（`isAcceptable`）
 *
 * 2 は攻撃対策というより『設定を間違えたときに黙って進まない』ための番人である。
 * **攻撃者がトークンを差し替えられる位置にいるなら、この関数を通ること自体は防げない。**
 * 過大な主張をしない。
 *
 * # 継ぎ目の方針と一致している
 *
 * `session.ts` の docstring が既に『isAuthenticated は画面の出し分け用。認可の判断には
 * 使わない』と書いており、この方針と一致している。
 */

export interface IdTokenClaims {
  /**
   * `exp`（秒）をミリ秒に直したもの。
   *
   * **単位の変換はここ 1 箇所でだけ行う。** 呼び出し側に秒を渡すと、いつか
   * 1000 倍を取り違えて「永遠に有効」か「常に期限切れ」になる。
   */
  expiresAtMs: number;
  /** `aud`。文字列でも配列でもここで配列に正規化する（OIDC ではどちらもありうる）。 */
  audience: string[];
  issuer: string | undefined;
  /** `token_use`。ID トークンなら `'id'`。 */
  tokenUse: string | undefined;
  /** `cognito:username`。表示にしか使わない（認可の判断は api）。 */
  username: string | undefined;
}

/** 期待する発行元。`config.ts` の値をそのまま渡す。 */
export interface ExpectedIssuer {
  clientId: string;
  issuer: string;
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * 3 セグメントの JWT からペイロードを読む。
 *
 * **投げない。** 壊れたトークンは `undefined` を返して「無い」と同じ扱いにする。
 * 呼び出し側に try/catch を強制すると、そのうちどこかで握り潰され方が変わる。
 *
 * **`exp` が数値として読めないトークンは受け入れない。** 期限を知らないまま持ち続けると
 * 「永遠に有効」として扱ってしまい、リフレッシュの判断が成立しなくなる。
 */
export const readIdTokenClaims = (jwt: string): IdTokenClaims | undefined => {
  try {
    const segments = jwt.split('.');
    if (segments.length !== 3) return undefined;

    const payloadSegment = segments[1];
    if (payloadSegment === undefined || payloadSegment.length === 0) return undefined;

    // **`atob` の結果をそのまま JSON.parse すると UTF-8 が化ける。**
    // バイト列に戻してから TextDecoder を通すこと。
    const text = new TextDecoder().decode(base64UrlDecodeToBytes(payloadSegment));
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

    const payload = parsed as Record<string, unknown>;
    const exp = payload['exp'];
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;

    const aud = payload['aud'];
    const audience =
      typeof aud === 'string'
        ? [aud]
        : Array.isArray(aud)
          ? aud.filter((entry): entry is string => typeof entry === 'string')
          : [];

    return {
      expiresAtMs: exp * 1000,
      // 文字列でない要素が混ざっていた場合に長さが変わるので、そのまま渡して
      // isAcceptable 側で「clientId ちょうど 1 件」を要求する。
      audience: Array.isArray(aud) && audience.length !== aud.length ? [] : audience,
      issuer: stringOrUndefined(payload['iss']),
      tokenUse: stringOrUndefined(payload['token_use']),
      username: stringOrUndefined(payload['cognito:username']),
    };
  } catch {
    return undefined;
  }
};

/**
 * 応答のトークンが**このアプリ宛のものか**を見る健全性チェック。
 *
 * - `aud` が `clientId` ちょうど 1 件（配列に他が混ざっていたら拒否）
 * - `iss` が完全一致
 * - `token_use` が `'id'` ちょうど（access トークンをここで弾く。**api も 401 で弾く**）
 *
 * **これを「検証」と呼ばない。** 署名を見ていないので、改竄されたトークンでも
 * この 3 条件は満たせる。守っているのは『設定ミスや取り違えで黙って進むこと』であって、
 * 攻撃者ではない。
 */
export const isAcceptable = (
  claims: IdTokenClaims | undefined,
  expected: ExpectedIssuer,
): boolean => {
  if (claims === undefined) return false;
  if (claims.audience.length !== 1) return false;
  if (claims.audience[0] !== expected.clientId) return false;
  if (claims.issuer !== expected.issuer) return false;
  if (claims.tokenUse !== 'id') return false;
  return true;
};
