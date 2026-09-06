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

/**
 * 失敗の種類。
 *
 * - `transport`: fetch が例外を投げた。**HTTP 応答が無かった**ので、GitHub に
 *   届いたかどうかも分からない
 * - `status`: 応答は来たが 2xx ではなかった。届いて拒否された
 *
 * **この区別が無いと、ログから原因を絞れない。** 実際 2026-09-06 の投稿では
 * 両方の経路が `new Error(...)` を投げていたため、router 側に残った
 * `{ name: 'Error' }` だけではどちらか断定できなかった。
 */
export type DeployDispatchFailureReason = 'transport' | 'status';

export interface DeployDispatchErrorInit {
  reason: DeployDispatchFailureReason;
  /** `reason: 'status'` のときだけ入る。 */
  status?: number;
  /** `reason: 'transport'` のときだけ入る。**元の例外の名前だけ。** */
  transportErrorName?: string;
}

/**
 * dispatch の失敗。
 *
 * **メッセージも構造化フィールドも、応答本文と元の例外メッセージからは作らない。**
 * fetch の例外メッセージには URL が載り、実装によってはヘッダの一部も載る。
 * 応答本文は、要求をエコーする実装に変わったときトークンを含みうる。
 * ここに入れてよいのは、こちらが決めた列挙値と HTTP ステータスだけ。
 */
export class DeployDispatchError extends Error {
  readonly reason: DeployDispatchFailureReason;
  readonly status: number | undefined;
  readonly transportErrorName: string | undefined;

  constructor(init: DeployDispatchErrorInit) {
    super(
      init.reason === 'status'
        ? `GitHub workflow dispatch failed with status ${init.status}`
        : `GitHub workflow dispatch failed (${init.transportErrorName})`,
    );
    this.name = 'DeployDispatchError';
    this.reason = init.reason;
    this.status = init.status;
    this.transportErrorName = init.transportErrorName;
  }
}

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

/** docs の Response はこれだけ。他の 2xx が来たら warn を出す。 */
const EXPECTED_STATUS = 204;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

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
      // **元の例外を素通ししない**（token.ts と同じ規律）。名前だけを転記する。
      throw new DeployDispatchError({
        reason: 'transport',
        transportErrorName: (error as Error).name,
      });
    }

    // **2xx を成功として扱う。204 ちょうどは要求しない。**
    //
    // 以前は 204 ちょうどを要求していたが、2026-09-06 10:47 の投稿で
    // **GitHub が run を作った**（actor=shutx-blog[bot] の workflow_dispatch が
    // 起動し完走してサイトに記事が出た）のに、Lambda はこの分岐で失敗を返した。
    //
    // 偽陰性の代償が大きい: 管理画面が「保存済み・デプロイ未起動」と嘘を表示し、
    // DEVELOPERS.md の復旧手順（gh workflow run）に従うとデプロイが 2 本走る。
    // 「想定外の 2xx を成功と呼ぶ」ほうが、「起動したのに失敗と言う」より害が小さい。
    //
    // **ただし黙って通さない。** 204 以外なら warn に実際のステータスを残す。
    if (!isSuccess(response.status)) {
      // **本文を読まない。** 応答が要求をエコーする実装に変わったとき、
      // トークンが例外経由で漏れる。status だけを転記する。
      throw new DeployDispatchError({ reason: 'status', status: response.status });
    }

    if (response.status !== EXPECTED_STATUS) {
      deps.logger.warn('deploy workflow dispatch returned an unexpected success status', {
        status: response.status,
        expected: EXPECTED_STATUS,
      });
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
