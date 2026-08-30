import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CicdStack } from '../lib/cicd-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';

interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
}

/**
 * デプロイロールに与える権限の完全な集合。
 *
 * **ソートして完全一致で比較する。増えても減っても落ちる。** 実デプロイで
 * AccessDenied が出て権限を足すときは、この配列と infra/README.md を同時に
 * 更新すること（こっそり広げると必ずここが落ちて気づける設計）。
 */
const EXPECTED_ACTIONS = [
  'cloudfront:CreateInvalidation',
  'cloudfront:GetInvalidation',
  's3:AbortMultipartUpload',
  's3:DeleteObject',
  's3:ListBucket',
  's3:PutObject',
];

const buildTemplate = (): Template => {
  const app = new App();
  const site = new SiteStack(app, 'TestSiteStack');
  return Template.fromStack(
    new CicdStack(app, 'TestCicdStack', {
      siteBucket: site.siteBucket,
      distribution: site.distribution,
    }),
  );
};

const template = buildTemplate();
const templateJson = JSON.stringify(template.toJSON());

/**
 * 権限は Role ではなく別リソースの AWS::IAM::Policy に出る
 * （CDK の addToPolicy は DefaultPolicy を作る）。Role だけ見ていると
 * 権限アサーションが丸ごと空振りするので、これは実質的な非空ガードでもある。
 */
const policyStatements = (): PolicyStatement[] => {
  const found = template.findResources('AWS::IAM::Policy');
  expect(Object.keys(found), 'AWS::IAM::Policy がちょうど 1 個であること').toHaveLength(1);
  const policy = Object.values(found)[0] as {
    Properties?: { PolicyDocument?: { Statement?: PolicyStatement[] } };
  };
  const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
  expect(statements.length, 'PolicyDocument.Statement が 1 件以上あること').toBeGreaterThan(0);
  return statements;
};

const actionsOf = (statement: PolicyStatement): string[] => {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  return action ?? [];
};

const allActions = (): string[] => policyStatements().flatMap(actionsOf);

const statementsWithAction = (action: string): PolicyStatement[] =>
  policyStatements().filter((s) => actionsOf(s).includes(action));

describe('デプロイロールの権限（最小権限）', () => {
  it('【非空ガード】AWS::IAM::Policy がちょうど 1 個で、文が 1 件以上ある', () => {
    template.resourceCountIs('AWS::IAM::Policy', 1);
    expect(policyStatements().length).toBeGreaterThan(0);
  });

  it('付与しているアクションの集合が期待と完全一致する', () => {
    expect([...allActions()].sort()).toEqual([...EXPECTED_ACTIONS].sort());
  });

  it('どのアクション文字列にもワイルドカードが無い', () => {
    // s3:* / s3:Put* / s3:Abort* / s3:DeleteObject* を禁止する。
    // grant メソッドではなく明示列挙にしているのはこのため。
    expect(allActions().length).toBeGreaterThan(0);
    for (const action of allActions()) {
      expect(action.includes('*'), `${action} にワイルドカードがある`).toBe(false);
    }
  });

  it('どの文の Resource も "*" ではない', () => {
    for (const statement of policyStatements()) {
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      for (const resource of resources) {
        expect(resource, `${statement.Sid ?? '(no sid)'} の Resource が * になっている`).not.toBe(
          '*',
        );
      }
    }
  });

  it('s3:ListBucket はバケット ARN に付与されている（末尾に /* が付かない）', () => {
    // ListBucket をオブジェクト ARN に付けると永久に一致しない、という典型的な誤り。
    const statements = statementsWithAction('s3:ListBucket');
    expect(statements).toHaveLength(1);
    const raw = JSON.stringify(statements[0]?.Resource);
    expect(raw).not.toContain('/*');
  });

  it('オブジェクト操作は <bucket-arn>/* に付与されている', () => {
    for (const action of ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload']) {
      const statements = statementsWithAction(action);
      expect(statements, `${action} を持つ文`).toHaveLength(1);
      expect(JSON.stringify(statements[0]?.Resource), `${action} の Resource`).toContain('/*');
    }
  });

  it('テンプレート全文に "MediaBucket" が 1 度も現れない（CI からメディアに触れない）', () => {
    // 設計判断5 の目的そのもの。バケットを分けても CI にメディアへの権限を
    // 渡したら意味が無い。空振り防止に、権限が非空であることを先に主張する。
    expect(allActions().length).toBeGreaterThan(0);
    expect(templateJson).not.toContain('MediaBucket');
  });

  it('iam: / cloudformation: / sts: で始まるアクションが 1 つも無い', () => {
    // CI から cdk deploy はできない。インフラの変更は人間の SSO セッションからのみ。
    expect(allActions().length).toBeGreaterThan(0);
    for (const action of allActions()) {
      expect(/^(iam|cloudformation|sts):/.test(action), `${action} は許可しない`).toBe(false);
    }
  });

  it('cloudfront:Update* / cloudfront:Delete* が無い（ディストリビューションを壊せない）', () => {
    expect(allActions().length).toBeGreaterThan(0);
    for (const action of allActions()) {
      expect(/^cloudfront:(Update|Delete)/.test(action), `${action} は許可しない`).toBe(false);
    }
  });

  it('IAM ユーザもアクセスキーも 0 個（長期認証情報を作らない）', () => {
    // 設計判断8: このリポジトリは public。
    template.resourceCountIs('AWS::IAM::User', 0);
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
  });

  it('AWS::IAM::Role がちょうど 1 個（余分なロールが増えていない）', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
  });
});
