import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

interface CustomErrorResponse {
  ErrorCode?: number;
  ResponseCode?: number;
  ResponsePagePath?: string;
  ErrorCachingMinTTL?: number;
}

const ERROR_PAGE_PATH = '/404.html';

/** CloudFront のエラーキャッシュ最小 TTL の既定値。明示してテンプレートに描画させる。 */
const ERROR_CACHING_MIN_TTL = 10;

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const customErrorResponses = (): CustomErrorResponse[] => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: { CustomErrorResponses?: CustomErrorResponse[] } } }
    | undefined;
  return dist?.Properties?.DistributionConfig?.CustomErrorResponses ?? [];
};

const responseFor = (errorCode: number): CustomErrorResponse | undefined =>
  customErrorResponses().find((entry) => entry.ErrorCode === errorCode);

describe('CustomErrorResponses（OAC + S3 REST オリジンの 403 問題を閉じる）', () => {
  // このアサーションを先頭に置くのが非空ガード。0 件のときは以下の全件ループが
  // すべて素通りしてしまうため、件数を先に固定する。
  it('CustomErrorResponses がちょうど 2 件（403 と 404）', () => {
    expect(customErrorResponses()).toHaveLength(2);
  });

  it('403 が /404.html・ステータス 404 にマップされている', () => {
    // OAC + S3 REST オリジンではバケットポリシーに s3:ListBucket が無く、S3 が
    // 「存在しない」と「権限が無い」を区別しないため、存在しないキーは 403 で返る。
    // 404 だけマップしても閲覧者には 403 が見えたままになる。
    const entry = responseFor(403);
    expect(entry, 'ErrorCode 403 のエントリが必要').toBeDefined();
    expect(entry?.ResponseCode).toBe(404);
    expect(entry?.ResponsePagePath).toBe(ERROR_PAGE_PATH);
  });

  it('404 が /404.html・ステータス 404 にマップされている', () => {
    const entry = responseFor(404);
    expect(entry, 'ErrorCode 404 のエントリが必要').toBeDefined();
    expect(entry?.ResponseCode).toBe(404);
    expect(entry?.ResponsePagePath).toBe(ERROR_PAGE_PATH);
  });

  it('どのエントリも ResponseCode が 404（403 を 403 のまま返す設定が無い）', () => {
    const responses = customErrorResponses();
    expect(responses).toHaveLength(2);
    for (const entry of responses) {
      expect(entry.ResponseCode, `ErrorCode ${entry.ErrorCode} の ResponseCode`).toBe(404);
      expect(entry.ResponsePagePath).toBe(ERROR_PAGE_PATH);
    }
  });

  it('どのエントリも ErrorCachingMinTTL が 10（短いエラーキャッシュを明示している）', () => {
    // デプロイ直後に一時的に 404 になったオブジェクトを長時間キャッシュされると困る。
    // 既定と同値だが、明示するとテンプレートに描画されて固定できる。
    const responses = customErrorResponses();
    expect(responses).toHaveLength(2);
    for (const entry of responses) {
      expect(entry.ErrorCachingMinTTL, `ErrorCode ${entry.ErrorCode} の TTL`).toBe(
        ERROR_CACHING_MIN_TTL,
      );
    }
  });

  it('Matcher 経由でも 403 → /404.html が描画されている（生 JSON 走査との二重確認）', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: ERROR_PAGE_PATH,
          }),
        ]),
      }),
    });
  });
});
