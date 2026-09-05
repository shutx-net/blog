import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AUTH_MODES,
  AUTH_MODE_COGNITO,
  AUTH_MODE_DENY_ALL,
  loadConfig,
} from '../../src/config.ts';

/** 最低限そろっていれば設定として成立する環境変数一式。 */
const baseEnv = (): Record<string, string | undefined> => ({
  AUTH_MODE: AUTH_MODE_DENY_ALL,
  GITHUB_APP_CLIENT_ID: 'Iv23liTESTCLIENTID',
  GITHUB_OWNER: 'shutx-net',
  GITHUB_CONTENT_REPO: 'blog-content',
  GITHUB_CODE_REPO: 'blog',
  POSTS_PATH_PREFIX: 'posts/',
  GITHUB_APP_SECRET_ID: 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:x-AbCdEf',
  MEDIA_BUCKET: 'blogsitestack-mediabucket-example',
  AWS_REGION: 'ap-northeast-1',
});

/** cognito モードで成立する環境変数一式。 */
const cognitoEnv = (): Record<string, string | undefined> => ({
  ...baseEnv(),
  AUTH_MODE: AUTH_MODE_COGNITO,
  COGNITO_USER_POOL_ID: 'ap-northeast-1_TESTPOOL1',
  COGNITO_CLIENT_ID: '1example23456789testclientid',
  COGNITO_ALLOWED_USERNAME: 'shutx',
});

/** モードごとの必須環境変数。**表にしておくと、モードを足したとき走査が自動で増える。** */
const REQUIRED_BY_MODE: Record<string, { env: () => Record<string, string | undefined>; names: string[] }> = {
  [AUTH_MODE_DENY_ALL]: {
    env: baseEnv,
    names: [
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_OWNER',
      'GITHUB_CONTENT_REPO',
      'GITHUB_CODE_REPO',
      'POSTS_PATH_PREFIX',
      'GITHUB_APP_SECRET_ID',
      'MEDIA_BUCKET',
      'AWS_REGION',
    ],
  },
  [AUTH_MODE_COGNITO]: {
    env: cognitoEnv,
    names: [
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_OWNER',
      'GITHUB_CONTENT_REPO',
      'GITHUB_CODE_REPO',
      'POSTS_PATH_PREFIX',
      'GITHUB_APP_SECRET_ID',
      'MEDIA_BUCKET',
      'AWS_REGION',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'COGNITO_ALLOWED_USERNAME',
    ],
  },
};

describe('AUTH_MODE の検証', () => {
  it('**許容値が deny-all と cognito のちょうど 2 つである**（集合等価）', () => {
    // 反例列挙だけに頼らない。許容値を増やしたらここが赤くなる。
    expect([...ALLOWED_AUTH_MODES].sort()).toEqual(['cognito', 'deny-all']);
  });

  it('deny-all を受け付ける', () => {
    expect(loadConfig(baseEnv()).auth.mode).toBe('deny-all');
  });

  it('cognito を受け付ける', () => {
    expect(loadConfig(cognitoEnv()).auth.mode).toBe('cognito');
  });

  it('AUTH_MODE が未設定なら例外を投げる', () => {
    // 環境変数の打ち間違いが「黙って全許可」になってはならない。ここで投げると
    // Lambda はコールドスタートで落ち、CloudFront には 502 が返る。**これが正しい
    // 失敗の仕方**であって、リクエストを通してしまうより良い。
    const env = baseEnv();
    delete env['AUTH_MODE'];
    expect(() => loadConfig(env)).toThrow(/AUTH_MODE/);
  });

  it.each(['off', 'none', '', 'allow', 'deny', 'true', 'false', 'allow-all', 'cognito-ish'])(
    'AUTH_MODE=%o のような未知の値では例外を投げる',
    (value) => {
      expect(() => loadConfig({ ...baseEnv(), AUTH_MODE: value })).toThrow(/AUTH_MODE/);
    },
  );

  it.each([
    'DENY-ALL',
    'Deny-All',
    'deny-All',
    ' deny-all',
    'deny-all ',
    'COGNITO',
    'Cognito',
    'coGnito',
    ' cognito',
    'cognito ',
    '\tcognito',
    'cognito\n',
  ])('AUTH_MODE=%o は大文字小文字も空白も寛容に扱わず例外を投げる', (value) => {
    // 寛容な正規化を入れると「意図した値」と「たまたま通った値」の区別が消える。
    // **cognito についても同じ厳しさを固定する**（Phase 3 は deny-all しか見ていなかった）。
    expect(() => loadConfig({ ...cognitoEnv(), AUTH_MODE: value })).toThrow(/AUTH_MODE/);
  });

  it('**未知の値では COGNITO_* が揃っていても例外を投げる**（黙って書き込みを許さない）', () => {
    // 本フェーズで一番危険な失敗の仕方が「不明な AUTH_MODE が黙って通る」ことなので、
    // 他の変数が完璧に揃っている状態でも落ちることを名指しで固定する。
    expect(() => loadConfig({ ...cognitoEnv(), AUTH_MODE: 'allow-all' })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...cognitoEnv(), AUTH_MODE: '' })).toThrow(/AUTH_MODE/);
    const env = cognitoEnv();
    delete env['AUTH_MODE'];
    expect(() => loadConfig(env)).toThrow(/AUTH_MODE/);
  });

  it('例外メッセージに与えられた値をそのまま含めない', () => {
    // 環境変数の中身がログに載る前提で書く。AUTH_MODE 自体は秘密ではないが、
    // 「設定値をそのままエラーに載せる」書き癖が他の変数に伝染するのを避ける。
    let message = '';
    try {
      loadConfig({ ...baseEnv(), AUTH_MODE: 'super-secret-typo' });
    } catch (error) {
      message = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(message).not.toContain('super-secret-typo');
  });
});

describe('その他の必須設定', () => {
  /** モードごとの必須集合を走査する。**ハードコードした 1 本の配列にしない。** */
  const requiredCases = Object.entries(REQUIRED_BY_MODE).flatMap(([mode, { env, names }]) =>
    names.map((name) => [mode, name, env] as const),
  );

  it('走査対象が空でない（8 + 11 = 19 件）', () => {
    expect(requiredCases).toHaveLength(19);
  });

  it.each(requiredCases)('AUTH_MODE=%s で %s が無いと例外を投げる', (_mode, name, env) => {
    const e = env();
    delete e[name];
    expect(() => loadConfig(e)).toThrow(new RegExp(name));
  });

  it.each(requiredCases)('AUTH_MODE=%s で %s が空文字なら例外を投げる', (_mode, name, env) => {
    expect(() => loadConfig({ ...env(), [name]: '' })).toThrow(new RegExp(name));
  });

  it('設定値を読み出せる', () => {
    const config = loadConfig(baseEnv());
    expect(config.githubOwner).toBe('shutx-net');
    expect(config.mediaBucket).toBe('blogsitestack-mediabucket-example');
    expect(config.region).toBe('ap-northeast-1');
  });

  it('**記事リポジトリとコードリポジトリを別々に読む**', () => {
    // 記事は private の blog-content、ワークフローを起動する先は public の blog。
    // 1 つの GITHUB_REPO に畳むと、権限を分けた 2 本のトークンを作り分けられない。
    const config = loadConfig(baseEnv());
    expect(config.githubContentRepo).toBe('blog-content');
    expect(config.githubCodeRepo).toBe('blog');
  });

  it('記事パスの接頭辞を環境変数から読む', () => {
    // ハードコードのままだと、記事リポジトリ内の 'posts/' へ切り替えるのに
    // Lambda の再ビルドが要る。設定にしておけば env の差し替えだけで済む。
    expect(loadConfig(baseEnv()).postsPathPrefix).toBe('posts/');
  });

  it('**DEPLOY_WORKFLOW_FILE は任意で、未設定なら undefined**', () => {
    // 未設定 = dispatch しない、という opt-in をここで固定する。
    // 既定で dispatch すると、push 起点のデプロイと二重に走る。
    const env = baseEnv();
    expect(env['DEPLOY_WORKFLOW_FILE']).toBeUndefined();
    expect(loadConfig(env).deployWorkflowFile).toBeUndefined();
  });

  it('DEPLOY_WORKFLOW_FILE を設定すれば読める', () => {
    const config = loadConfig({ ...baseEnv(), DEPLOY_WORKFLOW_FILE: 'deploy.yml' });
    expect(config.deployWorkflowFile).toBe('deploy.yml');
  });

  it('DEPLOY_WORKFLOW_FILE が空文字なら未設定として扱う', () => {
    // GitHub も CDK も「未設定」を空文字に展開することがある。空文字を
    // ワークフロー名として送ると 404 になるので、ここで未設定に畳む。
    expect(loadConfig({ ...baseEnv(), DEPLOY_WORKFLOW_FILE: '' }).deployWorkflowFile).toBeUndefined();
  });

  it('秘密の値を環境変数から読まない', () => {
    // 設計判断8: CDK に秘密を書かない。秘密鍵は Secrets Manager からしか来ない。
    // 設定オブジェクトに PEM やトークンを載せる経路を作らないことを構造で固定する。
    const config = loadConfig({ ...baseEnv(), GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----' });
    expect(JSON.stringify(config)).not.toContain('-----BEGIN');
  });
});

describe('AUTH_MODE=cognito のときだけ COGNITO_* が必須になる', () => {
  it.each(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_ALLOWED_USERNAME'])(
    '%s が欠けると例外を投げ、変数名がメッセージに出る',
    (name) => {
      const env = cognitoEnv();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(name));
    },
  );

  it('3 つとも欠けていても最初の 1 つで落ちる（中途半端な設定がデプロイできない）', () => {
    const env = cognitoEnv();
    delete env['COGNITO_USER_POOL_ID'];
    delete env['COGNITO_CLIENT_ID'];
    delete env['COGNITO_ALLOWED_USERNAME'];
    expect(() => loadConfig(env)).toThrow(/COGNITO_/);
  });

  it('**AUTH_MODE=deny-all のときは COGNITO_* を 1 つも読まない**', () => {
    // 3 つとも未設定のまま成功すること。これにより「Cognito を無効にしたまま安全に戻せる」
    // という運用上の逃げ道が残る（壊れた Cognito 設定を抱えたまま安全側に倒せる）。
    const env = baseEnv();
    expect(env['COGNITO_USER_POOL_ID']).toBeUndefined();
    expect(env['COGNITO_CLIENT_ID']).toBeUndefined();
    expect(env['COGNITO_ALLOWED_USERNAME']).toBeUndefined();
    expect(() => loadConfig(env)).not.toThrow();
    expect(loadConfig(env).auth.mode).toBe('deny-all');
  });

  it('deny-all の設定オブジェクトに COGNITO_* が 1 つも載らない', () => {
    // 値を全部与えても、deny-all なら設定に現れない（読んでいないことの証拠）。
    const config = loadConfig({ ...cognitoEnv(), AUTH_MODE: AUTH_MODE_DENY_ALL });
    expect(JSON.stringify(config)).not.toContain('TESTPOOL1');
    expect(JSON.stringify(config)).not.toContain('testclientid');
    expect(config.auth).toEqual({ mode: 'deny-all' });
  });

  it('cognito の設定オブジェクトに 3 つの値が載る', () => {
    const config = loadConfig(cognitoEnv());
    expect(config.auth).toEqual({
      mode: 'cognito',
      userPoolId: 'ap-northeast-1_TESTPOOL1',
      clientId: '1example23456789testclientid',
      allowedUsername: 'shutx',
    });
  });

  it('例外メッセージに COGNITO_* の値そのものを含めない', () => {
    let message = '';
    try {
      loadConfig({ ...cognitoEnv(), COGNITO_ALLOWED_USERNAME: '' });
    } catch (error) {
      message = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(message).toContain('COGNITO_ALLOWED_USERNAME');
    expect(message).not.toContain('TESTPOOL1');
  });
});

/**
 * 型レベルの表明（実行時コード無し）。
 *
 * **mode を見ずに userPoolId に到達できないこと**を固定する。
 * 判別可能ユニオンなので、`config.auth.userPoolId` を直接書くと型検査が落ちる。
 */
type AuthConfigOf = ReturnType<typeof loadConfig>['auth'];
type AssertDenyAllHasNoPoolId = AuthConfigOf extends { userPoolId: string } ? never : true;
export type _DenyAllHasNoPoolId = AssertDenyAllHasNoPoolId;
type NarrowedCognito = Extract<AuthConfigOf, { mode: typeof AUTH_MODE_COGNITO }>;
type AssertCognitoHasAllThree = NarrowedCognito extends {
  userPoolId: string;
  clientId: string;
  allowedUsername: string;
}
  ? true
  : never;
export type _CognitoHasAllThree = AssertCognitoHasAllThree;
