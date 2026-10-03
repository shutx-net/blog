import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

interface FunctionAssociation {
  EventType?: string;
  FunctionARN?: unknown;
}

interface Behavior {
  PathPattern?: string;
  ViewerProtocolPolicy?: string;
  FunctionAssociations?: FunctionAssociation[];
  LambdaFunctionAssociations?: unknown;
}

interface DistributionConfig {
  DefaultRootObject?: string;
  Enabled?: boolean;
  HttpVersion?: string;
  DefaultCacheBehavior?: Behavior;
  CacheBehaviors?: Behavior[];
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const functionSource = readFileSync(
  fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url)),
  'utf8',
);

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

const functionAssociations = (): FunctionAssociation[] =>
  distributionConfig().DefaultCacheBehavior?.FunctionAssociations ?? [];

describe('CloudFront Function の結線とビヘイビア', () => {
  it('AWS::CloudFront::Function がちょうど 1 個', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 1);
  });

  it('ランタイムが cloudfront-js-2.0（既定の 1.0 に落ちていない）', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
  });

  it('FunctionCode が rewrite-uri.js の中身と完全一致する', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: functionSource,
    });
  });

  it('viewer-request に Function がちょうど 1 つ結線されている', () => {
    const functionId = Object.keys(template.findResources('AWS::CloudFront::Function'))[0];
    expect(functionId).toBeDefined();

    const associations = functionAssociations();
    expect(associations).toHaveLength(1);
    expect(associations[0]?.EventType).toBe('viewer-request');
    expect(JSON.stringify(associations[0]?.FunctionARN)).toContain(functionId as string);
  });

  it('ViewerProtocolPolicy が redirect-to-https', () => {
    expect(distributionConfig().DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
      'redirect-to-https',
    );
  });

  it('DefaultRootObject が index.html', () => {
    expect(distributionConfig().DefaultRootObject).toBe('index.html');
  });

  it('**どのビヘイビアも Lambda@Edge を使っていない**（CloudFront Functions で代替）', () => {
    // Phase 2 まではデフォルトビヘイビアしか見ていなかった。Phase 3 で追加ビヘイビアが
    // 2 件に増え、**しかもこのスタックに初めて実 Lambda が入った**ので、
    // 誤結線の危険が実在するようになった。全ビヘイビアを走査する形に広げる。
    //
    // **その後 /_astro/* が増えて追加ビヘイビアは 3 件になった。** 走査する形にしてあるので
    // ループ自体は無変更で新しいビヘイビアもカバーしている。下の件数だけを現状に合わせる。
    //
    // 「そもそも何も結線していないから通った」を防ぐため、Function 結線を先に主張する。
    expect(functionAssociations()).toHaveLength(1);
    const config = distributionConfig();
    const behaviors: Behavior[] = [
      ...(config.DefaultCacheBehavior === undefined ? [] : [config.DefaultCacheBehavior]),
      ...(config.CacheBehaviors ?? []),
    ];
    expect(behaviors, 'ビヘイビアが 4 件（デフォルト + 追加 3）あること').toHaveLength(4);
    for (const behavior of behaviors) {
      expect(
        behavior.LambdaFunctionAssociations,
        `${behavior.PathPattern ?? 'default'} に Lambda@Edge が結線されている`,
      ).toBeUndefined();
    }
  });

  it('**URI 書き換え Function がデフォルトビヘイビアにしか付いていない**', () => {
    // /media/* に付くとメディアのキーに /index.html が足される。
    // /api/* に付くと /api/posts が /api/posts/index.html になって 404 になる。
    for (const behavior of distributionConfig().CacheBehaviors ?? []) {
      expect(
        behavior.FunctionAssociations,
        `${behavior.PathPattern} に URI 書き換え Function が付いている`,
      ).toBeUndefined();
    }
  });

  it('Distribution が有効', () => {
    expect(distributionConfig().Enabled).toBe(true);
  });

  it('HttpVersion が http2and3 である（HTTP/3 を有効にしている）', () => {
    // **既定は `http2`。** しかも aws-cdk-lib 2.267.0 は
    // `props.httpVersion ?? HttpVersion.HTTP2` と書くので、`site-stack.ts` の
    // `httpVersion` を消してもテンプレートからキーが消えるわけではなく `"http2"` が
    // 描画される（実測）。**欠けたようには見えないまま HTTP/3 だけが無効に戻る**ので、
    // 値そのものをリテラルで見る。`minimumProtocolVersion` を
    // `distribution-custom-domain.test.ts` で固定しているのと同じ理由。
    //
    // ここに置くのは `HttpVersion` が `ViewerCertificate` の中ではなく
    // **`DistributionConfig` 直下**に描画されるため（実測）。
    //
    // 有効化の根拠と**反対側の実測**（Lighthouse の Lantern は h3 を非多重化として扱い、
    // 同一オリジン 2 本目に 150 ms が付く）は `site-stack.ts` の `httpVersion` のコメントと
    // `infra/README.md` の「HTTP/3 を有効にする」にある。**判断を変えるなら 3 箇所を一緒に直す。**
    expect(distributionConfig().HttpVersion).toBe('http2and3');
  });
});
