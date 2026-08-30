/**
 * 実配信に対する smoke。**`npm test` には入れない。**
 *
 * ネットワークと実環境に依存するので CI の必須チェックにはしない独立した
 * スクリプトにしてある。AWS の認証情報は要らない。
 *
 * ## これが確かめられる唯一のこと
 *
 * ユニットテストは「`x-amz-content-sha256` を付けたこと」しか言えない。
 * **「CloudFront がそれを受け入れたこと」は言えない。** ここが Phase 3 の罠に
 * 対する唯一の実環境側の防波堤である。
 *
 * ## 404 の読み方
 *
 * `POST /api/posts` が **404 を返したら経路が無いのではない。**
 * 署名に失敗した 403 が `CustomErrorResponses` によって 404 の HTML に
 * 化けている。つまり `x-amz-content-sha256` が届いていない。
 * **503 `auth_not_configured` が期待値**（署名は通り、AUTH_MODE=deny-all が
 * 弾いた、という意味）。
 *
 *     nix develop /home/shutx/github/blog --command bash -c \
 *       'cd admin && npm run smoke'
 *
 * 宛先は ADMIN_API_ORIGIN で上書きできる。
 */
import { createApiClient, ApiError } from '../src/api/client.ts';
import { createStubAuthTransport } from '../src/auth/session.ts';

const ORIGIN = process.env['ADMIN_API_ORIGIN'] ?? 'https://d8gsxbwzr6ft8.cloudfront.net';

interface Check {
  name: string;
  run(): Promise<string>;
}

/** **admin が本番で使うのと同じ client を使う。** 別経路で叩いたら意味がない。 */
const client = createApiClient({ origin: ORIGIN, auth: createStubAuthTransport() });

const checks: Check[] = [
  {
    name: 'GET /api/health が 200 で status: ok を返す',
    run: async () => {
      const result = (await client.call({ method: 'GET', path: '/api/health' })) as {
        status?: unknown;
        authMode?: unknown;
      };
      if (result.status !== 'ok') {
        throw new Error(`status が 'ok' ではない: ${JSON.stringify(result)}`);
      }
      return `status=ok authMode=${String(result.authMode)}`;
    },
  },
  {
    name: 'POST /api/posts が 503 auth_not_configured を返す（404 ではない）',
    run: async () => {
      try {
        await client.call({ method: 'POST', path: '/api/posts' }, { slug: 'x' });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 404) {
          throw new Error(
            '404 が返った。経路が無いのではなく **x-amz-content-sha256 が届いていない**。' +
              '署名に失敗した 403 が CustomErrorResponses で 404 の HTML に化けている',
          );
        }
        if (error.status !== 503 || error.code !== 'auth_not_configured') {
          throw new Error(`期待は 503 auth_not_configured、実際は ${error.status} ${error.code}`);
        }
        return '503 auth_not_configured（署名は通っている）';
      }
      throw new Error('POST が成功してしまった。AUTH_MODE が deny-all ではない');
    },
  },
];

const main = async (): Promise<void> => {
  console.log(`smoke: ${ORIGIN}`);
  let failed = 0;

  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  ok   ${check.name} — ${detail}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${check.name}`);
      console.error(`       ${(error as Error).message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} / ${checks.length} 件が失敗`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${checks.length} / ${checks.length} 件が成功`);
};

await main();
