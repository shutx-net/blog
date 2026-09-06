import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** deploy ジョブのステップを宣言順に返す。 */
const deployJobStepsOrdered = (): WorkflowStep[] => {
  const job = Object.values(jobsOf(deploy())).find((candidate) =>
    (candidate.steps ?? []).some((step) => String(step.run ?? '').includes(S3_SYNC)),
  );
  expect(job, 'sync を含むジョブが見つかること').toBeDefined();
  const steps = job?.steps ?? [];
  expect(steps.length, 'ステップが 1 つ以上あること').toBeGreaterThan(0);
  return steps;
};

/** `actions/checkout` を使うステップを宣言順に返す。 */
const checkoutSteps = (): WorkflowStep[] =>
  deployJobStepsOrdered().filter(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
  );

/** 記事リポジトリを取ってくる checkout ステップ。 */
const contentCheckoutStep = (): WorkflowStep => {
  const steps = checkoutSteps().filter((step) => step.with?.repository !== undefined);
  expect(steps, 'repository を指定する checkout がちょうど 1 つあること').toHaveLength(1);
  return steps[0] as WorkflowStep;
};

/**
 * 下限を宣言している run ステップを、その下限つきで返す。
 *
 * **下限はワークフロー内の整数リテラルでなければならない。** ディスクの記事数から
 * 計算する形にすると、記事が 0 本になったとき下限も 0 になって主張が空振りする
 * （`draft-post.md` を消しても既存の leak scan が緑のままだったのと同じ形）。
 */
const guardsWithMinimum = (): { step: WorkflowStep; index: number; minimum: number }[] => {
  const found: { step: WorkflowStep; index: number; minimum: number }[] = [];
  deployJobStepsOrdered().forEach((step, index) => {
    if (typeof step.run !== 'string') return;
    const match = step.run.match(/\bminimum=(\d+)\b/);
    if (match === null) return;
    found.push({ step, index, minimum: Number(match[1]) });
  });
  return found;
};

/** ステップの添字。見つからなければ -1。 */
const indexOfStep = (predicate: (step: WorkflowStep) => boolean): number =>
  deployJobStepsOrdered().findIndex(predicate);

const POSTS_COUNT_GUARD = 'site/src/content/posts';
const RSS_GUARD = 'rss.xml';
const SITE_BUILD = 'npm run -w site build';

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

/** 記事リポジトリ。**private なので checkout に資格情報が要る唯一の相手。** */
const CONTENT_REPOSITORY = 'shutx-net/blog-content';

/**
 * content を展開する先。**`resolvePostsDir` の既定値と一致していなければならない。**
 *
 * 一致させることで本番経路に環境変数が 1 つも増えない。ここがずれると
 * 「ビルドは成功するのに記事が 0 本」という、astro が exit 0 を返す最悪の形になる。
 */
const CONTENT_CHECKOUT_PATH = 'site/src/content/posts';

/** 読み取り専用 deploy key の秘密鍵。 */
const CONTENT_DEPLOY_KEY_SECRET = 'CONTENT_DEPLOY_KEY';

const S3_SYNC = 'aws s3 sync';
const CREATE_INVALIDATION = 'aws cloudfront create-invalidation';
const WAIT_INVALIDATION = 'aws cloudfront wait invalidation-completed';

/** waiter の上限。botocore の cloudfront waiter は delay 20 秒 × maxAttempts 30 回。 */
const WAITER_MAX_MINUTES = (20 * 30) / 60;

/** ビルドと npm ci に見込む余裕（分）。 */
const BUILD_ALLOWANCE_MINUTES = 5;

describe('S3 への publish', () => {
  it('aws s3 sync を実行するステップがちょうど 2 つ（site と admin）ある', () => {
    // **site 側は --exclude 'admin/*' が要る。** 無いとサイトを 1 回デプロイした
    // だけで管理画面が消える。AGENTS.md がメディアを別バケットにした理由と同じ罠で、
    // ここは同一バケットのプレフィックス分離なので、除外の 1 行が唯一の防壁になる。
    const steps = stepsRunning(S3_SYNC).map((step) => String(step.run));
    expect(steps, `${S3_SYNC} のステップ`).toHaveLength(2);

    const site = steps.find((run) => run.includes('site/dist'));
    const admin = steps.find((run) => run.includes('admin/dist'));
    expect(site, 'site/dist を配る sync が無い').toBeDefined();
    expect(admin, 'admin/dist を配る sync が無い').toBeDefined();

    for (const run of steps) expect(run).toContain('--delete');

    expect(
      site,
      "site の sync に --exclude 'admin/*' が無い。1 回デプロイすると管理画面が消える",
    ).toContain("--exclude 'admin/*'");

    // admin 側は admin/ プレフィックス配下にしか --delete を効かせない。
    expect(admin).toContain('/admin');
    expect(admin, 'admin の sync がサイト本体まで消しうる').not.toContain("--exclude");
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

  it('参照している secrets. がちょうど CONTENT_DEPLOY_KEY の 1 つだけである', () => {
    // **旧テストは「secrets. を 1 度も参照していない」だった。** private な記事
    // リポジトリを checkout する以上 secret は不可避なので、意図的に置き換えている。
    //
    // **主張の core は「secret がゼロ」ではなく「AWS の静的な資格情報を持ち込まない」。**
    // OIDC で assume する設計を守ることが目的で、読み取り専用の deploy key 1 本は
    // それと矛盾しない。だから「どの secret か」まで固定する。
    //
    // **コメントを除いてから走査する。** 旧テストは生テキスト判定だったので、
    // 「secrets. を使わない理由」を説明するコメントを書いた瞬間に落ちるという罠が
    // あった（GitHub の式をコメントに書いて 422 になった過去の事故と同型）。
    const referenced = new Set<string>();
    for (const match of deployTextWithoutComments().matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)) {
      referenced.add(match[1] as string);
    }
    expect([...referenced].sort()).toEqual([CONTENT_DEPLOY_KEY_SECRET]);
  });

  it('その secret は content checkout の ssh-key としてのみ使われる', () => {
    // 「1 つだけ」を満たしたまま別の場所（run の env など）に配ると、
    // 鍵がビルドスクリプトから読める。使い道まで固定する。
    const expression = `secrets.${CONTENT_DEPLOY_KEY_SECRET}`;
    const occurrences = deployTextWithoutComments().split(expression).length - 1;
    expect(occurrences, `${expression} の出現回数`).toBe(1);

    const sshKey = String(contentCheckoutStep().with?.['ssh-key'] ?? '');
    expect(sshKey, 'content checkout の ssh-key が secret を参照していること').toContain(
      expression,
    );
  });

  it('AWS の静的な資格情報を持ち込んでいない（コメントも含めて走査する）', () => {
    // 旧テストが本当に守っていたもの。secret を 1 つ許した今こそ明示的に残す。
    // **public リポジトリではコメントに書いた値も等しく漏れる**ので、
    // ここは vars. の集合検査と違ってコメントを落とさない。
    const text = deployText();
    for (const forbidden of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'aws_access_key_id',
      'aws_secret_access_key',
    ]) {
      expect(text, `${forbidden} を持ち込まない。assume は OIDC で行う`).not.toContain(forbidden);
    }
  });
});

describe('記事リポジトリの checkout', () => {
  it('content repo を checkout するステップがちょうど 1 つあり、pin された actions/checkout である', () => {
    const step = contentCheckoutStep();
    expect(step.with?.repository, 'checkout する記事リポジトリ').toBe(CONTENT_REPOSITORY);
    // **SHA pin。** タグは動かせるので、`@v7` では「同じ YAML なのに別のコードが走る」。
    expect(String(step.uses), 'checkout が SHA で pin されていること').toMatch(
      /^actions\/checkout@[0-9a-f]{40}\b/,
    );
  });

  it('code repo 側の checkout も残っていて、checkout がちょうど 2 つある', () => {
    // **含意ではなく前件も主張する。** content 側だけになっていたら、
    // ワークフロー自身のソースが無い状態でビルドしようとすることになる。
    const steps = checkoutSteps();
    expect(steps, 'checkout のステップ数（code repo と content repo）').toHaveLength(2);
    const withoutRepository = steps.filter((step) => step.with?.repository === undefined);
    expect(withoutRepository, 'repository 未指定の checkout（= このリポジトリ）').toHaveLength(1);
  });

  it('content を既定の posts ディレクトリへ直接展開している', () => {
    // **本番は POSTS_DIR を設定せず、既定値がそのまま正解になるようにする。**
    // 「env を書き忘れたら空サイト」という経路を新設しない。
    expect(contentCheckoutStep().with?.path).toBe(CONTENT_CHECKOUT_PATH);
  });

  it('deploy.yml が POSTS_DIR を設定していない', () => {
    // 上の設計判断の裏返し。設定した瞬間、既定値が正解であるという前提が崩れる。
    expect(deployTextWithoutComments()).not.toContain('POSTS_DIR');
  });

  it('content checkout が persist-credentials: false である', () => {
    // ビルド以降の工程に git の資格情報を残さない。**既定は true。**
    expect(contentCheckoutStep().with?.['persist-credentials']).toBe(false);
  });
});

describe('記事が消えたままデプロイされないこと', () => {
  it('記事本数のガードがあり、下限が 1 以上の整数リテラルである', () => {
    // **このフェーズで最も重要な 1 本。**
    //
    // astro は base ディレクトリが無くても、パターンに 1 件もマッチしなくても
    // **warn を出して return するだけで throw しない**（glob.js:186-198, astro 7.2.9）。
    // ビルドは exit 0 で成功し、記事 0 本のサイトが `aws s3 sync --delete` で
    // publish されて全記事が消える。ビルドの成否では検知できない。
    const guards = guardsWithMinimum();
    expect(guards.length, '下限を宣言する run ステップがあること').toBeGreaterThan(0);
    for (const guard of guards) {
      expect(
        guard.minimum,
        `下限が 1 以上であること（0 にすると空 checkout を素通しする）: ${String(guard.step.name)}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('ビルド前に記事本数を数えるガードがある', () => {
    const guards = guardsWithMinimum().filter((guard) =>
      String(guard.step.run).includes(POSTS_COUNT_GUARD),
    );
    expect(guards, `${POSTS_COUNT_GUARD} を数えるガード`).toHaveLength(1);
  });

  it('そのガードが content checkout より後、site build より前にある', () => {
    const guard = guardsWithMinimum().find((candidate) =>
      String(candidate.step.run).includes(POSTS_COUNT_GUARD),
    );
    expect(guard, '記事本数のガードがあること').toBeDefined();

    const checkoutAt = indexOfStep((step) => step.with?.repository === CONTENT_REPOSITORY);
    const buildAt = indexOfStep((step) => String(step.run ?? '').includes(SITE_BUILD));
    expect(checkoutAt, 'content checkout があること').toBeGreaterThan(-1);
    expect(buildAt, 'site build があること').toBeGreaterThan(-1);
    expect(guard?.index as number, 'ガードは content checkout より後').toBeGreaterThan(checkoutAt);
    expect(guard?.index as number, 'ガードは site build より前').toBeLessThan(buildAt);
  });

  it('記事本数のガードは最初の run ステップではない', () => {
    // 最初の run は変数の preflight ガードでなければならない（別テストが固定している）。
    // 押しのけていないことを明示的に主張する。
    const steps = deployJobStepsOrdered();
    const firstRunAt = steps.findIndex((step) => typeof step.run === 'string');
    const guard = guardsWithMinimum().find((candidate) =>
      String(candidate.step.run).includes(POSTS_COUNT_GUARD),
    );
    expect(guard, '記事本数のガードがあること').toBeDefined();
    expect(guard?.index).not.toBe(firstRunAt);
  });

  it('ビルド後・sync 前に rss.xml の item 数を検証している', () => {
    // **二重の砦。** RSS の配信だけは取り消せない（購読者側に届いたら戻せない）。
    // ビルド前のガードが何かの理由ですり抜けても、ここで止まる。
    const guard = guardsWithMinimum().find((candidate) =>
      String(candidate.step.run).includes(RSS_GUARD),
    );
    expect(guard, 'rss.xml を検証するガードがあること').toBeDefined();
    expect(String(guard?.step.run), 'item を数えていること').toContain('<item');

    const buildAt = indexOfStep((step) => String(step.run ?? '').includes(SITE_BUILD));
    const syncAt = indexOfStep((step) => String(step.run ?? '').includes(S3_SYNC));
    expect(syncAt, 'sync があること').toBeGreaterThan(-1);
    expect(guard?.index as number, 'rss の検証はビルドより後').toBeGreaterThan(buildAt);
    expect(guard?.index as number, 'rss の検証は sync より前').toBeLessThan(syncAt);
  });

  it('2 つのガードが同じ下限を使っている', () => {
    // 片方だけ下げると、もう片方が先に落ちて理由の分かりにくい失敗になる。
    const minimums = new Set(guardsWithMinimum().map((guard) => guard.minimum));
    expect([...minimums], 'ガードごとに下限がばらけている').toHaveLength(1);
  });
});

/**
 * ガードの run スクリプトを**実際に実行する**ためのヘルパ。
 *
 * テキスト一致だけでは、シェルの意味論を間違えたガードを止められない。
 * 実際 `grep -c` は一致した「行数」を返すので、改行を含まない rss.xml に対しては
 * item が何本あっても 1 になり、**記事の本数によらず必ず落ちるガード**になっていた。
 * 文字列比較では素通りするが、走らせれば一発で分かる。
 */
const runGuardScript = (script: string, cwd: string): { status: number; output: string } => {
  const result = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

/** 一時ディレクトリを作り、f に渡して、後始末する。 */
const withTempDir = (f: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
  try {
    f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const postsGuardScript = (): string => {
  const guard = guardsWithMinimum().find((candidate) =>
    String(candidate.step.run).includes(POSTS_COUNT_GUARD),
  );
  expect(guard, '記事本数のガードがあること').toBeDefined();
  return String(guard?.step.run);
};

const rssGuardScript = (): string => {
  const guard = guardsWithMinimum().find((candidate) =>
    String(candidate.step.run).includes(RSS_GUARD),
  );
  expect(guard, 'rss のガードがあること').toBeDefined();
  return String(guard?.step.run);
};

/** 下限。ガード自身が宣言している値を読む（テストに二重に書かない）。 */
const declaredMinimum = (): number => {
  const minimums = new Set(guardsWithMinimum().map((guard) => guard.minimum));
  expect([...minimums], '下限が 1 つに揃っていること').toHaveLength(1);
  return [...minimums][0] as number;
};

describe('ガードを実際に走らせる', () => {
  it('記事が下限ちょうどあれば通る', () => {
    withTempDir((dir) => {
      const posts = join(dir, 'site/src/content/posts');
      mkdirSync(posts, { recursive: true });
      for (let i = 0; i < declaredMinimum(); i += 1) {
        writeFileSync(join(posts, `post-${i}.md`), '# post\n');
      }
      const result = runGuardScript(postsGuardScript(), dir);
      expect(result.status, `ガードが通らない: ${result.output}`).toBe(0);
    });
  });

  it('記事が下限より 1 本少なければ落ちる', () => {
    withTempDir((dir) => {
      const posts = join(dir, 'site/src/content/posts');
      mkdirSync(posts, { recursive: true });
      for (let i = 0; i < declaredMinimum() - 1; i += 1) {
        writeFileSync(join(posts, `post-${i}.md`), '# post\n');
      }
      expect(runGuardScript(postsGuardScript(), dir).status).not.toBe(0);
    });
  });

  it('posts ディレクトリごと無ければ落ちる（checkout が走らなかった場合）', () => {
    withTempDir((dir) => {
      const result = runGuardScript(postsGuardScript(), dir);
      expect(result.status, 'ディレクトリが無いのに通っている').not.toBe(0);
      expect(result.output).toContain('::error::');
    });
  });

  it('.md 以外のファイルは記事として数えない', () => {
    // README や画像で下限を満たしてしまうと、ガードが記事の有無を見ていないことになる。
    withTempDir((dir) => {
      const posts = join(dir, 'site/src/content/posts');
      mkdirSync(posts, { recursive: true });
      for (let i = 0; i < declaredMinimum() + 2; i += 1) {
        writeFileSync(join(posts, `not-a-post-${i}.txt`), 'x');
      }
      writeFileSync(join(posts, 'README.md'), '# readme\n');
      expect(runGuardScript(postsGuardScript(), dir).status).not.toBe(0);
    });
  });

  it('**改行を含まない rss.xml でも item を正しく数える**', () => {
    // **これがこのブロックを書いた理由。** @astrojs/rss の出力は 1 行なので、
    // `grep -c`（行数）で数えると item が何本あっても 1 になり、ガードは
    // 記事の本数によらず必ず落ちる。テキスト一致では捕まらない。
    withTempDir((dir) => {
      const dist = join(dir, 'site/dist');
      mkdirSync(dist, { recursive: true });
      const items = Array.from(
        { length: declaredMinimum() },
        (_unused, i) => `<item><title>post ${i}</title></item>`,
      ).join('');
      writeFileSync(join(dist, 'rss.xml'), `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`);
      const result = runGuardScript(rssGuardScript(), dir);
      expect(result.status, `1 行の rss.xml で落ちている: ${result.output}`).toBe(0);
    });
  });

  it('item が下限より少ない rss.xml では落ちる', () => {
    withTempDir((dir) => {
      const dist = join(dir, 'site/dist');
      mkdirSync(dist, { recursive: true });
      const items = Array.from(
        { length: declaredMinimum() - 1 },
        (_unused, i) => `<item><title>post ${i}</title></item>`,
      ).join('');
      writeFileSync(join(dist, 'rss.xml'), `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`);
      expect(runGuardScript(rssGuardScript(), dir).status).not.toBe(0);
    });
  });

  it('rss.xml が無ければ落ちる', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'site/dist'), { recursive: true });
      const result = runGuardScript(rssGuardScript(), dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('::error::');
    });
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
