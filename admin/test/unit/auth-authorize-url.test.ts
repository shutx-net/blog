import { describe, expect, it } from 'vitest';

import { buildAuthorizeUrl, buildLogoutUrl } from '../../src/auth/authorize-url.ts';
import { AUTH_CONFIG, resolveRedirectUri } from '../../src/auth/config.ts';

const ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';
const REDIRECT_URI = `${ORIGIN}/admin/`;
const STATE = 'S'.repeat(43);
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const built = (
  overrides: Partial<{ state: string; challenge: string; redirectUri: string }> = {},
): URL =>
  new URL(
    buildAuthorizeUrl({
      config: AUTH_CONFIG,
      state: STATE,
      challenge: CHALLENGE,
      redirectUri: REDIRECT_URI,
      ...overrides,
    }),
  );

const param = (name: string, overrides = {}): string | null => built(overrides).searchParams.get(name);

/**
 * **実測した受理条件をそのまま固定する。**
 *
 * 認可サーバは寛容で、`state` が無くても `code_challenge` が無くても 302 する。
 * **禁じているのはこちら側**なので、その規律をここに書いておかないと誰も気づけない。
 */
describe('buildAuthorizeUrl のエンドポイント', () => {
  it('origin + pathname が /oauth2/authorize である', () => {
    const url = built();
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://shutx-blog-admin.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize',
    );
  });

  it('**/login ではない**（実測で /login の直叩きは 403）', () => {
    expect(built().pathname).toBe('/oauth2/authorize');
  });
});

describe('クエリパラメータ', () => {
  it('**パラメータの集合がちょうど 7 個**である（増減が見える）', () => {
    expect([...built().searchParams.keys()].sort()).toEqual([
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ]);
  });

  it('**response_type=code ちょうど**（implicit を作れない）', () => {
    // 実測でこのクライアントの implicit は unauthorized_client になり、
    // しかもエラーが**フラグメント**に返る（code フローのエラーはクエリに返る）。
    expect(param('response_type')).toBe('code');
  });

  it('**code_challenge_method=S256 ちょうど**（plain を生成する経路が無い）', () => {
    expect(param('code_challenge_method')).toBe('S256');
  });

  it('**scope=openid ちょうど**（openid email などを作れない）', () => {
    expect(param('scope')).toBe('openid');
  });

  it('client_id が config の値である', () => {
    expect(param('client_id')).toBe(AUTH_CONFIG.clientId);
  });

  it('code_challenge が渡した値と一致する', () => {
    expect(param('code_challenge')).toBe(CHALLENGE);
  });

  it('state が渡した値と一致する', () => {
    expect(param('state')).toBe(STATE);
  });

  it('**redirect_uri が CallbackURLs の実測値と 1 文字も違わない**', () => {
    expect(param('redirect_uri')).toBe('https://d8gsxbwzr6ft8.cloudfront.net/admin/');
    expect(param('redirect_uri')).toBe(resolveRedirectUri(ORIGIN));
  });

  it('値がエスケープされる（& を含む state でも壊れない）', () => {
    // URLSearchParams で組むこと。手で & を連結するとここが壊れる。
    const state = 'a&b=c d';
    expect(param('state', { state })).toBe(state);
  });
});

describe('**PKCE と state を落とす経路を作らない**', () => {
  it.each([
    ['state が空文字', { state: '' }],
    ['challenge が空文字', { challenge: '' }],
    ['redirectUri が空文字', { redirectUri: '' }],
  ])('%s なら投げる', (_label, overrides) => {
    // 実測でサーバはどちらが無くても 302 する。**強制するのはこちら側の責任。**
    // 黙って PKCE 無しのリクエストを飛ばす経路を作らない。
    expect(() => built(overrides)).toThrow();
  });

  it.each([
    ['state が undefined', 'state'],
    ['challenge が undefined', 'challenge'],
    ['redirectUri が undefined', 'redirectUri'],
  ])('%s なら投げる', (_label, key) => {
    const args: Record<string, unknown> = {
      config: AUTH_CONFIG,
      state: STATE,
      challenge: CHALLENGE,
      redirectUri: REDIRECT_URI,
    };
    delete args[key];
    expect(() =>
      buildAuthorizeUrl(args as unknown as Parameters<typeof buildAuthorizeUrl>[0]),
    ).toThrow();
  });

  it('空白だけの state / challenge も拒否する', () => {
    expect(() => built({ state: '   ' })).toThrow();
    expect(() => built({ challenge: '   ' })).toThrow();
  });

  it('**"plain" という綴りが authorize-url.ts に現れない**', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../src/auth/authorize-url.ts', import.meta.url)),
      'utf8',
    );
    // S256 以外の分岐が存在しないことを綴りで固定する。
    expect(source).not.toContain("'plain'");
    expect(source).not.toContain('"plain"');
  });
});

describe('buildLogoutUrl', () => {
  it('<domain>/logout に client_id と logout_uri を付ける', () => {
    const url = new URL(buildLogoutUrl({ config: AUTH_CONFIG, logoutUri: REDIRECT_URI }));
    expect(`${url.origin}${url.pathname}`).toBe(`${AUTH_CONFIG.loginDomain}/logout`);
    expect(url.searchParams.get('client_id')).toBe(AUTH_CONFIG.clientId);
    expect(url.searchParams.get('logout_uri')).toBe(REDIRECT_URI);
  });

  it('パラメータがちょうど 2 個', () => {
    const url = new URL(buildLogoutUrl({ config: AUTH_CONFIG, logoutUri: REDIRECT_URI }));
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'logout_uri']);
  });

  it('logout_uri が空なら投げる', () => {
    expect(() => buildLogoutUrl({ config: AUTH_CONFIG, logoutUri: '' })).toThrow();
  });
});
