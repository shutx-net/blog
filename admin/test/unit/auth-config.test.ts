import { describe, expect, it } from 'vitest';

import {
  AUTHORIZE_PATH,
  AUTH_CONFIG,
  LOGOUT_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  resolveRedirectUri,
} from '../../src/auth/config.ts';

/**
 * **値の「形」を固定して、コピペ事故で壊れる経路を落とす。**
 *
 * 末尾スラッシュが二重になる、リージョンがずれる、クライアント ID が 1 文字欠ける —
 * どれも実行時には `redirect_mismatch` や 404 になるだけで、原因が読み取れない。
 * 実配信の設定との突き合わせは `scripts/auth-smoke.ts` の仕事（ネットワークが要る）。
 */
describe('auth/config.ts の値の形', () => {
  it('clientId が 26 文字の英小文字・数字である', () => {
    expect(AUTH_CONFIG.clientId).toMatch(/^[a-z0-9]{26}$/);
  });

  it('loginDomain が https:// で始まり、**末尾スラッシュを持たない**', () => {
    // 末尾スラッシュがあると `${loginDomain}${AUTHORIZE_PATH}` が `//oauth2/...` になる。
    expect(AUTH_CONFIG.loginDomain.startsWith('https://')).toBe(true);
    expect(AUTH_CONFIG.loginDomain.endsWith('/')).toBe(false);
  });

  it('loginDomain が Managed Login のドメイン形である', () => {
    expect(AUTH_CONFIG.loginDomain).toMatch(
      /^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/,
    );
  });

  it('issuer が https://cognito-idp.<region>.amazonaws.com/<poolId> の形である', () => {
    expect(AUTH_CONFIG.issuer).toMatch(
      /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/,
    );
    expect(AUTH_CONFIG.issuer.endsWith('/')).toBe(false);
  });

  it('loginDomain と issuer のリージョンが一致する', () => {
    // ここがずれると authorize は通るのに api 側の iss 検証で落ちる。
    const domainRegion = /\.auth\.([a-z0-9-]+)\.amazoncognito\.com$/.exec(AUTH_CONFIG.loginDomain);
    const issuerRegion = /^https:\/\/cognito-idp\.([a-z0-9-]+)\./.exec(AUTH_CONFIG.issuer);
    expect(domainRegion?.[1]).toBeDefined();
    expect(domainRegion?.[1]).toBe(issuerRegion?.[1]);
  });

  it('**scope が "openid" ちょうど**である', () => {
    // 実測で `openid email` は invalid_scope になる（AllowedOAuthScopes が ['openid']）。
    expect(AUTH_CONFIG.scope).toBe('openid');
  });

  it('adminPath が "/admin/" である（末尾スラッシュ込み）', () => {
    expect(AUTH_CONFIG.adminPath).toBe('/admin/');
  });

  it.each([
    ['AUTHORIZE_PATH', AUTHORIZE_PATH, '/oauth2/authorize'],
    ['TOKEN_PATH', TOKEN_PATH, '/oauth2/token'],
    ['REVOKE_PATH', REVOKE_PATH, '/oauth2/revoke'],
    ['LOGOUT_PATH', LOGOUT_PATH, '/logout'],
  ])('%s が %s である', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('**入口は /oauth2/authorize であって /login ではない**', () => {
    // 実測で /login の直叩きは 403 を返す（本文はサインイン HTML）。
    expect(AUTHORIZE_PATH).not.toBe('/login');
  });
});

describe('設定ドリフトの smoke が実在し、呼べる', () => {
  it('scripts/auth-smoke.ts が実在する', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    expect(
      existsSync(fileURLToPath(new URL('../../scripts/auth-smoke.ts', import.meta.url))),
    ).toBe(true);
  });

  it('**package.json の scripts から呼べる**（未登録だと「走らせていないのに緑」になる）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['auth-smoke']).toBe('node scripts/auth-smoke.ts');
  });

  it('**npm test には入っていない**（ネットワークに依存するため）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['test']).not.toContain('auth-smoke');
    expect(pkg.scripts?.['pretest']).not.toContain('auth-smoke');
  });
});

describe('**秘密をこのリポジトリに置かない**（public client）', () => {
  it('config に secret に相当するキーが 1 つも無い', () => {
    const suspicious = Object.keys(AUTH_CONFIG).filter((key) => /secret|password|key$/i.test(key));
    expect(suspicious).toEqual([]);
  });

  it('config の値のどれにも "secret" の綴りが無い', () => {
    expect(JSON.stringify(AUTH_CONFIG).toLowerCase()).not.toContain('secret');
  });

  it('**型にも client_secret に相当するフィールドが存在しない**', () => {
    // @ts-expect-error public client にクライアントシークレットは存在しない
    const secret: unknown = AUTH_CONFIG.clientSecret;
    expect(secret).toBeUndefined();
  });
});

describe('resolveRedirectUri — **オリジンから導出する**', () => {
  it('実配信のオリジンから CallbackURLs の実測値ちょうどを作る', () => {
    // **1 文字も違ってはいけない。** 実測で不一致は redirect_mismatch になる。
    expect(resolveRedirectUri('https://d8gsxbwzr6ft8.cloudfront.net')).toBe(
      'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
    );
  });

  it('末尾スラッシュ付きのオリジンを渡しても二重にならない', () => {
    expect(resolveRedirectUri('https://d8gsxbwzr6ft8.cloudfront.net/')).toBe(
      'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
    );
  });

  it('ローカル開発のオリジンでも導出できる（Cognito 側が拒否するのは正しい失敗）', () => {
    // CallbackURLs に入っていないので実測で redirect_mismatch になる。
    // **それは正しい失敗**であり、infra 側の hand-off（DEVELOPERS.md）。
    expect(resolveRedirectUri('http://localhost:5173')).toBe('http://localhost:5173/admin/');
  });

  it('**定数に焼いていない**（別のオリジンを渡せば別の値になる）', () => {
    // 独自ドメインに移っても admin の定数を書き換えずに済む。
    expect(resolveRedirectUri('https://blog.example.com')).toBe('https://blog.example.com/admin/');
  });

  it('パス付きのオリジンを渡しても /admin/ に正規化される', () => {
    expect(resolveRedirectUri('https://d8gsxbwzr6ft8.cloudfront.net/somewhere/else')).toBe(
      'https://d8gsxbwzr6ft8.cloudfront.net/admin/',
    );
  });
});
