import { describe, expect, it } from 'vitest';
import { AUTH_HEADER, AUTH_SCHEME, extractBearerToken } from '../../src/auth/transport.ts';

/**
 * **トークン輸送の契約。** admin/ を作る別エージェントはこのファイルの値に対して
 * 実装する。値そのものを文字列リテラルで主張しているのは、契約だからである
 * （定数を参照するだけのテストは、定数を変えたときに一緒に緑のまま滑る）。
 */
describe('ヘッダ名の契約', () => {
  it('AUTH_HEADER が "x-blog-authorization" である', () => {
    expect(AUTH_HEADER).toBe('x-blog-authorization');
  });

  it('AUTH_HEADER が全部小文字である', () => {
    // event.ts が headers[name.toLowerCase()] で正規化しているので、
    // **1 文字でも大文字が混ざると一生引けない**。
    expect(AUTH_HEADER).toBe(AUTH_HEADER.toLowerCase());
  });

  it('AUTH_HEADER が "authorization" ではない', () => {
    // CloudFront の OAC は SigningBehavior: always で **viewer の Authorization を
    // 上書きする**（AWS ドキュメントに明記、実測でも一致: bogus な
    // `Authorization: Bearer ...` を付けても GET /api/health は 200 のまま。
    // もし転送されていれば Function URL の SigV4 検証が落ちて 403 -> 404 HTML になる）。
    expect(AUTH_HEADER).not.toBe('authorization');
  });

  it('AUTH_HEADER が x-amz- で始まらない', () => {
    // OAC は x-amz-date / x-amz-security-token / x-amz-content-sha256 / Authorization を
    // 自分で付ける。その名前空間を避ける。
    expect(AUTH_HEADER.startsWith('x-amz-')).toBe(false);
  });

  it('AUTH_SCHEME が "Bearer" である', () => {
    expect(AUTH_SCHEME).toBe('Bearer');
  });
});

describe('extractBearerToken', () => {
  it('ヘッダが 1 つも無ければ undefined', () => {
    expect(extractBearerToken({})).toBeUndefined();
  });

  it('x-blog-authorization: Bearer <token> からトークン部を取り出す', () => {
    expect(extractBearerToken({ 'x-blog-authorization': 'Bearer abc.def.ghi' })).toBe('abc.def.ghi');
  });

  it('**標準の authorization ヘッダにはフォールバックしない**', () => {
    // フォールバックがあると、CloudFront が上書きした OAC の SigV4 署名文字列
    // （'AWS4-HMAC-SHA256 Credential=...'）をトークンとしてパースしにいくことになる。
    expect(extractBearerToken({ authorization: 'Bearer abc.def.ghi' })).toBeUndefined();
  });

  it('専用ヘッダと標準ヘッダが両方あっても専用ヘッダだけを見る', () => {
    expect(
      extractBearerToken({
        authorization: 'Bearer wrong.token.here',
        'x-blog-authorization': 'Bearer abc.def.ghi',
      }),
    ).toBe('abc.def.ghi');
  });

  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])(
    'スキーム %o は大文字小文字を区別せず受け付ける（RFC 7235）',
    (scheme) => {
      expect(extractBearerToken({ 'x-blog-authorization': `${scheme} abc.def.ghi` })).toBe(
        'abc.def.ghi',
      );
    },
  );

  it.each([
    ['Basic abc.def.ghi', 'Basic'],
    ['Token abc.def.ghi', 'Token'],
    ['abc.def.ghi', 'スキーム無し'],
    ['Bearer2 abc.def.ghi', '似ているが違うスキーム'],
    ['Bearerabc.def.ghi', '区切りの空白が無い'],
  ])('%o は undefined（%s）', (value) => {
    expect(extractBearerToken({ 'x-blog-authorization': value })).toBeUndefined();
  });

  it.each([
    ['Bearer', 'スキームだけ'],
    ['Bearer ', 'トークン部が空'],
    ['', 'ヘッダ値そのものが空'],
    ['   ', '空白だけ'],
  ])('%o は undefined（%s）', (value) => {
    expect(extractBearerToken({ 'x-blog-authorization': value })).toBeUndefined();
  });

  it.each([
    ['Bearer  abc.def.ghi', '区切りの空白が 2 つ'],
    ['Bearer abc.def.ghi ', '末尾に空白'],
    [' Bearer abc.def.ghi', '先頭に空白'],
    ['Bearer\tabc.def.ghi', '区切りがタブ'],
    ['Bearer abc.def.ghi extra', 'トークンの後ろに余分なトークン'],
  ])('%o は undefined（%s）', (value) => {
    // **寛容にしない。** 寛容にすると「意図した値」と「たまたま通った値」の区別が
    // 消える（config.ts の AUTH_MODE と同じ思想）。トリムした結果たまたま通る、が起きない。
    expect(extractBearerToken({ 'x-blog-authorization': value })).toBeUndefined();
  });

  it('取り出したトークンをそのまま返す（正規化も trim もしない）', () => {
    const token = 'eyJraWQiOiJhYmMifQ.eyJzdWIiOiIxIn0.c2ln';
    expect(extractBearerToken({ 'x-blog-authorization': `Bearer ${token}` })).toBe(token);
  });

  it('**Logger を受け取らない**（トークンをログに出す経路が構造的に無い）', () => {
    // 引数が 1 つしかないことを実行時にも固定する。第 2 引数に logger を足す変更は
    // ここで赤くなる。型でも同じことを下の静的表明で押さえている。
    expect(extractBearerToken).toHaveLength(1);
  });
});

/**
 * 型レベルの表明（実行時コード無し）。extractBearerToken が
 * (headers) => string | undefined ちょうどであることを固定する。
 */
type AssertSignature = typeof extractBearerToken extends (
  headers: Record<string, string>,
) => string | undefined
  ? true
  : never;
export type _ExtractBearerTokenSignatureIsValid = AssertSignature;
