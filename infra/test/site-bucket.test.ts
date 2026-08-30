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

interface CfnResource {
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, unknown>;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

/**
 * allResourcesProperties() は対象リソースが 0 個のとき素通しする（実装で確認済み）。
 * 空テンプレートで偽の green にならないよう、非空であることを必ず先に主張する。
 */
const expectAtLeastOneBucket = (): void => {
  expect(Object.keys(template.findResources('AWS::S3::Bucket')).length).toBeGreaterThan(0);
};

/**
 * 配信用バケットを論理 ID で名指しして取る。名指しが非空ガードを兼ねる。
 *
 * **hasResource / hasResourceProperties を使わないのが要点。** どちらも「1 件でも
 * 一致すれば通る」ため、バケットが 2 個になった時点で「全部が満たす」から
 * 「どれか 1 個が満たす」へ静かに退化する（メディアバケットの removalPolicy /
 * encryption / enforceSSL を外しても、このファイルは緑のままだった。実測）。
 */
const siteBucket = (): CfnResource => {
  const found = template.findResources('AWS::S3::Bucket')[SITE_BUCKET_LOGICAL_ID];
  expect(found, `${SITE_BUCKET_LOGICAL_ID} が存在すること`).toBeDefined();
  return found as CfnResource;
};

describe('サイト配信用 S3 バケット', () => {
  it('配信用バケットが存在する（論理 ID で名指しする）', () => {
    // バケットの総数はメディア用が増えて 2 個になった。総数の主張は
    // media-bucket.test.ts が担当し、こちらは配信用固有の主張に純化する。
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toContain(
      SITE_BUCKET_LOGICAL_ID,
    );
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
    expect(siteBucket().Properties?.['BucketEncryption']).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
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

  it('どのバケットポリシーも aws:SecureTransport が false のとき s3:* を Deny する', () => {
    // hasResourceProperties は 1 件一致で通るので、配信用だけ enforceSSL があれば
    // メディア用に無くても検出できなかった。件数ガード + allResourcesProperties にする。
    expect(Object.keys(template.findResources('AWS::S3::BucketPolicy'))).toHaveLength(2);
    template.allResourcesProperties('AWS::S3::BucketPolicy', {
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
    // DeletionPolicy は Properties の外にあるので allResourcesProperties では書けない。
    // 論理 ID で名指しして取る（全バケットの走査は media-bucket.test.ts が担当）。
    const bucket = siteBucket();
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.UpdateReplacePolicy).toBe('Retain');
  });

  it('バケットの論理 ID が固定されている（変わると置換が起きる）', () => {
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toContain(
      SITE_BUCKET_LOGICAL_ID,
    );
  });
});
