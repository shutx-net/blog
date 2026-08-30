import { createSign } from 'node:crypto';

/**
 * GitHub App の JWT の最大寿命（秒）。
 *
 * docs.github.com: "The time must be no more than 10 minutes into the future."
 * これを超えると GitHub は 401 を返す。
 */
export const JWT_MAX_LIFETIME_SECONDS = 600;

/**
 * 時計ずれ対策で iat を過去にずらす秒数。
 *
 * docs.github.com: "To protect against clock drift, we recommend that you set
 * this 60 seconds in the past."
 */
const CLOCK_DRIFT_SECONDS = 60;

/**
 * 有効期限。iat から数えて上限 600 秒に収まるよう、now からは 540 秒に置く。
 * こうすると exp - iat も exp - now も 600 を超えない。
 */
const EXPIRY_SECONDS = JWT_MAX_LIFETIME_SECONDS - CLOCK_DRIFT_SECONDS;

export interface AppJwtInput {
  /** GitHub が配る PKCS#1、または運用者が変換した PKCS#8。**どちらもそのまま使える。** */
  privateKeyPem: string;
  /** GitHub App の client ID（推奨）か app ID。**秘密ではない。** */
  issuer: string;
  /** 注入するクロック（秒）。関数内で Date.now() を読むと時計依存のテストになる。 */
  nowSeconds: number;
}

const b64url = (value: string | Buffer): string =>
  Buffer.isBuffer(value)
    ? value.toString('base64url')
    : Buffer.from(value, 'utf8').toString('base64url');

/**
 * GitHub App の認証用 JWT を RS256 で署名する。
 *
 * **外部の JWT ライブラリを使わない。** 実測で jose@6 の importPKCS8 は GitHub が配る
 * PKCS#1 PEM を TypeError で拒否する。node:crypto の createSign('RSA-SHA256') は
 * PKCS#1 も PKCS#8 もそのまま受け取る（test/unit/github-jwt.test.ts が実鍵で確認）。
 * 運用者に openssl pkcs8 -topk8 の変換を強いる理由がない。
 *
 * **戻り値を絶対にログに出さないこと。** 10 分間有効な App 資格情報そのものである。
 */
export const createAppJwt = ({ privateKeyPem, issuer, nowSeconds }: AppJwtInput): string => {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iat: nowSeconds - CLOCK_DRIFT_SECONDS,
      exp: nowSeconds + EXPIRY_SECONDS,
      iss: issuer,
    }),
  );
  const signingInput = `${header}.${payload}`;

  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  } catch (error) {
    // **元の例外を伝播させない。** node:crypto の PEM パースエラーは実装によっては
    // 入力の一部をメッセージに含みうる。例外はログに載る前提で、鍵は 1 バイトも出さない。
    throw new Error(`failed to sign GitHub App JWT (${(error as Error).name})`);
  }

  return `${signingInput}.${b64url(signature)}`;
};
