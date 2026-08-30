import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CicdStack } from '../lib/cicd-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';

/**
 * `deploy.yml` が実際に叩く AWS の操作を固定し、**デプロイロールが持つ 6 アクションと
 * 突き合わせる。**
 *
 * ワークフロー側とロール側は別々に正しくても、**組み合わせが噛み合っていないと
 * 実行時にしか分からない。**「無効化の完了を待つために `cloudfront:GetInvalidation` を
 * わざわざ付けたのに、ワークフローが待っていない」も、その逆も、ここで落ちる。
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
  steps?: WorkflowStep[];
}

interface Workflow {
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

const deploy = (): Workflow => loadWorkflow('deploy.yml');
const deployText = (): string => rawWorkflow('deploy.yml');

/**
 * コメントを落とした生テキスト。
 *
 * YAML では `#` が行頭にあるか、空白に続くときコメントを開始する。
 * `${{ ... }}` の中に `#` は現れないので、この単純な規則で式は壊れない。
 */
const deployTextWithoutComments = (): string =>
  deployText()
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

const jobsOf = (workflow: Workflow): Record<string, WorkflowJob> => {
  const jobs = workflow.jobs ?? {};
  expect(Object.keys(jobs).length, 'jobs が 1 つ以上あること').toBeGreaterThan(0);
  return jobs;
};

const allSteps = (): WorkflowStep[] =>
  Object.values(jobsOf(deploy())).flatMap((job) => job.steps ?? []);

const runSteps = (): WorkflowStep[] =>
  allSteps().filter((step) => typeof step.run === 'string');

/**
 * すべての `run` を宣言順に連結したテキスト。
 *
 * **【非空ガード】** これが空だと、以下の「〜が現れない」系の否定アサーションが
 * 全部素通りする。順序の比較も index でこのテキストに対して行う。
 */
const runText = (): string => {
  const steps = runSteps();
  expect(steps.length, 'run を持つステップが 1 つ以上あること').toBeGreaterThan(0);
  const text = steps.map((step) => String(step.run)).join('\n');
  expect(text.trim().length, '連結した run テキストが空でないこと').toBeGreaterThan(0);
  return text;
};

/** `run` に needle を含むステップを返す。 */
const stepsRunning = (needle: string): WorkflowStep[] =>
  runSteps().filter((step) => String(step.run).includes(needle));

/** デプロイロールが実際に持っているアクション（テンプレートから読む）。 */
const grantedActions = (): string[] => {
  const app = new App();
  const site = new SiteStack(app, 'TestSiteStack');
  const template = Template.fromStack(
    new CicdStack(app, 'TestCicdStack', {
      siteBucket: site.siteBucket,
      distribution: site.distribution,
    }),
  );
  const policies = template.findResources('AWS::IAM::Policy');
  expect(Object.keys(policies), 'AWS::IAM::Policy がちょうど 1 個であること').toHaveLength(1);
  const policy = Object.values(policies)[0] as {
    Properties?: { PolicyDocument?: { Statement?: { Action?: string | string[] }[] } };
  };
  const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
  expect(statements.length, 'PolicyDocument.Statement が 1 件以上あること').toBeGreaterThan(0);
  const actions = statements.flatMap((statement) =>
    typeof statement.Action === 'string' ? [statement.Action] : (statement.Action ?? []),
  );
  expect(actions.length, 'アクションが 1 件以上あること').toBeGreaterThan(0);
  return actions;
};

const S3_SYNC = 'aws s3 sync';
const CREATE_INVALIDATION = 'aws cloudfront create-invalidation';
const WAIT_INVALIDATION = 'aws cloudfront wait invalidation-completed';

/** waiter の上限。botocore の cloudfront waiter は delay 20 秒 × maxAttempts 30 回。 */
const WAITER_MAX_MINUTES = (20 * 30) / 60;

/** ビルドと npm ci に見込む余裕（分）。 */
const BUILD_ALLOWANCE_MINUTES = 5;

describe('S3 への publish', () => {
  it('aws s3 sync を実行するステップがちょうど 1 つあり、--delete を含む', () => {
    const steps = stepsRunning(S3_SYNC);
    expect(steps, `${S3_SYNC} のステップ`).toHaveLength(1);
    expect(String(steps[0]?.run)).toContain('--delete');
  });

  it('sync のソースが site/dist である', () => {
    // `npm run -w site build` の出力先。ここを間違えると空のディレクトリを
    // --delete 付きで sync してサイトを消す。
    expect(String(stepsRunning(S3_SYNC)[0]?.run)).toContain('site/dist');
  });

  it('sync の宛先が env 経由の変数参照で、バケット名の直書きでない', () => {
    const run = String(stepsRunning(S3_SYNC)[0]?.run);
    // `s3://$SITE_BUCKET` か `s3://${SITE_BUCKET}` の形であること。
    const match = run.match(/s3:\/\/\$\{?([A-Z_][A-Z0-9_]*)\}?/);
    expect(match, `sync の宛先が変数参照でない: ${run}`).not.toBeNull();

    // 参照している変数がそのステップの env: で定義されていること。
    const name = match?.[1] as string;
    const step = stepsRunning(S3_SYNC)[0] as WorkflowStep;
    expect(Object.keys(step.env ?? {}), `${name} がステップの env にあること`).toContain(name);

    // 物理バケット名の直書きを塞ぐ。スタックを作り直すと変わる名前なので、
    // コードに焼くと「テンプレートは変えていないのに CI が古い宛先を向く」が起きる。
    expect(deployText().toLowerCase()).not.toContain('blogsitestack-');
  });

  it('メディアバケットへ書く宛先が存在しない', () => {
    // 設計判断5: サイト配信用とメディア用でバケットを分けているのは、
    // `sync --delete` がメディアを巻き込んで消すのを防ぐため。
    // ワークフロー側からも塞ぐ。
    for (const destination of deployText().match(/s3:\/\/\S*/g) ?? []) {
      expect(destination.toLowerCase(), `メディアらしき宛先: ${destination}`).not.toContain(
        'media',
      );
    }
    expect(runText().toLowerCase()).not.toContain('media');
  });

  it('ロールに無い S3 の操作を呼んでいない', () => {
    // BPA が 4 つとも有効なので ACL 系は常に誤り。cp / mv / get-object は
    // ロールが持っていない（あるいは持つべきでない）操作。
    for (const forbidden of [
      'aws s3 cp',
      'aws s3 mv',
      'aws s3api put-object-acl',
      'aws s3api get-object',
    ]) {
      expect(runText(), `${forbidden} は使わない`).not.toContain(forbidden);
    }
  });
});

describe('CloudFront の無効化と完了待ち', () => {
  it('create-invalidation を --paths /* で実行している', () => {
    const steps = stepsRunning(CREATE_INVALIDATION);
    expect(steps.length, `${CREATE_INVALIDATION} のステップ`).toBeGreaterThan(0);
    const run = String(steps[0]?.run);
    expect(run).toContain('--paths');
    expect(run).toMatch(/--paths\s+'?\/\*'?/);
  });

  it('無効化の完了を待っており、待ちは作成より後にある', () => {
    const text = runText();
    const createAt = text.indexOf(CREATE_INVALIDATION);
    const waitAt = text.indexOf(WAIT_INVALIDATION);
    expect(createAt, `${CREATE_INVALIDATION} があること`).toBeGreaterThan(-1);
    expect(waitAt, `${WAIT_INVALIDATION} があること`).toBeGreaterThan(-1);
    expect(waitAt, '完了待ちは作成より後に書くこと').toBeGreaterThan(createAt);
  });

  it('sync が create-invalidation より前にある', () => {
    // 先に無効化すると、無効化が伝播していく最中に、まだ古いオブジェクトを
    // 返しているオリジンからキャッシュが再充填される。
    const text = runText();
    const syncAt = text.indexOf(S3_SYNC);
    const createAt = text.indexOf(CREATE_INVALIDATION);
    expect(syncAt, `${S3_SYNC} があること`).toBeGreaterThan(-1);
    expect(syncAt, 'sync は無効化より先に書くこと').toBeLessThan(createAt);
  });
});

describe('ワークフローの操作とロールの権限の対応', () => {
  it('完了待ちを使っているので cloudfront:GetInvalidation が付与されている', () => {
    // **含意ではなく、前件そのものも主張する。** 前件だけを条件にすると、
    // 待ちを消したときにテストが真になって素通りしてしまう。
    // 逆向きにも意味がある: 待たないなら GetInvalidation はロールから削るべきで、
    // 「使わない権限が残っている」ことにここで気づける。
    expect(runText(), '完了待ちを使っていること').toContain(WAIT_INVALIDATION);
    expect(grantedActions()).toContain('cloudfront:GetInvalidation');
  });

  it('create-invalidation に対応する権限がある', () => {
    expect(runText()).toContain(CREATE_INVALIDATION);
    expect(grantedActions()).toContain('cloudfront:CreateInvalidation');
  });

  it('sync --delete に対応する S3 権限が揃っている', () => {
    const text = runText();
    expect(text).toContain(S3_SYNC);
    const actions = grantedActions();
    // ListObjectsV2 でリモートを列挙し、差分を PutObject する。
    expect(actions).toContain('s3:ListBucket');
    expect(actions).toContain('s3:PutObject');
    if (text.includes('--delete')) {
      expect(actions).toContain('s3:DeleteObject');
    }
  });
});

/**
 * デプロイに要る GitHub Actions の変数。**secret ではなく variable。**
 * 3 つとも秘密ではない（漏れても assume は sub 条件で守られる）し、secret にすると
 * ログで *** にマスクされて失敗時の切り分けが無駄に難しくなる。
 */
const REQUIRED_VARIABLES = ['AWS_DEPLOY_ROLE_ARN', 'CLOUDFRONT_DISTRIBUTION_ID', 'SITE_BUCKET'];

describe('変数が未設定でも静かに進まないこと', () => {
  const deployJobSteps = (): WorkflowStep[] => {
    const jobs = jobsOf(deploy());
    const job = Object.values(jobs).find((candidate) =>
      (candidate.steps ?? []).some((step) => String(step.run ?? '').includes(S3_SYNC)),
    );
    expect(job, 'sync を含むジョブが見つかること').toBeDefined();
    const steps = job?.steps ?? [];
    expect(steps.length, 'ステップが 1 つ以上あること').toBeGreaterThan(0);
    return steps;
  };

  const indexOfUses = (prefix: string): number =>
    deployJobSteps().findIndex(
      (step) => typeof step.uses === 'string' && step.uses.startsWith(prefix),
    );

  it('最初の run を持つステップが 3 つの変数名をすべて名指ししている', () => {
    // `${{ vars.X }}` は**未設定でも空文字に展開されるだけでエラーにならない。**
    // 何もしないと npm ci とビルドを終えたあとに、意味不明な形で落ちる。
    const steps = deployJobSteps();
    const firstRunAt = steps.findIndex((step) => typeof step.run === 'string');
    expect(firstRunAt, 'run を持つステップがあること').toBeGreaterThan(-1);
    const guard = String(steps[firstRunAt]?.run);
    for (const name of REQUIRED_VARIABLES) {
      expect(guard, `preflight ガードが ${name} を名指ししていること`).toContain(name);
    }
  });

  it('ガードが checkout と configure-aws-credentials より前にある', () => {
    // 変数が無いなら 10 秒で落とす。npm ci とビルドを終えてから落ちる意味が無い。
    const steps = deployJobSteps();
    const firstRunAt = steps.findIndex((step) => typeof step.run === 'string');
    const checkoutAt = indexOfUses('actions/checkout@');
    const credentialsAt = indexOfUses('aws-actions/configure-aws-credentials@');
    expect(checkoutAt, 'checkout のステップがあること').toBeGreaterThan(-1);
    expect(credentialsAt, 'configure-aws-credentials のステップがあること').toBeGreaterThan(-1);
    expect(firstRunAt, 'ガードは checkout より前').toBeLessThan(checkoutAt);
    expect(firstRunAt, 'ガードは資格情報の取得より前').toBeLessThan(credentialsAt);
  });

  it('参照している vars. の集合がちょうどその 3 つと一致する', () => {
    // **変数を 1 つ増やしてガードを更新し忘れる、を機械的に落とす。**
    //
    // **ここだけはコメントを除いてから走査する。** 問うているのは
    // 「ワークフローが実際に消費する変数はどれか」であって、それは式の話で
    // 散文の話ではない。実際 deploy.yml には「SITE_URL を Actions 変数に**しない**
    // 理由」を説明するコメントがあり、そこに `vars.SITE_URL` という文字列が現れる。
    // 除外しないと、危険を文書化した文章そのものでテストが落ちる。
    //
    // 一方、アカウント ID / ARN / 静的鍵の漏洩検査は**コメントも含めて**見る
    // （public リポジトリではコメントに書いた ID も等しく漏れるため）。
    const referenced = new Set<string>();
    for (const match of deployTextWithoutComments().matchAll(/vars\.([A-Z_][A-Z0-9_]*)/g)) {
      referenced.add(match[1] as string);
    }
    expect([...referenced].sort()).toEqual([...REQUIRED_VARIABLES].sort());
  });

  it('secrets. を 1 度も参照していない', () => {
    expect(deployText()).not.toContain('secrets.');
  });
});

describe('デプロイジョブの設定', () => {
  it('aws-region が ap-northeast-1 である', () => {
    const steps = allSteps().filter((step) => step.with?.['aws-region'] !== undefined);
    expect(steps.length, 'aws-region を指定するステップがあること').toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.with?.['aws-region']).toBe('ap-northeast-1');
    }
  });

  it('timeout-minutes が waiter の上限とビルド時間の和より大きい', () => {
    // waiter が 600 秒粘ってからエラーを返すより先にジョブが切られると、
    // 「無効化は走っているのにワークフローは失敗」という読みにくい失敗になる。
    const jobs = jobsOf(deploy());
    const deployJob = Object.values(jobs).find((job) =>
      (job.steps ?? []).some((step) => String(step.run ?? '').includes(S3_SYNC)),
    );
    expect(deployJob, 'sync を含むジョブが見つかること').toBeDefined();
    const timeout = deployJob?.['timeout-minutes'];
    expect(typeof timeout).toBe('number');
    expect(timeout as number).toBeGreaterThan(WAITER_MAX_MINUTES + BUILD_ALLOWANCE_MINUTES);
  });
});
