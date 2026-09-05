import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAuthorizer } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Deps, Logger } from './deps.ts';
import { createHandler } from './event.ts';
import { createPostPublisher } from './github/commit.ts';
import { createDeployDispatcher } from './github/dispatch.ts';
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

/**
 * 記事をコミットするためのトークン。**contents:write を content repo にだけ。**
 *
 * これがワークフローを起動する権限を持たないことが、権限を分けた目的そのもの。
 */
const contentTokenProvider = createTokenProvider({
  secretReader,
  clientId: config.githubAppClientId,
  owner: config.githubOwner,
  installationRepo: config.githubContentRepo,
  repositories: [config.githubContentRepo],
  permissions: { contents: 'write' },
  logger,
  now: () => Date.now(),
});

/**
 * デプロイを起動するためのトークン。**actions:write を code repo にだけ。**
 *
 * contents を含めない。含めるとこの Lambda がサイトのソースとワークフローを
 * 書き換えられるようになり、分離の利得が消える。
 */
const codeTokenProvider = createTokenProvider({
  secretReader,
  clientId: config.githubAppClientId,
  owner: config.githubOwner,
  installationRepo: config.githubCodeRepo,
  repositories: [config.githubCodeRepo],
  permissions: { actions: 'write' },
  logger,
  now: () => Date.now(),
});

/**
 * **未設定なら作らない。** これが「dispatch は opt-in」の実体。
 *
 * 作らなければ Deps.deployDispatcher が undefined になり、router は
 * dispatch を呼ばないだけでなく、codeTokenProvider を 1 度も使わない
 * ＝ actions:write のトークンを鋳造しない。
 */
const deployDispatcher =
  config.deployWorkflowFile === undefined
    ? undefined
    : createDeployDispatcher({
        tokenProvider: codeTokenProvider,
        owner: config.githubOwner,
        repo: config.githubCodeRepo,
        workflowFile: config.deployWorkflowFile,
        logger,
      });

const deps: Deps = {
  authorizer: createAuthorizer(config.auth, { logger }),
  publisher: createPostPublisher({
    tokenProvider: contentTokenProvider,
    owner: config.githubOwner,
    repo: config.githubContentRepo,
    postsPathPrefix: config.postsPathPrefix,
    logger,
  }),
  presigner: createMediaPresigner({
    bucket: config.mediaBucket,
    region: config.region,
    logger,
    now: () => Date.now(),
  }),
  secretReader,
  // ヘルスチェックが叩くのは記事側。**書き込み経路と同じ資格情報で確認する**
  // ことに意味があるので、権限の広いほうを選ばない。
  tokenProvider: contentTokenProvider,
  logger,
  authMode: config.auth.mode,
  deployDispatcher,
  now: () => Date.now(),
};

export const handler = createHandler((request) => dispatch(request, deps), logger);
