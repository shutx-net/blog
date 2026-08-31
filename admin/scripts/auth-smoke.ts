/**
 * 実配信の認可サーバと `src/auth/config.ts` の突き合わせ。**`npm test` には入れない。**
 *
 * ネットワークに依存するので、既存の `scripts/smoke.ts` と同じく独立したスクリプトに
 * してある。**`describe-user-pool-client` の 1 件だけ AWS 認証情報を要求し、
 * 無ければその 1 件を明示的に skip して残りを走らせる**（黙って緑にしない）。
 *
 *     nix develop /home/shutx/github/blog --command bash -c \
 *       'cd /home/shutx/github/blog && npm run -w admin auth-smoke'
 *
 * # これが確かめられる唯一のこと
 *
 * ユニットテストは「admin が何を送るつもりか」しか言えない。**実配信の設定が
 * それを受け入れるかは言えない。** infra を触っていなくても、コンソールから
 * 誰かがクライアント設定を変えれば admin は黙って壊れる。**それを検出する唯一の手段。**
 *
 * # 宛先の上書き
 *
 * `ADMIN_SITE_ORIGIN` で配信オリジンを上書きできる。
 */
import { execFileSync } from 'node:child_process';

import {
  AUTHORIZE_PATH,
  AUTH_CONFIG,
  LOGOUT_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  resolveRedirectUri,
} from '../src/auth/config.ts';

const ORIGIN = process.env['ADMIN_SITE_ORIGIN'] ?? 'https://d8gsxbwzr6ft8.cloudfront.net';
const REDIRECT_URI = resolveRedirectUri(ORIGIN);

/** issuer の末尾がユーザプール ID。**別々に書かない**（ずれる余地を作らない）。 */
const USER_POOL_ID = AUTH_CONFIG.issuer.split('/').at(-1) ?? '';

interface Check {
  name: string;
  /** 文字列を返せば成功、投げれば失敗。`SkipError` を投げれば skip。 */
  run(): Promise<string>;
}

class SkipError extends Error {}

const equal = (label: string, actual: unknown, expected: unknown): void => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期待 ${b} / 実際 ${a}`);
};

const aws = (args: string[]): unknown => {
  const out = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
};

const hasAwsCredentials = (): boolean => {
  try {
    aws(['sts', 'get-caller-identity']);
    return true;
  } catch {
    return false;
  }
};

/** リダイレクトを追わない GET。3xx をそのまま観測する。 */
const head = async (url: string): Promise<Response> => fetch(url, { redirect: 'manual' });

const authorizeUrl = (challengeMethod: string): string => {
  const url = new URL(`${AUTH_CONFIG.loginDomain}${AUTHORIZE_PATH}`);
  url.search = new URLSearchParams({
    client_id: AUTH_CONFIG.clientId,
    response_type: 'code',
    scope: AUTH_CONFIG.scope,
    redirect_uri: REDIRECT_URI,
    state: 'smoke-state-0000000000000000000000',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: challengeMethod,
  }).toString();
  return url.href;
};

const checks: Check[] = [
  {
    name: '**設定ドリフト**: describe-user-pool-client が config.ts と一致する',
    run: async () => {
      if (!hasAwsCredentials()) {
        throw new SkipError('AWS 認証情報が無い（AWS_PROFILE=blog で再実行すること）');
      }

      const described = aws([
        'cognito-idp',
        'describe-user-pool-client',
        '--user-pool-id',
        USER_POOL_ID,
        '--client-id',
        AUTH_CONFIG.clientId,
      ]) as { UserPoolClient?: Record<string, unknown> };

      const client = described.UserPoolClient;
      if (client === undefined) throw new Error('UserPoolClient が応答に無い');

      equal('ClientId', client['ClientId'], AUTH_CONFIG.clientId);
      equal('CallbackURLs[0]', (client['CallbackURLs'] as string[])[0], REDIRECT_URI);
      equal('LogoutURLs[0]', (client['LogoutURLs'] as string[])[0], REDIRECT_URI);
      equal('AllowedOAuthFlows', client['AllowedOAuthFlows'], ['code']);
      equal('AllowedOAuthScopes', client['AllowedOAuthScopes'], [AUTH_CONFIG.scope]);
      equal('AllowedOAuthFlowsUserPoolClient', client['AllowedOAuthFlowsUserPoolClient'], true);
      equal('EnableTokenRevocation', client['EnableTokenRevocation'], true);

      // **public client であること。** secret が生えていたら admin は動かない。
      if (client['ClientSecret'] !== undefined) {
        throw new Error('ClientSecret が設定されている（public client ではなくなっている）');
      }
      return 'ClientId / Callback / Logout / flows / scopes / revocation すべて一致';
    },
  },
  {
    name: 'discovery のエンドポイントが config.ts の定数と一致する',
    run: async () => {
      // **実行時には読まない**（読むと誤った結論に至る）が、smoke では読んで突き合わせる。
      const response = await fetch(`${AUTH_CONFIG.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`discovery が ${response.status}`);
      const doc = (await response.json()) as Record<string, unknown>;

      equal('issuer', doc['issuer'], AUTH_CONFIG.issuer);
      equal(
        'authorization_endpoint',
        doc['authorization_endpoint'],
        `${AUTH_CONFIG.loginDomain}${AUTHORIZE_PATH}`,
      );
      equal('token_endpoint', doc['token_endpoint'], `${AUTH_CONFIG.loginDomain}${TOKEN_PATH}`);
      equal(
        'revocation_endpoint',
        doc['revocation_endpoint'],
        `${AUTH_CONFIG.loginDomain}${REVOKE_PATH}`,
      );
      equal(
        'end_session_endpoint',
        doc['end_session_endpoint'],
        `${AUTH_CONFIG.loginDomain}${LOGOUT_PATH}`,
      );
      return '4 つのエンドポイントが一致';
    },
  },
  {
    name: '**public client として受理される**（不正な code に invalid_grant）',
    run: async () => {
      const response = await fetch(`${AUTH_CONFIG.loginDomain}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: AUTH_CONFIG.clientId,
          code: 'smoke-not-a-real-code',
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          redirect_uri: REDIRECT_URI,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (body.error === 'invalid_client') {
        throw new Error('invalid_client が返った。**client_secret を要求している**（public client ではない）');
      }
      if (response.status !== 400 || body.error !== 'invalid_grant') {
        throw new Error(`期待は 400 invalid_grant、実際は ${response.status} ${String(body.error)}`);
      }
      return '400 invalid_grant（secret 無しで受理されている）';
    },
  },
  {
    name: 'token エンドポイントの CORS preflight が admin のオリジンを通す',
    run: async () => {
      const response = await fetch(`${AUTH_CONFIG.loginDomain}${TOKEN_PATH}`, {
        method: 'OPTIONS',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      if (!response.ok) throw new Error(`preflight が ${response.status}`);

      const methods = response.headers.get('access-control-allow-methods') ?? '';
      const headers = response.headers.get('access-control-allow-headers') ?? '';
      if (!methods.toUpperCase().includes('POST')) {
        throw new Error(`allow-methods に POST が無い: ${methods}`);
      }
      if (!headers.toLowerCase().includes('content-type')) {
        throw new Error(`allow-headers に content-type が無い: ${headers}`);
      }
      // **CORS は防御ではない**（Origin を検証せずそのまま反映する）。
      // 守っているのは PKCE と state だけである、という前提を毎回確かめている。
      return `allow-methods=${methods} allow-headers=${headers}`;
    },
  },
  {
    name: 'PKCE(S256) 付きの authorize が 302 する',
    run: async () => {
      const response = await head(authorizeUrl('S256'));
      if (response.status !== 302) throw new Error(`302 ではなく ${response.status}`);
      return `302 -> ${response.headers.get('location') ?? ''}`;
    },
  },
  {
    name: '**PKCE も state もサーバ側では強制されていない**（こちら側の規律である）',
    run: async () => {
      // **実測を記録するだけで、拒否を期待しない。**
      // `code_challenge_method=plain` も `code_challenge` 無しも `state` 無しも 302 する。
      // つまり「S256 と state を必ず送る」のは admin 側の責任であり、
      // buildAuthorizeUrl が空の値に対して投げることで機械的に守っている。
      const plain = await head(authorizeUrl('plain'));

      const bare = new URL(`${AUTH_CONFIG.loginDomain}${AUTHORIZE_PATH}`);
      bare.search = new URLSearchParams({
        client_id: AUTH_CONFIG.clientId,
        response_type: 'code',
        scope: AUTH_CONFIG.scope,
        redirect_uri: REDIRECT_URI,
      }).toString();
      const noPkce = await head(bare.href);

      return `plain=${plain.status} / PKCE も state も無し=${noPkce.status}（どちらも拒否されないので admin が守る）`;
    },
  },
  {
    name: 'logout が logout_uri に 302 で返す',
    run: async () => {
      const url = new URL(`${AUTH_CONFIG.loginDomain}${LOGOUT_PATH}`);
      url.search = new URLSearchParams({
        client_id: AUTH_CONFIG.clientId,
        logout_uri: REDIRECT_URI,
      }).toString();

      const response = await head(url.href);
      if (response.status !== 302) throw new Error(`302 ではなく ${response.status}`);
      const location = response.headers.get('location') ?? '';
      if (location !== REDIRECT_URI) {
        throw new Error(`logout_uri に戻らない: ${location}`);
      }
      return `302 -> ${location}`;
    },
  },
  {
    name: 'GET /api/health が cognito モードで動いている',
    run: async () => {
      const response = await fetch(`${ORIGIN}/api/health`);
      const body = (await response.json()) as { status?: unknown; authMode?: unknown };
      equal('status', body.status, 'ok');
      equal('authMode', body.authMode, 'cognito');
      return 'status=ok authMode=cognito';
    },
  },
];

const main = async (): Promise<void> => {
  console.log(`auth-smoke: ${AUTH_CONFIG.loginDomain}`);
  console.log(`            redirect_uri = ${REDIRECT_URI}\n`);

  let failed = 0;
  let skipped = 0;

  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  ok   ${check.name}\n       ${detail}`);
    } catch (error) {
      if (error instanceof SkipError) {
        skipped += 1;
        // **黙って緑にしない。** skip したことを必ず出す。
        console.log(`  SKIP ${check.name}\n       ${error.message}`);
        continue;
      }
      failed += 1;
      console.error(`  FAIL ${check.name}\n       ${(error as Error).message}`);
    }
  }

  const ran = checks.length - skipped;
  if (failed > 0) {
    console.error(`\n${failed} / ${ran} 件が失敗（${skipped} 件 skip）`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${ran} / ${ran} 件が成功（${skipped} 件 skip）`);
};

await main();
