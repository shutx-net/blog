import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

/**
 * ステートフル資源の論理 ID は固定する。変わると置換（＝バケット作り直し）になるため。
 * 値は CDK の makeUniqueId アルゴリズム（human + md5(path).slice(0,8).toUpperCase()）から
 * 導出した: md5('SiteBucket/Resource') の先頭 8 桁。
 */
const SITE_BUCKET_LOGICAL_ID = 'SiteBucket397A1860';

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

/**
 * allResourcesProperties() は対象リソースが 0 個のとき素通しする（実装で確認済み）。
 * 空テンプレートで偽の green にならないよう、非空であることを必ず先に主張する。
 */
const expectAtLeastOneBucket = (): void => {
  expect(Object.keys(template.findResources('AWS::S3::Bucket')).length).toBeGreaterThan(0);
};

describe('サイト配信用 S3 バケット', () => {
  it('AWS::S3::Bucket がちょうど 1 個（公開バケットをうっかり足したら落ちる）', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('どのバケットもブロックパブリックアクセス 4 つとも true', () => {
    expectAtLeastOneBucket();
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('SSE-S3（AES256）で暗号化されている', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('どのバケットにも WebsiteConfiguration が無い（S3 ウェブサイトホスティングは OAC を迂回する）', () => {
    expectAtLeastOneBucket();
    template.allResourcesProperties('AWS::S3::Bucket', {
      WebsiteConfiguration: Match.absent(),
    });
  });

  it('どのバケットにも AccessControl（ACL）が無い', () => {
    expectAtLeastOneBucket();
    template.allResourcesProperties('AWS::S3::Bucket', {
      AccessControl: Match.absent(),
    });
  });

  it('aws:SecureTransport が false のとき s3:* を Deny する（enforceSSL の生成物）', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('DeletionPolicy と UpdateReplacePolicy が Retain', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('バケットの論理 ID が固定されている（変わると置換が起きる）', () => {
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toEqual([
      SITE_BUCKET_LOGICAL_ID,
    ]);
  });
});
