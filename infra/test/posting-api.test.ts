import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
// **api の定数を実物で import する。** infra が書く文字列と api が受け付ける文字列が
// ずれると synth もテストも通ったうえでコールドスタートだけが落ちる。
import {
  ALLOWED_AUTH_MODES,
  AUTH_MODE_COGNITO,
  AUTH_MODE_DENY_ALL,
} from '../../api/src/config.ts';
import { SITE_POSTS_PATH_PREFIX } from '../../api/src/github/commit.ts';
import { ADMIN_USERNAME, SiteStack } from '../lib/site-stack.ts';

/** cognito モードのときだけ現れる環境変数。 */
const COGNITO_ENV_NAMES = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_ALLOWED_USERNAME',
] as const;

interface PolicyStatement {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));
const templateJson = JSON.stringify(template.toJSON());

const resourcesOf = (type: string): Array<{ Properties?: Record<string, unknown> }> =>
  Object.values(template.findResources(type)) as Array<{ Properties?: Record<string, unknown> }>;

const only = (type: string): Record<string, unknown> => {
  const found = resourcesOf(type);
  expect(found, `${type} がちょうど 1 個であること`).toHaveLength(1);
  return (found[0]?.Properties ?? {}) as Record<string, unknown>;
};

/**
 * 実行ロールのインラインポリシー文。
 *
 * **件数ガードを入れてある（修復 5）。** ガードが無いと、ポリシーが 2 本目に
 * 増えた瞬間に以降の『アクションがちょうど 4 つ』等が **黙って
 * 「全ポリシーの合併」についての主張に意味が変わる**。
 * Cognito が SMS ロールなどを持ち込むと現実に起きうる。
 */
const policyStatements = (): PolicyStatement[] => {
  const policies = resourcesOf('AWS::IAM::Policy');
  expect(policies, 'AWS::IAM::Policy はちょうど 1 本（増えたら以降の主張の意味が変わる）').toHaveLength(1);
  return policies.flatMap((policy) => {
    const document = policy.Properties?.['PolicyDocument'] as
      | { Statement?: PolicyStatement[] }
      | undefined;
    const statements = document?.Statement ?? [];
    expect(statements.length, 'ポリシー文が 0 件だと以降のループが素通りする').toBeGreaterThan(0);
    return statements;
  });
};

/** ロググループの論理 ID。**件数 1 を先に主張してから取る（修復 3・4）。** */
const onlyLogGroupId = (): string => {
  const ids = Object.keys(template.findResources('AWS::Logs::LogGroup'));
  expect(ids, 'AWS::Logs::LogGroup はちょうど 1 個').toHaveLength(1);
  return ids[0] as string;
};

const actionsOf = (statement: PolicyStatement): string[] =>
  typeof statement.Action === 'string' ? [statement.Action] : (statement.Action ?? []);

const lambdaEnvironment = (): Record<string, unknown> => {
  const environment = only('AWS::Lambda::Function')['Environment'] as
    | { Variables?: Record<string, unknown> }
    | undefined;
  const variables = environment?.Variables;
  // 非空ガード。Environment ごと消えたときに全アサーションが素通りするのを防ぐ。
  expect(variables, 'Lambda に環境変数が必要').toBeDefined();
  expect(Object.keys(variables ?? {}).length).toBeGreaterThan(0);
  return variables ?? {};
};

describe('GitHub App の秘密鍵シークレット', () => {
  it('**Properties のキー集合が ["Description"] ちょうどである**', () => {
    // CloudFormation のドキュメント: "If you omit both GenerateSecretString and
    // SecretString, you create an empty secret."
    //
    // **CDK の既定はこれを満たさない。** aws-secretsmanager/lib/secret.js が
    //   generateSecretString: props.generateSecretString ?? (secretString ? void 0 : {})
    // としているため、素の new Secret() は GenerateSecretString: {} を描画し、
    // デプロイ時に **32 文字のランダムパスワードが AWSCURRENT に入る**。
    // 設計判断8（CDK に秘密の値を書かない / 空のシークレットを作る）が静かに破れる。
    //
    // 実測: この状態でも Phase 2 までの 121 件は 1 つも赤くならなかった。
    // このアサーションが唯一の検出手段である。
    expect(Object.keys(only('AWS::SecretsManager::Secret')).sort()).toEqual(['Description']);
  });

  it('GenerateSecretString も SecretString も無い', () => {
    const properties = only('AWS::SecretsManager::Secret');
    expect(properties['GenerateSecretString']).toBeUndefined();
    expect(properties['SecretString']).toBeUndefined();
  });

  it('DeletionPolicy が Retain である', () => {
    // **GitHub App の秘密鍵は Web UI で生成した瞬間に 1 度しか表示されない。**
    // スタックを消して鍵を失うと、新しい鍵を作り直す以外に復旧手段がない。
    // **修復 1**: 以前は secrets[0] というガード無しの添字だった。0 件でも
    // `undefined?.DeletionPolicy` が undefined になるだけ…ではなく toBe で落ちるが、
    // **2 件目が増えたときに 1 件目だけ見て通ってしまう**。件数を先に主張し、
    // 全件ループに変える（infra/README.md の型 2）。
    const secrets = Object.entries(template.findResources('AWS::SecretsManager::Secret')) as Array<
      [string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }]
    >;
    expect(secrets, 'AWS::SecretsManager::Secret はちょうど 1 個').toHaveLength(1);
    for (const [logicalId, secret] of secrets) {
      expect(secret.DeletionPolicy, `${logicalId} の DeletionPolicy`).toBe('Retain');
      expect(secret.UpdateReplacePolicy, `${logicalId} の UpdateReplacePolicy`).toBe('Retain');
    }
  });

  it('Description に鍵らしき文字列が入っていない', () => {
    const description = String(only('AWS::SecretsManager::Secret')['Description'] ?? '');
    expect(description).not.toContain('-----BEGIN');
    expect(description.length).toBeGreaterThan(0);
  });
});

describe('テンプレートに秘密が無い', () => {
  it("全文に '-----BEGIN' が 1 度も現れない", () => {
    expect(templateJson).not.toContain('-----BEGIN');
  });

  it('全文に AWS アクセスキーらしき文字列が無い', () => {
    expect(templateJson).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
  });
});

describe('実行ロール', () => {
  it('**ManagedPolicyArns を持つ AWS::IAM::Role が 0 個である**', () => {
    // 実測（ミューテーション）: Lambda に role を明示せず CDK 既定に任せると
    // AWSLambdaBasicExecutionRole が付く。その中身は
    //   Action: [logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents]
    //   Resource: "*"
    // で（IAM API から取得して確認済み）、**ワイルドカードのリソース権限**である。
    //
    // ところが **マネージドポリシーは ARN 参照でありポリシー文がテンプレートに現れない**ため、
    // synth-artifact.test.ts の『Resource が "*" の Allow 文が 1 つも無い』は緑のまま通る。
    // **これが唯一の検出手段。**
    const roles = resourcesOf('AWS::IAM::Role');
    expect(roles.length, 'ロールが 1 件以上あること（0 件で通るテストにしない）').toBeGreaterThan(0);
    const withManaged = roles.filter((role) => role.Properties?.['ManagedPolicyArns'] !== undefined);
    expect(withManaged).toEqual([]);
  });

  it('**すべての** Role が lambda.amazonaws.com だけに assume される', () => {
    // **修復 2**: 以前は hasResourceProperties で、**1 件でも一致すれば通った**。
    // 現在ロールは 1 個だが、Cognito が SMS ロール等を持ち込むと
    // 「どれか 1 つが lambda を assume する」に静かに退化する。
    // findResources を全件走査する形に変える（infra/README.md の型 1/4）。
    const roles = Object.entries(template.findResources('AWS::IAM::Role')) as Array<
      [string, { Properties?: Record<string, unknown> }]
    >;
    expect(roles, 'AWS::IAM::Role はちょうど 1 個').toHaveLength(1);
    for (const [logicalId, role] of roles) {
      const document = role.Properties?.['AssumeRolePolicyDocument'] as {
        Statement?: Array<{ Effect?: string; Principal?: unknown; Action?: unknown }>;
      };
      const statements = document?.Statement ?? [];
      expect(statements, `${logicalId} の AssumeRolePolicyDocument が空`).toHaveLength(1);
      for (const statement of statements) {
        expect(statement.Effect, logicalId).toBe('Allow');
        expect(statement.Principal, logicalId).toEqual({ Service: 'lambda.amazonaws.com' });
        expect(statement.Action, logicalId).toBe('sts:AssumeRole');
      }
    }
  });
});

describe('実行ロールのインラインポリシー', () => {
  it('**アクションがちょうど 4 つである**', () => {
    // secretsmanager:DescribeSecret が入っていないこと。secret.grantRead() は
    // GetSecretValue と DescribeSecret の 2 つを付けるが、DescribeSecret は使わない。
    // 同様に mediaBucket.grantPut() は s3:Abort* を含む 6 アクションを付ける
    // （実測）。**どちらも grant メソッドを使わない理由。**
    const actions = policyStatements().flatMap(actionsOf).sort();
    expect(actions).toEqual([
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      's3:PutObject',
      'secretsmanager:GetSecretValue',
    ]);
  });

  it('どのアクションにもワイルドカードが無い', () => {
    for (const action of policyStatements().flatMap(actionsOf)) {
      expect(action, `${action} にワイルドカードがある`).not.toContain('*');
    }
  });

  it('Resource が "*" の文が無い', () => {
    for (const statement of policyStatements()) {
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      expect(resources).not.toContain('*');
    }
  });

  it('logs の権限が明示 LogGroup の ARN にスコープされている', () => {
    const logStatements = policyStatements().filter((s) =>
      actionsOf(s).some((a) => a.startsWith('logs:')),
    );
    expect(logStatements).toHaveLength(1);
    // **修復 3**: 以前は Object.keys(...)[0] というガード無しの添字だった。
    // onlyLogGroupId() が件数 1 を先に主張する。
    expect(JSON.stringify(logStatements[0]?.Resource)).toContain(onlyLogGroupId());
  });

  it('logs:CreateLogGroup を持っていない（LogGroup は CDK が作る）', () => {
    expect(policyStatements().flatMap(actionsOf)).not.toContain('logs:CreateLogGroup');
  });

  it('**s3:PutObject が メディアバケットの media/* に限定されている**', () => {
    // CloudFront のビヘイビア（/media/*）・S3 のキー空間（media/）・
    // IAM のリソース ARN の 3 つが同じ接頭辞で揃っていないと動かない。
    const s3Statements = policyStatements().filter((s) =>
      actionsOf(s).some((a) => a.startsWith('s3:')),
    );
    expect(s3Statements).toHaveLength(1);
    const resource = JSON.stringify(s3Statements[0]?.Resource);
    expect(resource).toContain('MediaBucketE52FC6E4');
    expect(resource).toContain('/media/*');
  });

  it('**サイト配信用バケットを指していない**', () => {
    const s3Statements = policyStatements().filter((s) =>
      actionsOf(s).some((a) => a.startsWith('s3:')),
    );
    expect(JSON.stringify(s3Statements[0]?.Resource)).not.toContain('SiteBucket');
  });

  it('s3:PutObject 以外の S3 アクションが無い', () => {
    // Lambda はアップロード用の URL に署名するだけ。読み取りも削除も列挙も要らない。
    const s3Actions = policyStatements()
      .flatMap(actionsOf)
      .filter((a) => a.startsWith('s3:'));
    expect(s3Actions).toEqual(['s3:PutObject']);
  });

  it('secretsmanager の権限がこのシークレットに限定されている', () => {
    const secretStatements = policyStatements().filter((s) =>
      actionsOf(s).some((a) => a.startsWith('secretsmanager:')),
    );
    expect(secretStatements).toHaveLength(1);
    expect(actionsOf(secretStatements[0] as PolicyStatement)).toEqual([
      'secretsmanager:GetSecretValue',
    ]);
    expect(JSON.stringify(secretStatements[0]?.Resource)).toContain('GitHubAppPrivateKey');
  });
});

describe('Lambda 関数', () => {
  it('ちょうど 1 個で、ランタイムが nodejs24.x', () => {
    // nodejs20.x は 2026-04-30 に非推奨（AGENTS.md）。
    expect(only('AWS::Lambda::Function')['Runtime']).toBe('nodejs24.x');
  });

  it('ReservedConcurrentExecutions が設定されている', () => {
    // **本フェーズ唯一の流量防御。** /api/* は匿名で到達できるので、deny-all でも
    // Lambda は起動する。予約同時実行が暴走時の上限として働く。
    const reserved = only('AWS::Lambda::Function')['ReservedConcurrentExecutions'];
    expect(typeof reserved).toBe('number');
    expect(reserved).toBe(2);
  });

  it('LoggingConfig.LogGroup が明示 LogGroup を指している', () => {
    const logging = only('AWS::Lambda::Function')['LoggingConfig'] as
      | { LogGroup?: unknown }
      | undefined;
    expect(logging?.LogGroup).toBeDefined();
    // **修復 4**: 修復 3 と同じガード無し添字。
    expect(JSON.stringify(logging?.LogGroup)).toContain(onlyLogGroupId());
  });

  it('**Environment.Variables.AUTH_MODE が "cognito" である**', () => {
    expect(lambdaEnvironment()['AUTH_MODE']).toBe(AUTH_MODE_COGNITO);
  });

  it('AUTH_MODE の値が api 側の定数と一致する（ずれるとコールドスタートで落ちる）', () => {
    // infra が書く文字列と api/src/config.ts が受け付ける文字列がずれると、
    // **synth もテストも通ったうえで**本番のコールドスタートだけが落ちる。
    // 既存の media-presign.test.ts が MEDIA_PATH_PATTERN を import しているのと同じ手口。
    expect([AUTH_MODE_DENY_ALL, AUTH_MODE_COGNITO]).toContain(lambdaEnvironment()['AUTH_MODE']);
    expect(ALLOWED_AUTH_MODES).toContain(lambdaEnvironment()['AUTH_MODE'] as string);
  });

  /**
   * **本 step で最も重要な主張。条件付きの不変条件として書く。**
   *
   * 将来 deny-all に戻しても緑のまま通り、**cognito にしたのに COGNITO_* が
   * 欠けている状態だけが赤くなる。**
   */
  it('**AUTH_MODE=cognito なら COGNITO_* が 3 つ揃っていて、いずれも空でない**', () => {
    const variables = lambdaEnvironment();
    if (variables['AUTH_MODE'] !== AUTH_MODE_COGNITO) return;
    for (const name of COGNITO_ENV_NAMES) {
      const value = variables[name];
      expect(value, `${name} が無い`).toBeDefined();
      expect(JSON.stringify(value), `${name} が空`).not.toBe('""');
      expect(JSON.stringify(value).length, `${name} が空`).toBeGreaterThan(2);
    }
  });

  it('**AUTH_MODE=deny-all なら COGNITO_* を 1 つも渡さない**（切り戻しの逃げ道）', () => {
    const variables = lambdaEnvironment();
    if (variables['AUTH_MODE'] !== AUTH_MODE_DENY_ALL) return;
    for (const name of COGNITO_ENV_NAMES) {
      expect(variables[name], `deny-all なのに ${name} がある`).toBeUndefined();
    }
  });

  it('COGNITO_USER_POOL_ID が Ref でユーザプールを指している（物理 ID の直書きでない）', () => {
    const value = lambdaEnvironment()['COGNITO_USER_POOL_ID'] as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['Ref']);
    const pools = Object.keys(template.findResources('AWS::Cognito::UserPool'));
    expect(pools).toHaveLength(1);
    expect(value['Ref']).toBe(pools[0]);
  });

  it('COGNITO_CLIENT_ID が Ref でアプリクライアントを指している', () => {
    const value = lambdaEnvironment()['COGNITO_CLIENT_ID'] as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['Ref']);
    const clients = Object.keys(template.findResources('AWS::Cognito::UserPoolClient'));
    expect(clients).toHaveLength(1);
    expect(value['Ref']).toBe(clients[0]);
  });

  it('**COGNITO_ALLOWED_USERNAME がリテラルで、空でなく、@ を含まない**', () => {
    // メールアドレスを入れると usernameAttributes 無しのプールでは一致しない。
    // public リポジトリに個人のメールを書かないという方針とも合う。
    const value = lambdaEnvironment()['COGNITO_ALLOWED_USERNAME'];
    expect(typeof value).toBe('string');
    expect(value).toBe(ADMIN_USERNAME);
    expect((value as string).length).toBeGreaterThan(0);
    expect(value).not.toContain('@');
  });

  it('**環境変数のキー集合が固定されている**（増えたこと自体を検出する）', () => {
    // 既存の「秘密が入っていない」走査は自動的に COGNITO_* も見るが、
    // **キーが増えたこと自体**を検出する主張が無かった。
    expect(Object.keys(lambdaEnvironment()).sort()).toEqual(
      [
        'AUTH_MODE',
        'COGNITO_ALLOWED_USERNAME',
        'COGNITO_CLIENT_ID',
        'COGNITO_USER_POOL_ID',
        'GITHUB_APP_CLIENT_ID',
        'GITHUB_APP_SECRET_ID',
        'GITHUB_CODE_REPO',
        'GITHUB_CONTENT_REPO',
        'GITHUB_OWNER',
        'MEDIA_BUCKET',
        'POSTS_PATH_PREFIX',
      ].sort(),
    );
  });

  it('**GITHUB_REPO が消えている**（分割前の名前が残らない）', () => {
    // 残っていると「どちらのリポジトリか」が曖昧なまま両方の意味で読まれる。
    expect(Object.keys(lambdaEnvironment())).not.toContain('GITHUB_REPO');
  });

  it('**Phase 2 では両方のリポジトリが今日と同じ blog を指す**', () => {
    // 設定可能にするだけのフェーズ。値を変えるのは切り替えの PR。
    const env = lambdaEnvironment();
    expect(env['GITHUB_CONTENT_REPO']).toBe('blog');
    expect(env['GITHUB_CODE_REPO']).toBe('blog');
  });

  it('**記事パスの接頭辞が今日の値である**', () => {
    expect(lambdaEnvironment()['POSTS_PATH_PREFIX']).toBe(SITE_POSTS_PATH_PREFIX);
  });

  it('**DEPLOY_WORKFLOW_FILE を設定していない**（dispatch は opt-in）', () => {
    // 設定すると push 起点のデプロイと二重に走る。切り替えの PR で初めて設定する。
    expect(Object.keys(lambdaEnvironment())).not.toContain('DEPLOY_WORKFLOW_FILE');
  });

  it('**cognito-idp の IAM 権限を 1 つも足していない**', () => {
    // JWKS の取得は認証不要な公開 HTTPS GET なので IAM 権限は要らない。
    // 「赤くなったから権限を足す」をしないための名指しの主張。
    expect(templateJson).not.toContain('cognito-idp:');
    for (const statement of policyStatements()) {
      for (const action of actionsOf(statement)) {
        expect(action, 'cognito の権限は要らない').not.toMatch(/^cognito/);
      }
    }
  });

  it('環境変数に秘密が入っていない', () => {
    const environment = only('AWS::Lambda::Function')['Environment'] as
      | { Variables?: Record<string, unknown> }
      | undefined;
    const variables = environment?.Variables ?? {};
    expect(Object.keys(variables).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(variables)) {
      expect(JSON.stringify(value), `${name} に PEM らしき文字列がある`).not.toContain('-----BEGIN');
      expect(name, '鍵そのものを環境変数に置かない').not.toMatch(/PRIVATE_KEY$/);
    }
  });

  it('環境変数がシークレットの ARN を指している（値ではなく参照）', () => {
    const environment = only('AWS::Lambda::Function')['Environment'] as
      | { Variables?: Record<string, unknown> }
      | undefined;
    expect(JSON.stringify(environment?.Variables?.['GITHUB_APP_SECRET_ID'])).toContain('Ref');
  });

  it('AWS_REGION を自分で設定していない（Lambda の予約変数）', () => {
    const environment = only('AWS::Lambda::Function')['Environment'] as
      | { Variables?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(environment?.Variables ?? {})).not.toContain('AWS_REGION');
  });
});

describe('Function URL', () => {
  it('**ちょうど 1 個で AuthType が AWS_IAM である**', () => {
    // 'NONE' にすると Function URL が完全公開になり、CloudFront を迂回して
    // 直接叩けるようになる。
    expect(only('AWS::Lambda::Url')['AuthType']).toBe('AWS_IAM');
  });

  it("AuthType が 'NONE' でない", () => {
    expect(only('AWS::Lambda::Url')['AuthType']).not.toBe('NONE');
  });
});

describe('ロググループ', () => {
  it('ちょうど 1 個で RetentionInDays が設定されている（無期限にしない）', () => {
    const retention = only('AWS::Logs::LogGroup')['RetentionInDays'];
    expect(typeof retention).toBe('number');
    expect(retention).toBeGreaterThan(0);
  });
});

describe('カスタムリソースを引き込んでいない', () => {
  it('AWS::CloudFormation::CustomResource が 0 個', () => {
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
  });

  it('Custom:: 系のリソースが 0 個', () => {
    // 旧来の logRetention プロパティは LogRetention のカスタムリソース（＝
    // 追加の Lambda と広い IAM 権限）を引き込む。logGroup プロパティならそれが無い。
    const customTypes = Object.values(template.toJSON().Resources as Record<string, { Type: string }>)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith('Custom::'));
    expect(customTypes).toEqual([]);
  });

  it('Lambda 関数が 1 個だけ（カスタムリソース用の関数が増えていない）', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });
});

/**
 * GitHub App の client ID。
 *
 * Phase 3〜5 は App が存在しなかったので `'not-configured'` を入れていた。
 * **`AUTH_MODE=deny-all` の間は GitHub を呼ぶ経路に到達しないので安全だった**が、
 * 認証が通るようになった今は、プレースホルダのままだと
 * 「鍵は読めているのに GitHub が 401 を返す」という紛らわしい壊れ方をする。
 */
describe('GitHub App の client ID', () => {
  const env = (): Record<string, unknown> => {
    const fns = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{ Properties?: { Environment?: { Variables?: Record<string, unknown> } } }>;
    expect(fns, 'Lambda が 1 つも無い（アサーションの空振り防止）').toHaveLength(1);
    return fns[0]?.Properties?.Environment?.Variables ?? {};
  };

  it('**プレースホルダのままではない**', () => {
    expect(
      env().GITHUB_APP_CLIENT_ID,
      "'not-configured' のままだと GitHub が App JWT を 401 で拒否する。" +
        '症状は「鍵は読めているのに GitHub 呼び出しだけ失敗する」形になり、鍵の問題と紛らわしい',
    ).not.toBe('not-configured');
  });

  it('GitHub App の client ID の形をしている（Iv で始まる）', () => {
    // app ID（数字）でも動くが、GitHub は client ID を推奨している。
    // 数字を入れてしまう取り違えを検出する。
    expect(String(env().GITHUB_APP_CLIENT_ID)).toMatch(/^Iv[0-9]{1,2}[A-Za-z0-9]+$/);
  });

  it('空でもプレースホルダ的な値でもない', () => {
    const value = String(env().GITHUB_APP_CLIENT_ID ?? '');
    expect(value.length).toBeGreaterThan(8);
    for (const bad of ['todo', 'changeme', 'xxx', 'placeholder']) {
      expect(value.toLowerCase()).not.toContain(bad);
    }
  });
});
