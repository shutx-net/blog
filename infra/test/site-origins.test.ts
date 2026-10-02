import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SITE_ORIGIN, SITE_ORIGINS, SiteStack } from '../lib/site-stack.ts';

/**
 * **配信オリジンの許可リストを縛る。**
 *
 * `SITE_ORIGIN` 1 定数だった頃は、CORS と `CallbackURLs` が同じ文字列であることを
 * 「同じ定数を参照している」という事実が保証していた。許可リストに広げた以上、
 * **その保証はコードからは消えている。** 役目をここに移す。
 *
 * ## 期待値はリテラルで書く
 *
 * `SITE_ORIGINS` を import して `SITE_ORIGINS` と比べる形は何も証明しない
 * （`admin/test/support/site-renderer.ts` と同じ規律 — 両辺が一緒にずれて緑のまま壊れる）。
 * 下の「リテラル 2 本」だけが定数の値そのものを主張しており、テンプレート側のアサーションは
 * **テンプレートから読んだ 2 つの集合を互いに突き合わせる**形にしてある。
 *
 * ## deploy.yml との一致が本題
 *
 * `SITE_ORIGIN` は**テンプレートに現れない**。正のオリジンの実体は deploy.yml の
 * `SITE_URL`（canonical link / sitemap / RSS の guid がそこから生える）で、こちらはその鏡。
 * **鏡がずれた状態＝切替をやりかけて止めた状態**を禁じるのが、このファイルで唯一
 * 他のどこにも無いアサーションである。
 */

/** `CUSTOM_DOMAIN_NAME` / `CLOUDFRONT_ORIGIN` を import しない。**ここはリテラルで書く側。** */
const EXPECTED_SITE_ORIGINS = [
  'https://d8gsxbwzr6ft8.cloudfront.net',
  'https://blog.shutx.net',
];

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

interface CfnResource {
  Properties?: Record<string, unknown>;
}

/** リソースをちょうど 1 個取る。**件数アサーションが非空ガードを兼ねる。** */
const soleProperties = (type: string): Record<string, unknown> => {
  const found = template.findResources(type) as Record<string, CfnResource>;
  expect(Object.keys(found), `${type} はちょうど 1 個`).toHaveLength(1);
  return (Object.values(found)[0] as CfnResource).Properties ?? {};
};

/** メディアバケットの CORS が許可しているオリジン。 */
const corsAllowedOrigins = (): string[] => {
  const buckets = template.findResources('AWS::S3::Bucket') as Record<string, CfnResource>;
  const withCors = Object.values(buckets).filter(
    (bucket) => bucket.Properties?.['CorsConfiguration'] !== undefined,
  );
  // CORS を持つバケットが 1 個であること自体は media-bucket.test.ts が見ている。
  // ここでは「どのバケットを読んだか曖昧でない」ことの保証として使う。
  expect(withCors, 'CorsConfiguration を持つバケットはちょうど 1 個').toHaveLength(1);
  const cors = withCors[0]?.Properties?.['CorsConfiguration'] as {
    CorsRules?: Record<string, unknown>[];
  };
  const rules = cors.CorsRules ?? [];
  expect(rules, 'CorsRules はちょうど 1 本').toHaveLength(1);
  return rules[0]?.['AllowedOrigins'] as string[];
};

/** Cognito のリダイレクト先 URL（`CallbackURLs` / `LogoutURLs`）。 */
const redirectUrls = (key: 'CallbackURLs' | 'LogoutURLs'): string[] => {
  const urls = soleProperties('AWS::Cognito::UserPoolClient')[key];
  expect(Array.isArray(urls), `${key} が配列であること`).toBe(true);
  return urls as string[];
};

/** URL 列をオリジンの集合（ソート済み）に落とす。 */
const originsOf = (urls: string[]): string[] =>
  [...new Set(urls.map((url) => new URL(url).origin))].sort();

// ---- deploy.yml の読み出し（site/test/unit/deploy-workflow.test.ts と同じ形） ----

interface WorkflowStep {
  run?: unknown;
  env?: Record<string, unknown>;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const BUILD_COMMAND = 'npm run -w site build';

/**
 * サイトをビルドするステップ。**ちょうど 1 つ**でなければ `env` がどれを指すか曖昧になる。
 *
 * 存在を先に主張するのは、ファイルが無いときに「YAML が壊れている」という
 * 見当違いのエラーで出ないようにするため。
 */
const buildStep = (): WorkflowStep => {
  const path = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url));
  expect(existsSync(path), `${path} が存在すること`).toBe(true);
  const workflow = parse(readFileSync(path, 'utf8')) as Workflow;
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const building = steps.filter(
    (step) => typeof step.run === 'string' && step.run.includes(BUILD_COMMAND),
  );
  expect(building, `\`${BUILD_COMMAND}\` を走らせるステップはちょうど 1 つ`).toHaveLength(1);
  return building[0] as WorkflowStep;
};

const siteUrlInYaml = (): string => {
  const value = buildStep().env?.['SITE_URL'];
  expect(typeof value, 'build ステップが env.SITE_URL を持つこと').toBe('string');
  return value as string;
};

describe('SITE_ORIGINS（許可するオリジンの集合）', () => {
  it('**リテラル 2 本と完全一致する**（順序も含む）', () => {
    // **ここだけが定数の値そのものを主張している。** 他のアサーションは
    // 「2 つの場所が互いに一致している」しか言っていないので、
    // この 1 本が無いと 2 本とも間違ったまま全部緑になる。
    expect([...SITE_ORIGINS]).toEqual(EXPECTED_SITE_ORIGINS);
  });

  it('**正のオリジン `SITE_ORIGIN` が許可リストに含まれている**', () => {
    // 外れていると、サイトが配られているオリジンからログインできない。
    expect([...SITE_ORIGINS]).toContain(SITE_ORIGIN);
  });

  it('重複が無い（テンプレートに同じ値が 2 回描画されない）', () => {
    expect(new Set(SITE_ORIGINS).size).toBe(SITE_ORIGINS.length);
  });

  it.each([...SITE_ORIGINS])('%s がオリジンだけの https URL である', (origin) => {
    // **`new URL(x).origin === x` が効いている。** 末尾スラッシュもパスもクエリも、
    // これ 1 本で落ちる（`https://example.com/` は origin が `https://example.com`）。
    // Cognito の `CallbackURLs` はテンプレート展開で `${origin}/admin/` を作るので、
    // 末尾スラッシュが混ざると `//admin/` という別の URL になり redirect_mismatch になる。
    expect(origin.startsWith('https://'), origin).toBe(true);
    expect(new URL(origin).origin, origin).toBe(origin);
    expect(origin, origin).not.toContain('*');
  });
});

/**
 * **切替の半端な状態を禁じる唯一のアサーション。**
 *
 * `SITE_ORIGIN` を独自ドメインに倒したのに deploy.yml の `SITE_URL` を据え置けば、
 * canonical link と RSS の guid は `*.cloudfront.net` のまま、infra 側のコメントだけが
 * 「正は独自ドメイン」と主張する状態になる。逆向きはもっと悪く、**guid だけが
 * 先に変わって全記事が再配信される**（取り消せない）。
 */
describe('SITE_ORIGIN と deploy.yml の SITE_URL', () => {
  it('build ステップの env.SITE_URL が https の絶対 URL である', () => {
    // 形が壊れていると下のアサーションが「一致しない」ではなく throw で落ちるので、先に見る。
    const value = siteUrlInYaml();
    expect(value.startsWith('https://'), value).toBe(true);
    expect(() => new URL(value)).not.toThrow();
  });

  it('**SITE_ORIGIN が env.SITE_URL のオリジンと一致する**', () => {
    // SITE_URL は末尾スラッシュ付きの正規化形（site/src/site-url.ts の規則）なので、
    // 文字列ではなく origin で比べる。
    expect(SITE_ORIGIN).toBe(new URL(siteUrlInYaml()).origin);
  });
});

/**
 * **「ログインはできるが画像が上がらない」の名指しの回帰テスト。**
 *
 * 1 定数だった頃はコードの形が保証していた。許可リストに広げた以上、保証はここにしか無い。
 * 両辺を**テンプレートから読む**ので、定数側を間違えても「2 か所が食い違っている」ことは
 * 検出しない（それは上の「リテラル 2 本」の仕事）。ここが見るのは **2 か所の一致**である。
 */
describe('メディアの CORS と Cognito のリダイレクト先が同じオリジン集合である', () => {
  it('CORS の AllowedOrigins と CallbackURLs のオリジン集合が一致する', () => {
    expect(originsOf(corsAllowedOrigins())).toEqual(originsOf(redirectUrls('CallbackURLs')));
  });

  it('LogoutURLs のオリジン集合も同じ', () => {
    // ここがずれると「ログインはできるがログアウトで redirect_mismatch」になる。
    expect(originsOf(corsAllowedOrigins())).toEqual(originsOf(redirectUrls('LogoutURLs')));
  });

  it('**宣言した許可リストがテンプレートの両方に届いている**', () => {
    // 上の 2 本は「2 か所が一致している」しか言わないので、**両方とも 1 本に
    // 退化した**状態（= 本フェーズを無かったことにする変更）を素通りさせる。
    expect(originsOf(corsAllowedOrigins())).toEqual([...SITE_ORIGINS].sort());
  });

  it.each(['CallbackURLs', 'LogoutURLs'] as const)(
    '%s の全件が `/admin/` を指している',
    (key) => {
      // オリジン集合の一致はパスを見ない。`/admin` や `/admin/index.html` に
      // なっていても上は緑なので、パスはここで固定する（1 文字違うと redirect_mismatch）。
      const urls = redirectUrls(key);
      expect(urls, `${key} は SITE_ORIGINS と同数`).toHaveLength(SITE_ORIGINS.length);
      for (const url of urls) {
        expect(new URL(url).pathname, url).toBe('/admin/');
      }
    },
  );
});
