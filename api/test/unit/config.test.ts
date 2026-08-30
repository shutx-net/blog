import { describe, expect, it } from 'vitest';
import { AUTH_MODE_DENY_ALL, loadConfig } from '../../src/config.ts';

/** 最低限そろっていれば設定として成立する環境変数一式。 */
const baseEnv = (): Record<string, string | undefined> => ({
  AUTH_MODE: AUTH_MODE_DENY_ALL,
  GITHUB_APP_CLIENT_ID: 'Iv23liTESTCLIENTID',
  GITHUB_OWNER: 'shutx-net',
  GITHUB_REPO: 'blog',
  GITHUB_APP_SECRET_ID: 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:x-AbCdEf',
  MEDIA_BUCKET: 'blogsitestack-mediabucket-example',
  AWS_REGION: 'ap-northeast-1',
});

describe('AUTH_MODE の検証', () => {
  it('deny-all を受け付ける（本フェーズで唯一の許容値）', () => {
    expect(loadConfig(baseEnv()).authMode).toBe('deny-all');
  });

  it('AUTH_MODE が未設定なら例外を投げる', () => {
    // 環境変数の打ち間違いが「黙って全許可」になってはならない。ここで投げると
    // Lambda はコールドスタートで落ち、CloudFront には 502 が返る。**これが正しい
    // 失敗の仕方**であって、リクエストを通してしまうより良い。
    const env = baseEnv();
    delete env['AUTH_MODE'];
    expect(() => loadConfig(env)).toThrow(/AUTH_MODE/);
  });

  it.each(['off', 'none', '', 'allow', 'deny', 'true', 'false'])(
    'AUTH_MODE=%o のような未知の値では例外を投げる',
    (value) => {
      expect(() => loadConfig({ ...baseEnv(), AUTH_MODE: value })).toThrow(/AUTH_MODE/);
    },
  );

  it.each(['DENY-ALL', 'Deny-All', 'deny-All', ' deny-all', 'deny-all '])(
    'AUTH_MODE=%o は大文字小文字も空白も寛容に扱わず例外を投げる',
    (value) => {
      // 寛容な正規化を入れると「意図した値」と「たまたま通った値」の区別が消える。
      // 許容値は 1 つだけなので、完全一致で足りる。
      expect(() => loadConfig({ ...baseEnv(), AUTH_MODE: value })).toThrow(/AUTH_MODE/);
    },
  );

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
  it.each([
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_APP_SECRET_ID',
    'MEDIA_BUCKET',
    'AWS_REGION',
  ])('%s が無いと例外を投げる', (name) => {
    const env = baseEnv();
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it('設定値を読み出せる', () => {
    const config = loadConfig(baseEnv());
    expect(config.githubOwner).toBe('shutx-net');
    expect(config.githubRepo).toBe('blog');
    expect(config.mediaBucket).toBe('blogsitestack-mediabucket-example');
    expect(config.region).toBe('ap-northeast-1');
  });

  it('秘密の値を環境変数から読まない', () => {
    // 設計判断8: CDK に秘密を書かない。秘密鍵は Secrets Manager からしか来ない。
    // 設定オブジェクトに PEM やトークンを載せる経路を作らないことを構造で固定する。
    const config = loadConfig({ ...baseEnv(), GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----' });
    expect(JSON.stringify(config)).not.toContain('-----BEGIN');
  });
});
