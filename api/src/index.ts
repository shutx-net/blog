import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAuthorizer } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Deps, Logger } from './deps.ts';
import { createHandler } from './event.ts';
import { createPostPublisher } from './github/commit.ts';
import { createTokenProvider } from './github/token.ts';
import { createMediaPresigner } from './media/presign.ts';
import { dispatch } from './router.ts';
import { createSecretReader } from './secret.ts';

/**
 * CloudWatch Logs に出るロガー。
 *
 * **秘密を渡さないことは呼び出し側の責任。** 各モジュールの単体テストが、
 * ここに渡った全引数を走査してトークン・PEM・署名済み URL が含まれないことを
 * 主張している。
 */
const logger: Logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

// ---- コールドスタートで 1 度だけ走る初期化 ----
//
// **設定が不正ならここで throw する。** Lambda はコールドスタートで落ち、
// CloudFront には 502 が返る。環境変数の打ち間違いが「黙って全許可」になるより、
// 目に見えて壊れるほうが良い（AUTH_MODE の設計と同じ思想）。
const config = loadConfig(process.env);

const secretReader = createSecretReader({
  client: new SecretsManagerClient({ region: config.region }),
  secretId: config.githubAppSecretId,
  logger,
});

const tokenProvider = createTokenProvider({
  secretReader,
  clientId: config.githubAppClientId,
  owner: config.githubOwner,
  repo: config.githubRepo,
  logger,
  now: () => Date.now(),
});

const deps: Deps = {
  authorizer: createAuthorizer(config.authMode),
  publisher: createPostPublisher({
    tokenProvider,
    owner: config.githubOwner,
    repo: config.githubRepo,
    logger,
  }),
  presigner: createMediaPresigner({
    bucket: config.mediaBucket,
    region: config.region,
    logger,
    now: () => Date.now(),
  }),
  secretReader,
  tokenProvider,
  logger,
  authMode: config.authMode,
  now: () => Date.now(),
};

export const handler = createHandler((request) => dispatch(request, deps), logger);
