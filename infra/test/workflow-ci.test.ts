import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * `.github/workflows/ci.yml` の性質を、YAML を構造としてパースして固定する。
 *
 * **なぜ infra/test に置くか。** (1) OIDC 契約の相手は `lib/cicd-stack.ts` の
 * `DEPLOY_SUBJECT` で、同じワークスペースからなら定数を import して契約の両端を
 * 1 本のアサーションで結べる（test/workflow-deploy-oidc.test.ts の主眼）。
 * (2) `test/toolchain.test.ts` という「リポジトリの設定ファイルを読んで固定する」
 * 前例があり、性格が同じ。(3) tsconfig の include と vitest の include が
 * どちらも `test/**` なので設定変更なしで拾われる。
 *
 * **スキーマ検証（actionlint 等）は使わない。** flake.nix に無く、npm 側の代替は
 * どれも 2022〜2024 年で更新が止まっていて 2026 年の Actions 構文を知らない。
 * 古いスキーマの偽陽性は、テストへの信頼を削るぶん無いより悪い。
 * 代わりに **捕まえたい性質を 1 つずつ名指しで主張する。**
 */

/** ワークフローのうち、このテストが名指しで見るところだけを型にする。 */
interface WorkflowJob {
  'runs-on'?: unknown;
  'timeout-minutes'?: unknown;
  permissions?: unknown;
  environment?: unknown;
  steps?: WorkflowStep[];
}

interface WorkflowStep {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
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

/**
 * **非空ガードを兼ねる。** ファイルが無いまま readFileSync が投げると
 * 「YAML が壊れている」と区別がつかないので、existsSync を先に主張する。
 */
const loadWorkflow = (name: string): Workflow => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} が存在すること`).toBe(true);
  return parse(readFileSync(path, 'utf8')) as Workflow;
};

/** 生テキスト。構造ではなくテキストとして見たほうが漏れない検査に使う。 */
const rawWorkflow = (name: string): string => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} が存在すること`).toBe(true);
  return readFileSync(path, 'utf8');
};

/** トップレベルに書いてよいキー。ここに無いキーは typo とみなす。 */
const ALLOWED_TOP_LEVEL_KEYS = [
  'name',
  'on',
  'permissions',
  'concurrency',
  'jobs',
  'defaults',
  'env',
];

/** `owner/repo@<40 桁の 16 進>`。タグやブランチでのピンを機械的に禁止する。 */
const SHA_PINNED_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

const ci = (): Workflow => loadWorkflow('ci.yml');
const ciText = (): string => rawWorkflow('ci.yml');

const jobsOf = (workflow: Workflow): Record<string, WorkflowJob> => {
  const jobs = workflow.jobs ?? {};
  // 【非空ガード】ジョブが 0 個だと、以下の「すべてのジョブが〜」が全部素通りする。
  expect(Object.keys(jobs).length, 'jobs が 1 つ以上あること').toBeGreaterThan(0);
  return jobs;
};

const stepsOf = (job: WorkflowJob | undefined): WorkflowStep[] => {
  const steps = job?.steps ?? [];
  expect(Array.isArray(steps), 'steps が配列であること').toBe(true);
  return steps;
};

/** ジョブの `run` を宣言順に連結する。順序を index で比較したいので join する。 */
const runTextOf = (job: WorkflowJob | undefined): string =>
  stepsOf(job)
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');

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

/** `uses:` を含む行を落とす。SHA（16 進 40 桁）に数字だけの長い並びが現れうるため。 */
const withoutUsesLines = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.includes('uses:'))
    .join('\n');

describe('ci.yml の骨格', () => {
  it('【非空ガード】.github/workflows/ci.yml がディスク上に存在する', () => {
    expect(existsSync(workflowPath('ci.yml'))).toBe(true);
  });

  it('YAML としてパースでき、結果がオブジェクトである', () => {
    const workflow = loadWorkflow('ci.yml');
    expect(workflow).not.toBeNull();
    expect(Array.isArray(workflow)).toBe(false);
    expect(typeof workflow).toBe('object');
  });

  it('トップレベルのキー集合が許可集合の部分集合である', () => {
    // **`permissions:` を `permision:` と綴り間違えると GitHub は黙って無視する。**
    // 権限が既定（このリポジトリでは read）のまま走り、失敗もしない。ここで落とす。
    const keys = Object.keys(loadWorkflow('ci.yml'));
    expect(keys.length, 'トップレベルのキーが 1 つ以上あること').toBeGreaterThan(0);
    for (const key of keys) {
      expect(ALLOWED_TOP_LEVEL_KEYS, `トップレベルの未知のキー: ${key}`).toContain(key);
    }
  });

  it("トップレベルのキーに文字列 'on' があり、'true' が無い", () => {
    // YAML 1.1 は `on` を真偽値 true に潰す（キーが 'true' になる）。
    // yaml@2.9.0 は YAML 1.2 core schema なので潰さないが、
    // 将来パーサを差し替えたときの退行をここで止める。
    const keys = Object.keys(loadWorkflow('ci.yml'));
    expect(keys).toContain('on');
    expect(keys).not.toContain('true');
  });

  it('name と jobs があり、jobs が 1 つ以上のジョブを持つ', () => {
    // 後続のジョブ単位アサーションの非空ガード。jobs が空だと
    // 「すべてのジョブが〜」系の主張が 0 件で素通りする。
    const workflow = loadWorkflow('ci.yml');
    expect(typeof workflow.name).toBe('string');
    expect(workflow.jobs, 'jobs があること').toBeDefined();
    expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(0);
  });

  it('生テキストが空でない', () => {
    expect(rawWorkflow('ci.yml').trim().length).toBeGreaterThan(0);
  });
});

describe('ci.yml が回すコマンド', () => {
  it('ジョブのキー集合が site と infra ちょうど 2 つ', () => {
    expect(Object.keys(jobsOf(ci())).sort()).toEqual(['infra', 'site']);
  });

  it('site ジョブが npm run -w site test を実行する', () => {
    const text = runTextOf(jobsOf(ci())['site']);
    expect(text.length, 'site ジョブに run ステップがあること').toBeGreaterThan(0);
    expect(text).toContain('npm run -w site test');
  });

  it('infra ジョブが typecheck を test より先に実行する', () => {
    // tsc --noEmit は数秒で終わり、型エラーのメッセージは vitest 経由より読みやすい。
    // 失敗を早く安く出すため、順序そのものを固定する。
    const text = runTextOf(jobsOf(ci())['infra']);
    const typecheckAt = text.indexOf('npm run -w infra typecheck');
    const testAt = text.indexOf('npm run -w infra test');
    expect(typecheckAt, 'infra ジョブに typecheck があること').toBeGreaterThan(-1);
    expect(testAt, 'infra ジョブに test があること').toBeGreaterThan(-1);
    expect(typecheckAt, 'typecheck は test より先に書くこと').toBeLessThan(testAt);
  });

  it('両ジョブに npm ci があり、npm install は 1 つも無い', () => {
    // npm install は package-lock.json を書き換えうる。CI では使わない。
    for (const name of ['site', 'infra']) {
      expect(runTextOf(jobsOf(ci())[name]), `${name} ジョブの npm ci`).toContain('npm ci');
    }
    expect(ciText()).not.toContain('npm install');
  });

  it('setup-node に node-version が完全一致で書かれている', () => {
    // **nix の node が動いた日にローカルで落ち、CI が別バージョンを掴んだ日に CI で落ちる。**
    // CI 上でこのアサーションが通ること自体が「setup-node がピンどおりの版を掴んだ」実証になる。
    const steps = allStepsOf(ci()).filter(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@'),
    );
    expect(steps.length, 'setup-node のステップが 1 つ以上あること').toBeGreaterThan(0);
    for (const step of steps) {
      const version = step.with?.['node-version'];
      expect(typeof version, 'node-version は文字列で書くこと（24.19 のような数値に潰さない）')
        .toBe('string');
      expect(version).toBe(process.version.slice(1));
      // setup-node v7 の package-manager-cache はルート package.json に packageManager /
      // devEngines が無いと自動では効かない。明示する。
      expect(step.with?.['cache']).toBe('npm');
    }
  });
});

describe('ci.yml が AWS の資格情報を持たないこと', () => {
  // pull_request で走るワークフローに OIDC トークンを要求させないのは防御の二重化である。
  // デプロイロールの sub 条件が ref:refs/heads/main に固定されているので pull_request からは
  // そもそも assume できないが、「トークンを要求できるジョブが PR 経路に存在しない」ことを
  // テキストレベルで固定しておけば、将来ロールが増えたときの事故も防げる。

  it('生テキストに OIDC トークンを要求する権限名が 1 度も現れない', () => {
    // 文字列を直接書くとこのテスト自身が自分で偽陽性を作るので、組み立てて使う。
    expect(ciText()).not.toContain(['id', 'token'].join('-'));
  });

  it('どの uses も aws-actions/ で始まらない', () => {
    const uses = allUsesOf(ci());
    expect(uses.length, 'uses が 1 つ以上あること').toBeGreaterThan(0);
    for (const value of uses) {
      expect(value.startsWith('aws-actions/'), `${value} は CI では使わない`).toBe(false);
    }
    expect(ciText()).not.toContain('aws-actions/');
  });

  it('生テキストに secrets. が 1 度も現れない', () => {
    expect(ciText()).not.toContain('secrets.');
  });

  it('静的なアクセスキーの名前が現れない', () => {
    for (const needle of [
      'aws-access-key-id',
      'aws-secret-access-key',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(ciText(), `${needle} を書かないこと`).not.toContain(needle);
    }
  });

  it('生テキストに SITE_URL が 1 度も現れない', () => {
    // site/test/unit/site-url.test.ts が `expect(process.env.SITE_URL ?? '').toBe('')` を
    // 主張しているので、CI で SITE_URL を設定すると site のテストが落ちる。
    // この 2 つのテストは同じ規約の両側を守っている。
    expect(ciText()).not.toContain('SITE_URL');
  });
});

describe('ci.yml の権限とピン', () => {
  it('トップレベル permissions が空オブジェクトである', () => {
    const permissions = ci().permissions;
    expect(permissions, 'permissions が書かれていること').toBeDefined();
    expect(permissions).not.toBeNull();
    expect(typeof permissions).toBe('object');
    expect(Object.keys(permissions as Record<string, unknown>)).toEqual([]);
  });

  it('各ジョブの permissions が contents: read ちょうど 1 つ', () => {
    // GitHub のドキュメント: "If you specify the access for any of these permissions,
    // all of those that are not specified are set to `none`"。
    // つまり contents だけを書けば残りは全部 none になる。
    // **キー集合の完全一致にするのは、後から write 権限を足されないようにするため。**
    const jobs = jobsOf(ci());
    for (const [name, job] of Object.entries(jobs)) {
      const permissions = job.permissions as Record<string, unknown> | undefined;
      expect(permissions, `${name} ジョブに permissions があること`).toBeDefined();
      expect(Object.keys(permissions ?? {}), `${name} ジョブの permissions のキー`).toEqual([
        'contents',
      ]);
      expect(permissions?.['contents'], `${name} ジョブの contents`).toBe('read');
    }
  });

  it('すべての uses が 40 桁の commit SHA でピンされている', () => {
    const uses = allUsesOf(ci());
    expect(uses.length, 'uses が 1 つ以上あること').toBeGreaterThan(0);
    for (const value of uses) {
      expect(value, `${value} はタグやブランチではなく commit SHA でピンすること`).toMatch(
        SHA_PINNED_USES,
      );
    }
  });

  it('どのジョブの runs-on も -latest で終わらない', () => {
    // ubuntu-latest は現在 24.04 を指すが、26.04 が public preview に入っており
    // いずれ勝手に移る。ランナー画像が変わると同梱の AWS CLI や既定の node も変わる。
    // **バージョンを黙って動かさない方針を Actions 側にも適用する。**
    for (const [name, job] of Object.entries(jobsOf(ci()))) {
      const runsOn = job['runs-on'];
      expect(typeof runsOn, `${name} ジョブの runs-on`).toBe('string');
      expect(String(runsOn).endsWith('-latest'), `${name} ジョブの runs-on: ${String(runsOn)}`)
        .toBe(false);
    }
  });

  it('すべてのジョブに timeout-minutes がある', () => {
    for (const [name, job] of Object.entries(jobsOf(ci()))) {
      expect(typeof job['timeout-minutes'], `${name} ジョブの timeout-minutes`).toBe('number');
      expect(job['timeout-minutes'] as number).toBeGreaterThan(0);
    }
  });

  it('on.pull_request に paths も paths-ignore も無い', () => {
    // **これは意図的な判断の固定である。**
    // GitHub のドキュメント（Troubleshooting required status checks）は
    // 「path filtering で skip されたワークフローの check は Pending のまま
    // マージをブロックする」「required なワークフローを path filter で skip すべきでない」
    // と明記している。main は現在未保護なので今日は事故らないが、**保護を入れるのは
    // 自然な次の一手であり、そのとき原因が分からない形で詰まる。**
    // 節約の実利も小さい（public リポジトリの Actions は分数無料）。
    const pullRequest = ci().on?.['pull_request'];
    // `pull_request:` は値なしで書くので null になる。それが期待どおりの状態。
    if (pullRequest !== null && pullRequest !== undefined) {
      const keys = Object.keys(pullRequest as Record<string, unknown>);
      expect(keys, 'ci にパスフィルタを付けない').not.toContain('paths');
      expect(keys, 'ci にパスフィルタを付けない').not.toContain('paths-ignore');
    }
  });

  it('concurrency が ref ごとで、進行中をキャンセルする', () => {
    // 同じ PR に新しいコミットが積まれたら、古いコミットの CI 結果には価値が無い。
    // （deploy 側は逆に cancel-in-progress: false。sync を途中で止められないため。）
    const concurrency = ci().concurrency ?? {};
    expect(String(concurrency['group'])).toContain('${{ github.ref }}');
    expect(concurrency['cancel-in-progress']).toBe(true);
  });

  it('どの run にも ${{ }} が現れない', () => {
    // GitHub のセキュリティ強化ガイド: "For inline scripts, the preferred approach to
    // handling untrusted input is to set the value of the expression to an intermediate
    // environment variable"。値は env: 経由で渡す。
    for (const run of allRunsOf(ci())) {
      expect(run.includes('${{'), `run に式が埋まっている: ${run}`).toBe(false);
    }
  });
});
