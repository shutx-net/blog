import net from 'node:net';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, NonRetryableFetchError } from 'aws-jwt-verify/error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCognitoAuthorizer } from '../../src/auth/cognito.ts';
import { AUTH_HEADER } from '../../src/auth/transport.ts';
import type { ApiRequest } from '../../src/http.ts';
import {
  CLIENT_ID,
  FOREIGN_KID,
  SUBJECT,
  USERNAME,
  USER_POOL_ID,
  foreignPublicJwk,
  publicJwk,
  signIdToken,
} from '../helpers/cognito-tokens.ts';

/**
 * **本フェーズの security-critical な成果物 1/2。**
 *
 * 14 種の JWT 攻撃を **実鍵で署名したトークン**で、**本物の CognitoJwtVerifier** に
 * 通す。vi.mock で検証器を差し替えたテストはこのファイルに 1 つも無い。
 * モックすると「モックが false を返した」ことしか言えなくなり、
 * 「この攻撃はこの assertion で落ちる」という主張が全部消える。
 */

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** cacheJwks 済みの本物の verifier。ネットワークには一切出ない。 */
const realVerifier = () => {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: 'id',
    clientId: CLIENT_ID,
  });
  verifier.cacheJwks({ keys: [publicJwk] });
  return verifier;
};

interface Harness {
  authorize: (token?: string) => Promise<import('../../src/auth.ts').AuthResult>;
  log: ReturnType<typeof logger>;
  verifySpy: ReturnType<typeof vi.fn>;
  request: (token?: string) => ApiRequest;
}

const harness = (options: { allowedUsername?: string; jwks?: unknown[] } = {}): Harness => {
  const log = logger();
  const verifier = CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: 'id',
    clientId: CLIENT_ID,
  });
  verifier.cacheJwks({ keys: (options.jwks ?? [publicJwk]) as never });

  // **スパイは verify を包むだけ。差し替えない。** 呼び出し回数を数えるためだけに居る。
  const verifySpy = vi.fn((token: string) => verifier.verify(token));

  const authorizer = createCognitoAuthorizer({
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    allowedUsername: options.allowedUsername ?? USERNAME,
    verifier: { verify: verifySpy as unknown as (token: string) => Promise<Record<string, unknown>> },
    logger: log,
  });

  const request = (token?: string): ApiRequest => ({
    method: 'POST',
    path: '/api/posts',
    headers: token === undefined ? {} : { [AUTH_HEADER]: `Bearer ${token}` },
    query: {},
    rawBody: '{}',
  });

  return { authorize: (token) => authorizer.authorize(request(token)), log, verifySpy, request };
};

/** ログに渡った全引数を 1 本の文字列にする（Phase 3 の secret-in-logs 検査と同じ形）。 */
const loggedText = (log: ReturnType<typeof logger>): string =>
  JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);

describe('正常系', () => {
  it('正当な ID トークンで { ok: true, subject: sub } を返す', async () => {
    const result = await harness().authorize(signIdToken());
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.subject).toBe(SUBJECT);
  });

  it('**subject は sub であって username ではない**', async () => {
    // sub は不変で再利用されない UUID。username は運用者が付け替えうる。
    const result = await harness().authorize(signIdToken());
    expect(result.ok === true && result.subject).not.toBe(USERNAME);
  });

  it('正常系でもトークンをログに出さない', async () => {
    const h = harness();
    const token = signIdToken();
    await h.authorize(token);
    expect(loggedText(h.log)).not.toContain(token);
    expect(loggedText(h.log)).not.toContain(SUBJECT);
    expect(loggedText(h.log)).not.toContain(USERNAME);
  });
});

/**
 * **JWT 攻撃 14 種。**
 *
 * `reason` と HTTP への写り方に対してアサーションを書く（例外の型ではなく）。
 * ライブラリの例外型は版によって変わりうるし、実測で「iss 不一致」が
 * JwtInvalidIssuerError ではなく ParameterValidationError になるなど直感に反する。
 */
describe('JWT 攻撃', () => {
  it('攻撃 1: alg:none（3 パート・署名部にゴミ）を拒否する', async () => {
    // ライブラリ側は正の許可リスト ['RS256','RS384','RS512','ES256','ES384','ES512','EdDSA']
    // で弾く（JwtInvalidSignatureAlgorithmError）。ソース全体に文字列 "none" が存在しない。
    const result = await harness().authorize(signIdToken({ alg: 'none' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 2: alg:none（2 パート・署名部そのものが無い）を拒否する', async () => {
    // 攻撃 1 とは **別の経路**（JwtParseError: JWT string does not consist of exactly 3 parts）
    // で落ちる。だから 2 件に分けている。
    const result = await harness().authorize(signIdToken({ alg: 'none', parts: 2 }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 3: HS256 鍵混同（公開鍵を HMAC の共有秘密として署名）を拒否する', async () => {
    // 許可リストに HMAC 系が 1 つも無いので、**公開鍵を共有秘密として扱うコードパスが
    // 構造的に存在しない**。
    const result = await harness().authorize(signIdToken({ alg: 'HS256' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 4: 別プールの鍵で署名（kid は正規のものに偽装）を拒否する', async () => {
    // kid が一致するので鍵選択は通り、**署名検証だけが落ちる**（JwtInvalidSignatureError）。
    const result = await harness().authorize(signIdToken({ key: 'foreign' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 5: 別プールの issuer を拒否する', async () => {
    const result = await harness().authorize(
      signIdToken({
        claims: { iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_OTHER' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 6: token_use が access（id を要求している）を拒否する', async () => {
    // access トークンは aud ではなく client_id を持つので、取り違えると audience 検査が
    // 素通りしうる。ここを固定するのが本質。
    const result = await harness().authorize(signIdToken({ claims: { token_use: 'access' } }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 7: token_use 欠落を拒否する', async () => {
    // ライブラリは tokenUse: null を明示しない限り **無条件に** 検査する。
    const result = await harness().authorize(signIdToken({ claims: { token_use: undefined } }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 8: aud が別のアプリクライアント ID を拒否する', async () => {
    const result = await harness().authorize(signIdToken({ claims: { aud: 'other-client-id' } }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 9: 期限切れ（exp が過去）を拒否する', async () => {
    const result = await harness().authorize(
      signIdToken({ nowSeconds: Math.floor(Date.now() / 1000) - 7200 }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 10: 正当な署名だが別ユーザを拒否する（**落とすのは自分たちのコード**）', async () => {
    // ライブラリは通す。単一著者プールの核心はここ。
    const result = await harness().authorize(
      signIdToken({ claims: { 'cognito:username': 'someone-else' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-authorized');
  });

  it('攻撃 10 の裏: **この 1 件だけ reason が invalid-token ではない**', async () => {
    const result = await harness().authorize(
      signIdToken({ claims: { 'cognito:username': 'someone-else' } }),
    );
    expect(result.ok === false && result.reason).not.toBe('invalid-token');
  });

  it('攻撃 11: ペイロード改竄（署名はそのまま）を拒否する', async () => {
    const token = signIdToken();
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    claims['cognito:username'] = 'attacker';
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    const result = await harness().authorize(forged);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });

  it('攻撃 12: cognito:username 欠落を拒否する（undefined が偶然一致しない）', async () => {
    const result = await harness().authorize(
      signIdToken({ claims: { 'cognito:username': undefined } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-authorized');
  });

  it('攻撃 12 の裏: allowedUsername が空文字でも通らない', async () => {
    // config が空を弾くが、二重化する。「undefined === ''」も「'' === ''」も通さない。
    const missing = await harness({ allowedUsername: '' }).authorize(
      signIdToken({ claims: { 'cognito:username': undefined } }),
    );
    expect(missing.ok).toBe(false);

    const empty = await harness({ allowedUsername: '' }).authorize(
      signIdToken({ claims: { 'cognito:username': '' } }),
    );
    expect(empty.ok).toBe(false);

    // 正当なユーザ名のトークンでも、allowedUsername が空なら通らない。
    const valid = await harness({ allowedUsername: '' }).authorize(signIdToken());
    expect(valid.ok).toBe(false);
  });

  it('攻撃 13: sub 欠落を拒否する（subject を返せないトークンを通さない）', async () => {
    const result = await harness().authorize(signIdToken({ claims: { sub: undefined } }));
    expect(result.ok).toBe(false);
  });

  it('攻撃 14: ヘッダ欠落は unauthenticated で、**verify を 1 度も呼ばない**', async () => {
    // トークンが無いのに検証器を叩くと、JWKS 取得を誘発できる無認証の踏み台になる。
    const h = harness();
    const result = await h.authorize();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unauthenticated');
    expect(h.verifySpy).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['Basic abc.def.ghi', 'スキームが違う'],
    ['abc.def.ghi', 'スキーム無し'],
    ['Bearer', 'トークン部が無い'],
    ['Bearer ', 'トークン部が空'],
  ])('攻撃 14 の裏: %o も unauthenticated で verify を呼ばない（%s）', async (value) => {
    const log = logger();
    const verifier = realVerifier();
    const verifySpy = vi.fn((token: string) => verifier.verify(token));
    const authorizer = createCognitoAuthorizer({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      allowedUsername: USERNAME,
      verifier: { verify: verifySpy as unknown as (t: string) => Promise<Record<string, unknown>> },
      logger: log,
    });
    const result = await authorizer.authorize({
      method: 'POST',
      path: '/api/posts',
      headers: { [AUTH_HEADER]: value },
      query: {},
      rawBody: '{}',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unauthenticated');
    expect(verifySpy).toHaveBeenCalledTimes(0);
  });

  it('標準の authorization ヘッダにトークンを入れても unauthenticated', async () => {
    // 専用ヘッダしか見ない（transport.ts の契約）。CloudFront が上書きする以上、
    // 標準ヘッダに入っているのは OAC の SigV4 署名文字列である。
    const authorizer = createCognitoAuthorizer({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      allowedUsername: USERNAME,
      verifier: realVerifier(),
      logger: logger(),
    });
    const out = await authorizer.authorize({
      method: 'POST',
      path: '/api/posts',
      headers: { authorization: `Bearer ${signIdToken()}` },
      query: {},
      rawBody: '{}',
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('unauthenticated');
  });
});

describe('ライブラリの例外の判別方法（分岐の根拠を固定する）', () => {
  it('**例外クラスは name を設定しない** — name で分岐すると全部 invalid-token に落ちる', () => {
    // 実測（aws-jwt-verify 5.2.1）: error.js に this.name の代入が 1 箇所も無い。
    // つまり FetchError でも .name は 'Error' のままである。
    // ここを name で分岐すると **JWKS 取得失敗が全部 401 になり、サーバ側の障害を
    // 「資格情報を出し直せ」と誤って伝える。**
    const error = new FetchError('https://example.invalid/jwks.json', 'boom');
    expect(error.name).toBe('Error');
    expect(error.name).not.toBe('FetchError');
  });

  it('instanceof なら判別できる（minify を通しても壊れない唯一の手段）', () => {
    // constructor.name は esbuild の --minify でクラス名が潰れるため使えない。
    // テスト（非 minify）では通り **本番だけが壊れる**という最悪の失敗の仕方になる。
    expect(new FetchError('https://example.invalid/', 'boom')).toBeInstanceOf(FetchError);
    expect(new NonRetryableFetchError('https://example.invalid/', 'boom')).toBeInstanceOf(FetchError);
  });
});

describe('JWKS が取得できないとき', () => {
  const originalConnect = net.Socket.prototype.connect;

  beforeEach(() => {
    // **本物のネットワーク障害と同じ形で失敗させる。** 同期 throw では
    // https.request の Promise executor から素の Error が漏れてしまい、
    // ライブラリが FetchError に包む経路（req.on('error', done)）を通らない。
    // 実測でこの違いが出たので、忠実な非同期エラーにしてある。
    net.Socket.prototype.connect = function (this: net.Socket) {
      process.nextTick(() => this.destroy(new Error('ECONNREFUSED_SIMULATED')));
      return this;
    } as unknown as typeof net.Socket.prototype.connect;
  });

  afterEach(() => {
    net.Socket.prototype.connect = originalConnect;
  });

  it('kid が未知でネットワークが塞がっているとき unavailable を返す', async () => {
    // **invalid-token にしない。** サーバ側の問題を「資格情報を出し直せ」と伝えるのは誤り。
    // JWKS には foreign の鍵だけを入れておくので、正規の kid が見つからず取りに行く。
    const result = await harness({ jwks: [foreignPublicJwk] }).authorize(signIdToken());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unavailable');
  });

  it('unavailable は invalid-token でも not-authorized でもない', async () => {
    const result = await harness({ jwks: [foreignPublicJwk] }).authorize(signIdToken());
    expect(result.ok === false && result.reason).not.toBe('invalid-token');
    expect(result.ok === false && result.reason).not.toBe('not-authorized');
  });

  it('未知の kid は JWKS 再取得を誘発し、取得できなければ unavailable', async () => {
    // 鍵ローテーション直後の正規トークンと、攻撃者のでっち上げた kid は
    // **この時点では区別できない**。取得できていない以上 401 と言い切れないので 503。
    const result = await harness().authorize(signIdToken({ header: { kid: FOREIGN_KID } }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unavailable');
  });

  it('ネットワークが塞がっていても、**署名が正しくないトークンは invalid-token のまま**', async () => {
    // kid はキャッシュに有るので JWKS を取りに行かない。取得失敗に紛れて
    // 攻撃が 503 に化けることが無いことを固定する。
    const result = await harness().authorize(signIdToken({ key: 'foreign' }));
    expect(result.ok === false && result.reason).toBe('invalid-token');
  });
});

describe('拒否時の不変条件', () => {
  /** 全拒否ケースをここに集約して走査する。**理由を足したらこの表に足すこと。** */
  const rejections: [string, () => string | undefined][] = [
    ['alg:none 3 パート', () => signIdToken({ alg: 'none' })],
    ['alg:none 2 パート', () => signIdToken({ alg: 'none', parts: 2 })],
    ['HS256 鍵混同', () => signIdToken({ alg: 'HS256' })],
    ['別プールの鍵', () => signIdToken({ key: 'foreign' })],
    ['別プールの issuer', () => signIdToken({ claims: { iss: 'https://example.invalid/x' } })],
    ['token_use=access', () => signIdToken({ claims: { token_use: 'access' } })],
    ['token_use 欠落', () => signIdToken({ claims: { token_use: undefined } })],
    ['aud 不一致', () => signIdToken({ claims: { aud: 'other' } })],
    ['期限切れ', () => signIdToken({ nowSeconds: Math.floor(Date.now() / 1000) - 7200 })],
    ['別ユーザ', () => signIdToken({ claims: { 'cognito:username': 'someone-else' } })],
    ['username 欠落', () => signIdToken({ claims: { 'cognito:username': undefined } })],
    ['sub 欠落', () => signIdToken({ claims: { sub: undefined } })],
    ['ヘッダ欠落', () => undefined],
    ['ゴミ文字列', () => 'not-a-jwt'],
  ];

  it.each(rejections)('%s: 拒否され、ok が false である', async (_name, make) => {
    const result = await harness().authorize(make());
    expect(result.ok).toBe(false);
  });

  it.each(rejections)(
    '%s: ログにトークン・cognito:username・sub が 1 つも現れない',
    async (_name, make) => {
      const h = harness();
      const token = make();
      await h.authorize(token);
      const text = loggedText(h.log);
      if (token !== undefined) expect(text).not.toContain(token);
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain(SUBJECT);
      expect(text).not.toContain('someone-else');
      expect(text).not.toContain('attacker');
    },
  );

  it.each(rejections)('%s: subject を返さない', async (_name, make) => {
    const result = await harness().authorize(make());
    expect(result).not.toHaveProperty('subject');
  });
});
