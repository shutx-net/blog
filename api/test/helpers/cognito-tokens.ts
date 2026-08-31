import { createHmac, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

/**
 * **実鍵で Cognito 形式の ID トークンを署名するテストハーネス。**
 *
 * 検証器（aws-jwt-verify の CognitoJwtVerifier）を **モックしない** ための道具である。
 * Phase 3 の教訓: 検証器をモックすると、テストは「モックが false を返した」ことしか
 * 言わなくなり、本フェーズで一番価値のある主張（この攻撃はこの assertion で落ちる）が
 * 全部消える。
 *
 * node:crypto だけで書いてある（Phase 3 の api/src/github/jwt.ts と同じ手口）。
 * 実測: publicKey.export({ format: 'jwk' }) は kty / n / e を返し、
 * createPublicKey({ key: jwk, format: 'jwk' }) で戻した鍵で
 * createVerify('RSA-SHA256') が true を返す（node v24.19.0）。
 */

/** ap-northeast-1 の実在しないプール ID。形式だけ本物に合わせる。 */
export const USER_POOL_ID = 'ap-northeast-1_TESTPOOL1';
export const REGION = 'ap-northeast-1';
export const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
export const CLIENT_ID = '1example23456789testclientid';
export const USERNAME = 'shutx';
export const SUBJECT = '11111111-2222-4333-8444-555555555555';

/** 正規のプールの鍵 ID。 */
export const KID = 'test-key-1';
/** 別プール（攻撃者側）の鍵 ID。 */
export const FOREIGN_KID = 'foreign-key-1';

/**
 * **鍵対はモジュールスコープで 1 度だけ生成する。**
 * 2048bit の生成は 100〜500ms かかるので、it ごとに作ると積み上がったときに効いてくる。
 */
const primary = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });

/**
 * 公開 JWK。**インデックスシグネチャを持たせてある** — aws-jwt-verify の `Jwk` は
 * `JsonObject`（インデックスシグネチャあり）との交差型なので、素の interface のままだと
 * `cacheJwks()` に渡せない。
 */
export interface PublicJwk {
  kty: string;
  n: string;
  e: string;
  kid: string;
  alg: string;
  use: string;
  [key: string]: string;
}

const toJwk = (key: typeof primary.publicKey, kid: string): PublicJwk => ({
  ...(key.export({ format: 'jwk' }) as { kty: string; n: string; e: string }),
  kid,
  alg: 'RS256',
  use: 'sig',
});

/** verifier.cacheJwks({ keys: [publicJwk] }) に流し込む正規の公開鍵。 */
export const publicJwk: PublicJwk = toJwk(primary.publicKey, KID);
/** 「別プールの鍵」を表す公開鍵。**正規の JWKS には入れない。** */
export const foreignPublicJwk: PublicJwk = toJwk(foreign.publicKey, FOREIGN_KID);

const b64url = (value: string | Buffer): string =>
  Buffer.isBuffer(value)
    ? value.toString('base64url')
    : Buffer.from(value, 'utf8').toString('base64url');

/** どちらの鍵で署名するか。'foreign' は「別プールの鍵で署名されたトークン」を作る。 */
export type KeyChoice = 'primary' | 'foreign';

export interface SignRawInput {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  key?: KeyChoice;
  /** 3 なら通常の JWT、2 なら署名部そのものが無い（alg:none の 2 パート版）。 */
  parts?: 2 | 3;
}

/**
 * ヘッダとペイロードを **そのまま** 署名する低レベル API。
 *
 * alg の値と実際の署名方法を独立に選べる（alg: 'none' でも RS256 の署名を付けられる）。
 * これがあることで「alg を詐称したトークン」が作れる。
 */
export const signRaw = ({ header, payload, key = 'primary', parts = 3 }: SignRawInput): string => {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (parts === 2) return signingInput;

  const alg = header['alg'];
  const pair = key === 'foreign' ? foreign : primary;

  if (alg === 'HS256') {
    // **鍵混同攻撃**: 公開鍵のバイト列を HMAC の共有秘密として使う。
    // 検証側が「alg を信じて」HMAC 検証に入ると、公開情報だけでトークンを偽造できる。
    const secret = pair.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    return `${signingInput}.${b64url(createHmac('sha256', secret).update(signingInput).digest())}`;
  }

  if (alg === 'none') {
    // 署名部にはゴミを入れる（3 パート構造は保つ）。
    return `${signingInput}.${b64url('not-a-signature')}`;
  }

  return `${signingInput}.${b64url(createSign('RSA-SHA256').update(signingInput).sign(pair.privateKey))}`;
};

export interface SignIdTokenInput {
  /** 上書きするクレーム。値に undefined を渡すとそのクレームは **削除** される。 */
  claims?: Record<string, unknown>;
  /** ヘッダの上書き（kid の詐称などに使う）。 */
  header?: Record<string, unknown>;
  /** 'RS256'（既定）/ 'none' / 'HS256'。 */
  alg?: string;
  key?: KeyChoice;
  parts?: 2 | 3;
  /** 基準時刻（秒）。既定は現在時刻。 */
  nowSeconds?: number;
}

/**
 * Cognito の ID トークンと同じ形のトークンを署名する。
 *
 * 既定は **正常系**（iss / aud / token_use='id' / exp 未来 / 署名正当 /
 * cognito:username が USERNAME）。攻撃ケースは claims を 1 つだけ壊して作る。
 */
export const signIdToken = ({
  claims = {},
  header = {},
  alg = 'RS256',
  key = 'primary',
  parts = 3,
  nowSeconds = Math.floor(Date.now() / 1000),
}: SignIdTokenInput = {}): string => {
  const payload: Record<string, unknown> = {
    sub: SUBJECT,
    'cognito:username': USERNAME,
    aud: CLIENT_ID,
    iss: ISSUER,
    token_use: 'id',
    auth_time: nowSeconds,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    // 実物の ID トークンに載る雑多なクレーム。検証には使わないが形を寄せておく。
    event_id: randomUUID(),
    jti: randomUUID(),
    origin_jti: randomUUID(),
  };

  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete payload[name];
    else payload[name] = value;
  }

  return signRaw({
    header: { alg, kid: KID, typ: 'JWT', ...header },
    payload,
    key,
    parts,
  });
};
