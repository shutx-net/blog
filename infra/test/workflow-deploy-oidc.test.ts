import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEPLOY_SUBJECT,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_REPOSITORY,
} from '../lib/cicd-stack.ts';

/**
 * `.github/workflows/deploy.yml` が OIDC の契約を満たしていることを固定する。
 *
 * **このファイルが本フェーズで一番価値がある。** ここで捕まえる誤りはどれも YAML として
 * 完全に妥当で、lint も schema も通り、**実際にワークフローが走って
 * `Not authorized to perform sts:AssumeRoleWithWebIdentity` が出るまで誰も気づかない。**
 * しかも失敗するのは main への push のとき、つまり本番デプロイのときだけである。
 *
 * 期待値は可能なかぎり `lib/cicd-stack.ts` の `DEPLOY_SUBJECT` から**導出**する。
 * 定数を書き換えたら YAML も直さないと落ちる、という双方向の結合を作るのが狙い。
 * 同時にリテラルとも比較する（定数だけで比較すると、定数を緩めたときテストが一緒に動く）。
 */

interface WorkflowStep {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  'runs-on'?: unknown;
  'timeout-minutes'?: unknown;
  permissions?: unknown;
  environment?: unknown;
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

interface Workflow {
  name?: unknown;
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = (name: string): string =>
  fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url));

const loadWorkflow = (name: string): Workflow => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} が存在すること`).toBe(true);
  return parse(readFileSync(path, 'utf8')) as Workflow;
};

const rawWorkflow = (name: string): string => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} が存在すること`).toBe(true);
  return readFileSync(path, 'utf8');
};

const SHA_PINNED_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

/** aws-actions/configure-aws-credentials の action 名（バージョンは SHA でピンする）。 */
const CONFIGURE_CREDENTIALS = 'aws-actions/configure-aws-credentials@';

const deploy = (): Workflow => loadWorkflow('deploy.yml');
const deployText = (): string => rawWorkflow('deploy.yml');

const jobsOf = (workflow: Workflow): Record<string, WorkflowJob> => {
  const jobs = workflow.jobs ?? {};
  expect(Object.keys(jobs).length, 'jobs が 1 つ以上あること').toBeGreaterThan(0);
  return jobs;
};

const stepsOf = (job: WorkflowJob | undefined): WorkflowStep[] => {
  const steps = job?.steps ?? [];
  expect(Array.isArray(steps), 'steps が配列であること').toBe(true);
  return steps;
};

const allStepsOf = (workflow: Workflow): WorkflowStep[] =>
  Object.values(jobsOf(workflow)).flatMap((job) => stepsOf(job));

const allUsesOf = (workflow: Workflow): string[] =>
  allStepsOf(workflow)
    .map((step) => step.uses)
    .filter((uses): uses is string => typeof uses === 'string');

const allRunsOf = (workflow: Workflow): string[] =>
  allStepsOf(workflow)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string');

/**
 * configure-aws-credentials のステップと、それが属するジョブを特定する。
 *
 * **これは非空ガードである。** これが無いと以降の「そのジョブの permissions」系の
 * アサーションが 0 件で素通りする（Phase 1-2 で 7 件塞いだのと同じ形）。
 */
const credentialsStepAndJob = (): { job: WorkflowJob; jobName: string; step: WorkflowStep } => {
  const found: { job: WorkflowJob; jobName: string; step: WorkflowStep }[] = [];
  for (const [jobName, job] of Object.entries(jobsOf(deploy()))) {
    for (const step of stepsOf(job)) {
      if (typeof step.uses === 'string' && step.uses.startsWith(CONFIGURE_CREDENTIALS)) {
        found.push({ job, jobName, step });
      }
    }
  }
  expect(found.length, `${CONFIGURE_CREDENTIALS}… を使うステップがちょうど 1 つあること`).toBe(1);
  return found[0] as { job: WorkflowJob; jobName: string; step: WorkflowStep };
};

/** `uses:` を含む行を落とした生テキスト。 */
const deployTextWithoutUses = (): string =>
  deployText()
    .split('\n')
    .filter((line) => !line.includes('uses:'))
    .join('\n');

/**
 * `DEPLOY_SUBJECT` から、信頼しているブランチを導出する。
 * 'repo:shutx-net@169037737/blog@1351152011:ref:refs/heads/main' → 'main'
 */
const REF_MARKER = ':ref:refs/heads/';

const trustedBranch = (): string => {
  const markerAt = DEPLOY_SUBJECT.indexOf(REF_MARKER);
  expect(markerAt, 'DEPLOY_SUBJECT が ref 形式であること').toBeGreaterThan(0);
  return DEPLOY_SUBJECT.slice(markerAt + REF_MARKER.length);
};

describe('deploy.yml の非空ガード', () => {
  it('ファイルが存在し、パースでき、jobs が 1 つ以上ある', () => {
    expect(existsSync(workflowPath('deploy.yml'))).toBe(true);
    const workflow = deploy();
    expect(workflow).not.toBeNull();
    expect(Array.isArray(workflow)).toBe(false);
    expect(Object.keys(jobsOf(workflow)).length).toBeGreaterThan(0);
  });

  it('configure-aws-credentials を使うステップがちょうど 1 つあり、属するジョブが分かる', () => {
    const { jobName, step } = credentialsStepAndJob();
    expect(jobName.length).toBeGreaterThan(0);
    expect(String(step.uses).startsWith(CONFIGURE_CREDENTIALS)).toBe(true);
  });
});

describe('sub 契約 — トリガと ref', () => {
  it('on のキー集合が push と workflow_dispatch ちょうど 2 つ', () => {
    // pull_request を足すと sub が `...:pull_request` になって assume が落ちる。
    // pull_request_target / schedule / release も同時に禁止される。
    // workflow_dispatch を許すのは、パスフィルタで飛ばされたあとの再デプロイや
    // invalidation のやり直しを、空コミットを積まずにできるようにするため。
    expect(Object.keys(deploy().on ?? {}).sort()).toEqual(['push', 'workflow_dispatch']);
  });

  it('on.push.branches が DEPLOY_SUBJECT から導いたブランチちょうど 1 つと深く一致する', () => {
    const branch = trustedBranch();
    // 定数を緩めたときテストが一緒に動かないよう、リテラルとも比較する。
    expect(branch, 'DEPLOY_SUBJECT が信頼するブランチ').toBe('main');

    const push = deploy().on?.['push'] as { branches?: unknown } | undefined;
    expect(push, 'on.push があること').toBeDefined();
    expect(push?.branches).toEqual([branch]);
    expect(push?.branches).toEqual(['main']);
  });

  it('on.push に tags キーが無い', () => {
    // タグ push は sub が `ref:refs/tags/...` になって assume が落ちる。
    // GitHub のドキュメントは "Path filters are not evaluated for pushes of tags" とも
    // 言っており、step 3.7 のパスフィルタもすり抜ける。
    const push = (deploy().on?.['push'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(push)).not.toContain('tags');
    expect(Object.keys(push)).not.toContain('tags-ignore');
  });

  it('どのジョブにも environment キーが無い', () => {
    // GitHub の優先順位は environment > pull_request > ref なので、environment を
    // 付けた瞬間 sub は `...:environment:<name>` になって assume が落ちる。
    const jobs = jobsOf(deploy());
    for (const [name, job] of Object.entries(jobs)) {
      expect('environment' in job, `${name} ジョブに environment がある`).toBe(false);
    }
    // 構造の走査から漏れた場所（未知のネストなど）も、キーとして現れる形を行頭から塞ぐ。
    // **単純な部分一致にはしない。** それだと `...:environment:<name>` と書いた
    // 解説コメントで落ちてしまい、この危険そのものを文書化できなくなる。
    // 偽陽性で落ちるテストは、消されるか無視されるかのどちらかで終わる。
    // コメント行は `#` で始まるのでこの正規表現には当たらず、当たった瞬間に
    // 本物のキーになる（＝構造側のアサーションも同時に落ちる）。
    expect(deployText(), 'environment がキーとして現れている').not.toMatch(
      /^\s*environment\s*:/m,
    );
  });

  it('DEPLOY_SUBJECT の repo セグメントが GITHUB_REPOSITORY と整合する', () => {
    // ロールの契約が別リポジトリを向いていないことを、ワークフロー側のテストからも押さえる。
    const parts = DEPLOY_SUBJECT.split(':');
    expect(parts[0]).toBe('repo');
    const ownerAndRepo = String(parts[1]).split('/');
    expect(ownerAndRepo).toHaveLength(2);
    // immutable 形式の `<name>@<id>` から名前だけを取り出す。
    const names = ownerAndRepo.map((segment) => segment.split('@')[0]).join('/');
    expect(names).toBe(GITHUB_REPOSITORY);
    expect(names).toBe('shutx-net/blog');
  });
});

describe('sub 契約 — 権限', () => {
  it('資格情報を取るジョブの permissions が id-token: write と contents: read ちょうど 2 つ', () => {
    // **キー集合の完全一致にするのは、余計な write 権限（packages / pull-requests など）を
    // 後から足されないようにするため。**
    const { job, jobName } = credentialsStepAndJob();
    const permissions = job.permissions as Record<string, unknown> | undefined;
    expect(permissions, `${jobName} ジョブに permissions があること`).toBeDefined();
    expect(Object.keys(permissions ?? {}).sort()).toEqual(['contents', 'id-token']);
    expect(permissions?.['id-token']).toBe('write');
    expect(permissions?.['contents']).toBe('read');
  });

  it('トップレベル permissions が空オブジェクトである', () => {
    const permissions = deploy().permissions;
    expect(permissions, 'permissions が書かれていること').toBeDefined();
    expect(permissions).not.toBeNull();
    expect(typeof permissions).toBe('object');
    expect(Object.keys(permissions as Record<string, unknown>)).toEqual([]);
  });
});

describe('アカウント ID と静的鍵の漏洩', () => {
  it('生テキストに 12 桁連続の数字が 1 つも無い', () => {
    // **`uses:` の行は除外してから検査する。** 40 桁の 16 進 SHA には数字だけが
    // 12 桁続く並びが現れ得る（SHA を 3 つも書けば偽陽性は現実的に起きる）。
    // **偽陽性で落ちるテストは、消されるか無視されるかのどちらかで終わる。**
    const text = deployTextWithoutUses();
    expect(text.length, '除外後のテキストが空でないこと').toBeGreaterThan(0);
    const match = text.match(/(?<!\d)\d{12}(?!\d)/);
    expect(match, `12 桁の数字（AWS アカウント ID か）が現れている: ${match?.[0] ?? ''}`).toBeNull();
  });

  it('生テキストに ARN が現れない', () => {
    for (const needle of ['arn:aws:iam::', 'arn:aws:s3:::', 'arn:aws:cloudfront::']) {
      expect(deployText(), `${needle} を書かないこと`).not.toContain(needle);
    }
  });

  it('生テキストに静的なアクセスキーの名前が現れない', () => {
    for (const needle of [
      'aws-access-key-id',
      'aws-secret-access-key',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(deployText(), `${needle} を書かないこと`).not.toContain(needle);
    }
  });
});

describe('configure-aws-credentials の入力', () => {
  it('audience が未指定か、指定するなら GITHUB_OIDC_AUDIENCE と一致する', () => {
    // OIDCProvider の ClientIdList は 1 件しか無いので、ここがずれると assume が落ちる。
    const { step } = credentialsStepAndJob();
    const audience = step.with?.['audience'];
    if (audience !== undefined) {
      expect(audience).toBe(GITHUB_OIDC_AUDIENCE);
      expect(audience).toBe('sts.amazonaws.com');
    }
  });

  it('role-to-assume が vars.AWS_DEPLOY_ROLE_ARN そのものである', () => {
    // secrets ではなく vars。ARN は秘密ではないが、public リポジトリに直書きすると
    // AWS アカウント ID が漏れる。secret にするとログで *** にマスクされて
    // 失敗時の切り分けが無駄に難しくなる。
    const { step } = credentialsStepAndJob();
    expect(step.with?.['role-to-assume']).toBe('${{ vars.AWS_DEPLOY_ROLE_ARN }}');
  });
});

describe('パスフィルタ — infra だけの変更でサイトを再デプロイしない', () => {
  const pushPaths = (): string[] => {
    const push = (deploy().on?.['push'] ?? {}) as { paths?: unknown };
    expect(Array.isArray(push.paths), 'on.push.paths が配列であること').toBe(true);
    const paths = push.paths as string[];
    expect(paths.length, 'paths が 1 つ以上あること').toBeGreaterThan(0);
    return paths;
  };

  it('site/** を含む', () => {
    expect(pushPaths()).toContain('site/**');
  });

  it('package.json と package-lock.json を含む', () => {
    // 依存を上げるとビルド成果物が変わるので再デプロイが要る。
    expect(pushPaths()).toContain('package.json');
    expect(pushPaths()).toContain('package-lock.json');
  });

  it('.github/workflows/deploy.yml 自身を含む', () => {
    // SITE_URL を直書きしている以上、この 1 行の変更がそのまま再デプロイの
    // トリガになるべき。独自ドメインへの移行が「1 行変えた PR をマージする」だけで済む。
    expect(pushPaths()).toContain('.github/workflows/deploy.yml');
  });

  it('infra/** を含まない', () => {
    // 本フェーズの主題の 1 つ。infra だけの変更で再デプロイしても、同じ入力から
    // 同じ出力をビルドして同じものを sync し、5 分待つだけで得るものが無い。
    for (const path of pushPaths()) {
      expect(path.startsWith('infra/'), `infra を対象にしている: ${path}`).toBe(false);
    }
  });

  it('paths-ignore を併用していない', () => {
    // GitHub は同一イベントで paths と paths-ignore の併用を禁じている。
    const push = (deploy().on?.['push'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(push)).not.toContain('paths-ignore');
  });
});

describe('concurrency — sync を二重に走らせない', () => {
  it('deploy の group が式を含まない固定文字列である', () => {
    // `${{ github.ref }}` を混ぜると、main 以外での workflow_dispatch が
    // 別グループになって push と並走しうる。**`aws s3 sync --delete` を
    // 2 本同時に走らせてはならない。**
    const group = deploy().concurrency?.['group'];
    expect(typeof group, 'concurrency.group が文字列であること').toBe('string');
    expect(String(group).includes('${{'), `group に式が入っている: ${String(group)}`).toBe(false);
    expect(String(group).length).toBeGreaterThan(0);
  });

  it('deploy の cancel-in-progress が false である', () => {
    // 走行中の sync を止めてはならない。途中で SIGKILL されると、新旧が混ざった
    // バケットのまま「キャンセルされた」だけが残る（配信バケットはバージョニング無効で
    // 巻き戻せない）。
    expect(deploy().concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('ci と deploy の concurrency.group が互いに異なる', () => {
    // GitHub のドキュメント: "concurrency group names must be unique across workflows
    // to avoid canceling in-progress jobs or runs from other workflows"
    const ciGroup = loadWorkflow('ci.yml').concurrency?.['group'];
    const deployGroup = deploy().concurrency?.['group'];
    expect(typeof ciGroup).toBe('string');
    expect(typeof deployGroup).toBe('string');
    expect(deployGroup).not.toBe(ciGroup);
  });
});

describe('deploy.yml の一般的な硬さ', () => {
  it('すべての uses が 40 桁の commit SHA でピンされている', () => {
    const uses = allUsesOf(deploy());
    expect(uses.length, 'uses が 1 つ以上あること').toBeGreaterThan(0);
    for (const value of uses) {
      expect(value, `${value} はタグやブランチではなく commit SHA でピンすること`).toMatch(
        SHA_PINNED_USES,
      );
    }
  });

  it('どの run にも ${{ }} が現れない', () => {
    const runs = allRunsOf(deploy());
    expect(runs.length, 'run が 1 つ以上あること').toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.includes('${{'), `run に式が埋まっている: ${run}`).toBe(false);
    }
  });

  it('どのジョブの runs-on も -latest で終わらず、timeout-minutes がある', () => {
    for (const [name, job] of Object.entries(jobsOf(deploy()))) {
      const runsOn = job['runs-on'];
      expect(typeof runsOn, `${name} ジョブの runs-on`).toBe('string');
      expect(String(runsOn).endsWith('-latest'), `${name} ジョブの runs-on: ${String(runsOn)}`)
        .toBe(false);
      expect(typeof job['timeout-minutes'], `${name} ジョブの timeout-minutes`).toBe('number');
      expect(job['timeout-minutes'] as number).toBeGreaterThan(0);
    }
  });
});
