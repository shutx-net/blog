import type { DeployDispatcher, InstallationTokenProvider, Logger } from '../deps.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION } from './token.ts';

/**
 * dispatch する ref。
 *
 * **commit.ts の TARGET_BRANCH と同じ理由で main 固定。** ここで送った ref が
 * そのまま実行時の GITHUB_REF になるので、OIDC の sub は
 * `...:ref:refs/heads/main` になり、infra/lib/cicd-stack.ts の DEPLOY_SUBJECT と
 * 一致する。別のブランチを送ると assume role が拒否され、ワークフローは
 * 起動したうえで AWS 認証だけが落ちる。
 */
export const DISPATCH_REF = 'main';

export interface DeployDispatcherDeps {
  /** **actions:write のトークン。** 記事コミット用（contents:write）とは別物。 */
  tokenProvider: InstallationTokenProvider;
  owner: string;
  /** ワークフローがあるリポジトリ。記事リポジトリではない。 */
  repo: string;
  /** 起動するワークフローのファイル名（例 'deploy.yml'）。 */
  workflowFile: string;
  logger: Logger;
}

/**
 * デプロイのワークフローを起動する。
 *
 * 記事を blog-content にコミットしても、code repo には push が起きないので
 * `on: push` は発火しない。**このモジュールが唯一のデプロイ起動経路になる。**
 *
 * docs: "Create a workflow dispatch event" — 成功は 204 No Content。
 * 必要な権限は fine-grained の Actions: write。
 */
export const createDeployDispatcher = (deps: DeployDispatcherDeps): DeployDispatcher => {
  // ファイル名は URL の path segment に入る。設定ミスでパス片が混ざったとき、
  // 別のエンドポイントに化けさせない。
  const url = `${GITHUB_API_BASE}/repos/${deps.owner}/${deps.repo}/actions/workflows/${encodeURIComponent(deps.workflowFile)}/dispatches`;

  const dispatch = async (): Promise<void> => {
    const token = await deps.tokenProvider.getToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: DISPATCH_REF }),
      });
    } catch (error) {
      // **元の例外を素通ししない**（token.ts と同じ規律）。fetch の例外メッセージには
      // URL が載り、実装によってはヘッダの一部も載る。名前だけを転記する。
      throw new Error(`GitHub workflow dispatch failed (${(error as Error).name})`);
    }

    // **204 ちょうどを要求する。** docs の Response は 204 のみで、他の 2xx が返るのは
    // 想定外の経路。`response.ok` で通すと「起動した」と言い切れないまま成功を返す。
    if (response.status !== 204) {
      // **本文を読まない。** 応答が要求をエコーする実装に変わったとき、
      // トークンが例外経由で漏れる。status だけを転記する。
      throw new Error(`GitHub workflow dispatch failed with status ${response.status}`);
    }

    // **トークンもワークフローの内容も出さない。** 起動した事実だけを残す。
    deps.logger.info('dispatched deploy workflow', {
      repo: `${deps.owner}/${deps.repo}`,
      workflowFile: deps.workflowFile,
      ref: DISPATCH_REF,
    });
  };

  return { dispatch };
};
