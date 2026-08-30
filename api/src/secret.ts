import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Logger, SecretReader, SecretVersionOptions } from './deps.ts';

/**
 * 鍵がまだ投入されていないときに投げる。
 *
 * **本フェーズの既定状態がこれである。** CDK は値の無い（バージョンが 1 つも無い）
 * シークレットを作るので、GetSecretValue は ResourceNotFoundException を返す。
 * ルータはこれを 503 にマップする — 設定漏れであって、呼び出し側の誤りではない。
 */
export class KeyNotProvisionedError extends Error {
  constructor() {
    super(
      'GitHub App private key has not been provisioned; run aws secretsmanager put-secret-value against the secret named by the GitHubAppSecretName output',
    );
    this.name = 'KeyNotProvisionedError';
  }
}

export interface SecretReaderDeps {
  client: SecretsManagerClient;
  /** Secrets Manager の ARN か名前。CDK の CfnOutput から環境変数で渡ってくる。 */
  secretId: string;
  logger: Logger;
}

/**
 * 秘密鍵の読み出し器を作る。
 *
 * 設計判断9（保管するのは秘密鍵だけ）はここで完結する。PEM は実行環境のメモリに
 * だけ乗り、/tmp にも環境変数にも書かない。
 */
export const createSecretReader = (deps: SecretReaderDeps): SecretReader => {
  let cached: string | undefined;

  const readPrivateKey = async (options?: SecretVersionOptions): Promise<string> => {
    // **VersionStage を明示したときはキャッシュを使わない。** 鍵ローテーションの
    // 検証（DEVELOPERS.md 手順 2）で古い値が返ると、検証したことにならない。
    const versionStage = options?.versionStage;
    if (versionStage === undefined && cached !== undefined) return cached;

    // VersionStage を **渡さない**のが既定。AWS の既定で AWSCURRENT が返る。
    const input =
      versionStage === undefined
        ? { SecretId: deps.secretId }
        : { SecretId: deps.secretId, VersionStage: versionStage };

    let response: { SecretBinary?: Uint8Array; SecretString?: string };
    try {
      response = (await deps.client.send(new GetSecretValueCommand(input))) as {
        SecretBinary?: Uint8Array;
        SecretString?: string;
      };
    } catch (error) {
      const name = (error as Error).name;
      // 値が 1 つも無いシークレットは「見つからない」と同じ扱いで返ってくる。
      if (name === 'ResourceNotFoundException') throw new KeyNotProvisionedError();
      // **元の例外を素通ししない。** SDK の例外はリクエスト内容を含みうる。
      throw new Error(`failed to read GitHub App private key (${name})`);
    }

    let pem: string | undefined;
    if (response.SecretBinary !== undefined) {
      // DEVELOPERS.md の投入手順が --secret-binary なので、こちらが本線。
      try {
        pem = new TextDecoder('utf-8', { fatal: true }).decode(response.SecretBinary);
      } catch {
        // **デコード失敗の元例外も中身も出さない。** 壊れたバイト列そのものが
        // 鍵の断片でありうる。
        throw new Error('GitHub App private key is not valid UTF-8');
      }
    } else if (response.SecretString !== undefined && response.SecretString.length > 0) {
      // コンソールから貼った運用者を救う。
      pem = response.SecretString;
    }

    if (pem === undefined || pem.length === 0) throw new KeyNotProvisionedError();

    // **鍵そのものはログに出さない。** 長さすら出す必要がない。
    deps.logger.info('loaded GitHub App private key', {
      versionStage: versionStage ?? 'AWSCURRENT',
    });
    if (versionStage === undefined) cached = pem;
    return pem;
  };

  return { readPrivateKey };
};
