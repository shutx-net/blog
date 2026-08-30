import { describe, expect, it, vi } from 'vitest';
import { KeyNotProvisionedError, createSecretReader } from '../../src/secret.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxx\n-----END RSA PRIVATE KEY-----\n';
const SECRET_ID = 'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:GitHubAppKey-AbCdEf';

/** SDK のコマンドから入力オブジェクトだけを取り出す（send のスパイが受け取るもの）。 */
interface SentCommand {
  input: Record<string, unknown>;
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const readerWith = (
  respond: (input: Record<string, unknown>) => unknown,
  log = logger(),
) => {
  const send = vi.fn(async (command: SentCommand) => respond(command.input));
  const reader = createSecretReader({
    client: { send } as never,
    secretId: SECRET_ID,
    logger: log,
  });
  return { reader, send, log };
};

/** SecretBinary は SDK 上 Uint8Array で返る。 */
const binary = (text: string): Uint8Array => new TextEncoder().encode(text);

class ResourceNotFoundException extends Error {
  override readonly name = 'ResourceNotFoundException';
}

describe('SecretBinary を優先して読む', () => {
  it('SecretBinary があれば UTF-8 デコードして PEM 文字列にする', () => {
    // DEVELOPERS.md の投入手順が `--secret-binary fileb://blog-app.private-key.pem`
    // なので、AWSCURRENT に入るのは SecretString ではなく SecretBinary。
    const { reader } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    return expect(reader.readPrivateKey()).resolves.toBe(PEM);
  });

  it('SecretBinary と SecretString が両方あるとき SecretBinary を使う', async () => {
    const { reader } = readerWith(() => ({
      SecretBinary: binary(PEM),
      SecretString: 'これは使われてはいけない',
    }));
    expect(await reader.readPrivateKey()).toBe(PEM);
  });

  it('SecretBinary が無く SecretString があればそちらを使う', async () => {
    // コンソールから貼った運用者を救う。
    const { reader } = readerWith(() => ({ SecretString: PEM }));
    expect(await reader.readPrivateKey()).toBe(PEM);
  });

  it('日本語混じりでも UTF-8 として正しくデコードする', async () => {
    const text = `${PEM}# 鍵のメモ\n`;
    const { reader } = readerWith(() => ({ SecretBinary: binary(text) }));
    expect(await reader.readPrivateKey()).toBe(text);
  });

  it('どちらも無いとき KeyNotProvisionedError を投げる', async () => {
    const { reader } = readerWith(() => ({}));
    await expect(reader.readPrivateKey()).rejects.toBeInstanceOf(KeyNotProvisionedError);
  });

  it('SecretString が空文字のときも「未投入」扱いにする', async () => {
    const { reader } = readerWith(() => ({ SecretString: '' }));
    await expect(reader.readPrivateKey()).rejects.toBeInstanceOf(KeyNotProvisionedError);
  });
});

describe('空のシークレット（CDK が作った直後の状態）', () => {
  it('ResourceNotFoundException を KeyNotProvisionedError に変換する', async () => {
    // **本フェーズの状態で実際に起きる唯一のパス。** CDK は値の無いシークレットを
    // 作るので、バージョンが 1 つも無く GetSecretValue は ResourceNotFoundException になる。
    const { reader } = readerWith(() => {
      throw new ResourceNotFoundException('Secrets Manager can not find the specified secret.');
    });
    await expect(reader.readPrivateKey()).rejects.toBeInstanceOf(KeyNotProvisionedError);
  });

  it('メッセージから「鍵がまだ投入されていない」と分かる', async () => {
    const { reader } = readerWith(() => {
      throw new ResourceNotFoundException('nope');
    });
    const error = (await reader.readPrivateKey().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/not been provisioned|put-secret-value/i);
  });

  it('ResourceNotFoundException 以外の SDK 例外は KeyNotProvisionedError にしない', async () => {
    const { reader } = readerWith(() => {
      const error = new Error('rate exceeded');
      error.name = 'ThrottlingException';
      throw error;
    });
    const error = await reader.readPrivateKey().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KeyNotProvisionedError);
  });
});

describe('GetSecretValue の入力', () => {
  it('既定の呼び出しでは VersionStage を渡さない（AWSCURRENT が返る）', async () => {
    const { reader, send } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    await reader.readPrivateKey();
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0]?.[0] as SentCommand).input;
    // **コマンド入力を deep-equal で固定する。** VersionStage を渡すか渡さないかは
    // 完全にこちらの責任で、AWS の既定に頼っている部分。
    expect(input).toEqual({ SecretId: SECRET_ID });
    expect(Object.keys(input)).not.toContain('VersionStage');
  });

  it('VersionStage を明示指定できる', async () => {
    // DEVELOPERS.md の鍵ローテーション手順 2「AWSPENDING で投入し、動作を確認」を
    // **実行可能にする**ための経路。
    const { reader, send } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    await reader.readPrivateKey({ versionStage: 'AWSPENDING' });
    const input = (send.mock.calls[0]?.[0] as SentCommand).input;
    expect(input).toEqual({ SecretId: SECRET_ID, VersionStage: 'AWSPENDING' });
  });
});

describe('実行環境キャッシュ', () => {
  it('2 回目以降は GetSecretValue を呼ばない', async () => {
    const { reader, send } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    await reader.readPrivateKey();
    await reader.readPrivateKey();
    await reader.readPrivateKey();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('**VersionStage を明示したときはキャッシュを使わない**', async () => {
    // ローテーション検証で古い値が返ると、検証したことにならない。
    const { reader, send } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    await reader.readPrivateKey({ versionStage: 'AWSPENDING' });
    await reader.readPrivateKey({ versionStage: 'AWSPENDING' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('VersionStage 指定の結果が既定のキャッシュを汚染しない', async () => {
    const pending = '-----BEGIN RSA PRIVATE KEY-----\nPENDING\n-----END RSA PRIVATE KEY-----\n';
    const { reader, send } = readerWith((input) =>
      input['VersionStage'] === 'AWSPENDING'
        ? { SecretBinary: binary(pending) }
        : { SecretBinary: binary(PEM) },
    );
    expect(await reader.readPrivateKey({ versionStage: 'AWSPENDING' })).toBe(pending);
    expect(await reader.readPrivateKey()).toBe(PEM);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reader ごとに状態が独立している', async () => {
    const respond = () => ({ SecretBinary: binary(PEM) });
    const a = readerWith(respond);
    const b = readerWith(respond);
    await a.reader.readPrivateKey();
    await b.reader.readPrivateKey();
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it('失敗をキャッシュしない（鍵を投入したら次の呼び出しで通る）', async () => {
    let provisioned = false;
    const { reader, send } = readerWith(() => {
      if (!provisioned) throw new ResourceNotFoundException('empty');
      return { SecretBinary: binary(PEM) };
    });
    await expect(reader.readPrivateKey()).rejects.toBeInstanceOf(KeyNotProvisionedError);
    provisioned = true;
    expect(await reader.readPrivateKey()).toBe(PEM);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('鍵が漏れない', () => {
  const scan = (log: ReturnType<typeof logger>): string =>
    JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);

  it('成功系: ログに PEM が出ない', async () => {
    const { reader, log } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    await reader.readPrivateKey();
    expect(scan(log)).not.toContain('-----BEGIN');
    expect(scan(log)).not.toContain('MIIEowIBAAKCAQEAxxxx');
  });

  it('SDK 例外をラップする経路: 例外にもログにも PEM が出ない', async () => {
    const { reader, log } = readerWith(() => {
      throw new Error(`internal failure while handling ${PEM}`);
    });
    let text = '';
    try {
      await reader.readPrivateKey();
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text).not.toContain('-----BEGIN');
    expect(scan(log)).not.toContain('-----BEGIN');
  });

  it('デコードに失敗する経路: 例外にもログにも中身が出ない', async () => {
    // 不正な UTF-8 を渡す（TextDecoder は fatal:true で投げる）。
    const { reader, log } = readerWith(() => ({ SecretBinary: new Uint8Array([0xff, 0xfe, 0xfd]) }));
    let text = '';
    try {
      await reader.readPrivateKey();
    } catch (error) {
      text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    }
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('�');
    expect(scan(log)).not.toContain('�');
  });

  it('鍵未投入の経路: 例外に PEM が出ない（そもそも無いが形式を固定する）', async () => {
    const { reader, log } = readerWith(() => ({}));
    const error = (await reader.readPrivateKey().catch((e: unknown) => e)) as Error;
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain('-----BEGIN');
    expect(scan(log)).not.toContain('-----BEGIN');
  });

  it('返り値以外の経路で PEM を外に出さない（戻り値だけが鍵の出口）', async () => {
    const { reader, log } = readerWith(() => ({ SecretBinary: binary(PEM) }));
    const before = JSON.stringify(process.env);
    expect(await reader.readPrivateKey()).toBe(PEM);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(scan(log)).not.toContain('-----BEGIN');
  });
});
