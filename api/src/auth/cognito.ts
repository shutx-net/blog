import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  FetchError,
  JwkValidationError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import type { AuthResult, Authorizer } from '../auth.ts';
import type { Logger } from '../deps.ts';
import type { ApiRequest } from '../http.ts';
import { extractBearerToken } from './transport.ts';

/**
 * verifier の最小契約。**具象型ではなくこの形に依存する。**
 *
 * aws-jwt-verify が将来放棄されたとき（撤退条件: 12 ヶ月リリース無し / archived /
 * deprecated）に差し替えられるようにしてある。テストは cacheJwks 済みの
 * **本物の** verifier をここに注入する（モックしない）。
 */
export interface TokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface CognitoAuthorizerOptions {
  userPoolId: string;
  clientId: string;
  /** 通す唯一の cognito:username。**完全一致・大文字小文字を区別する。** */
  allowedUsername: string;
  /** 省略時は userPoolId / clientId から本物を作る。テストは cacheJwks 済みを注入する。 */
  verifier?: TokenVerifier;
  logger: Logger;
}

/**
 * JWKS が取れなかった系だけを `unavailable`（503）に振り分け、それ以外の例外は全部
 * `invalid-token`（401）に倒す（fail-closed）。
 *
 * 分岐を 1 段に留めるのは意図的。ライブラリの例外型は版によって変わりうるし、実測で
 * 「iss 不一致」が JwtInvalidIssuerError ではなく `ParameterValidationError: issuer not
 * configured` になるなど直感に反する（単一プールでも issuer 設定が 2 つあるため）。
 *
 * **`error.name` で分岐してはいけない。** aws-jwt-verify 5.2.1 の例外クラスは `this.name` を
 * 1 箇所も設定しておらず、`FetchError` でも `.name` は `'Error'` のまま（実測）。名前で分岐
 * すると JWKS 取得失敗が 1 件残らず 401 になり、サーバ側の障害を「資格情報を出し直せ」と
 * 誤って伝える。**`constructor.name` でも分岐してはいけない** — バンドルは esbuild の
 * `--minify` を通るのでクラス名が潰れ、テスト（非 minify）では通って**本番だけが壊れる**。
 *
 * `NonRetryableFetchError` は `FetchError` を継承しているのでこの表に要らない。
 */
const isJwksUnavailable = (error: unknown): boolean =>
  error instanceof FetchError ||
  error instanceof JwksNotAvailableInCacheError ||
  error instanceof WaitPeriodNotYetEndedJwkError ||
  error instanceof JwksValidationError ||
  error instanceof JwkValidationError;

/**
 * 本物の verifier を作る。`tokenUse: 'id'` は省略すると ParameterValidationError で落ちる
 * 仕様なので、書き忘れが黙って通ることはない。
 *
 * **`hydrate()` は呼ばない。** 理由 2 つ。
 * (1) 実測で単一プールでも issuer 設定が 2 つあり（multi-Region replication 対応の
 *     `issuer-cognito-idp.<region>.amazonaws.com` を含む）、hydrate() は両方に取りに行く。
 *     非レプリケーション構成では 200 が返らず、Promise.allSettled で握り潰されるとはいえ
 *     response timeout までコールドスタートが伸びうる。
 * (2) モジュールスコープで throw すると Lambda の初期化が落ち CloudFront には 502 が返る。
 *     **一時的な JWKS 取得失敗で API 全体が 502 になるより、その 1 リクエストだけ 503 が良い。**
 * 代わりに遅延取得に任せる。verify() は kid がキャッシュに有ればフェッチしない。
 */
const createRealVerifier = (userPoolId: string, clientId: string): TokenVerifier =>
  CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId }) as unknown as TokenVerifier;

/**
 * Cognito の ID トークンを検証する Authorizer。
 *
 * iss / aud / token_use / exp / 署名（pool の JWKS）はライブラリが見る。
 * **cognito:username が設定値と完全一致するかは自分たちで見る** — ライブラリは「このプールの、
 * このアプリクライアントの、有効な ID トークン」までしか保証せず、単一著者プールの核心は
 * その先にある。
 *
 * **verifier はモジュールスコープで 1 度だけ作ること**（index.ts がそうしている）。JWKS も
 * KeyObject のキャッシュも verifier インスタンスに乗っているので、ハンドラ内で作ると
 * 毎リクエスト JWKS を取りに行く。
 */
export const createCognitoAuthorizer = ({
  userPoolId,
  clientId,
  allowedUsername,
  verifier = createRealVerifier(userPoolId, clientId),
  logger,
}: CognitoAuthorizerOptions): Authorizer => ({
  authorize: async (request: ApiRequest): Promise<AuthResult> => {
    const token = extractBearerToken(request.headers);
    if (token === undefined) {
      // **トークンが無いときに verifier を叩かない。** 叩くと JWKS 取得を誘発できる
      // 無認証の踏み台になる。ログにも何も出さない（誰でも到達できる経路なので）。
      return { ok: false, reason: 'unauthenticated' };
    }

    let claims: Record<string, unknown>;
    try {
      claims = await verifier.verify(token);
    } catch (error) {
      if (isJwksUnavailable(error)) {
        // サーバ側の問題を「資格情報を出し直せ」と伝えるのは誤りなので 401 にしない。
        logger.warn('cognito jwks unavailable');
        return { ok: false, reason: 'unavailable' };
      }
      // **例外の中身をログに出さない。** メッセージにはトークンや URI の断片が入りうる
      // （実測: FetchError のメッセージは JWKS の URI をそのまま含む）。
      logger.warn('cognito token rejected');
      return { ok: false, reason: 'invalid-token' };
    }

    // **allowedUsername が空なら常に拒否する。** config が空を弾くが二重化する。
    // これが無いと「username 欠落のトークン」と「空の設定」が偶然一致しうる。
    if (allowedUsername.length === 0) {
      logger.error('COGNITO_ALLOWED_USERNAME is empty');
      return { ok: false, reason: 'not-authorized' };
    }

    const username = claims['cognito:username'];
    // 完全一致・大文字小文字を区別する。プール側を signInCaseSensitive: true に
    // してあるので、API 側で正規化すると **プールより緩くなる**。
    if (typeof username !== 'string' || username !== allowedUsername) {
      // username そのものはログに出さない（誰が試したかは CloudFront のログ側の仕事）。
      logger.warn('cognito username is not the allowed author');
      return { ok: false, reason: 'not-authorized' };
    }

    const subject = claims['sub'];
    if (typeof subject !== 'string' || subject.length === 0) {
      // subject を返せないトークンは通さない。ここを通すと監査の主体が消える。
      logger.warn('cognito token has no sub claim');
      return { ok: false, reason: 'invalid-token' };
    }

    return { ok: true, subject };
  },
});
