import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SITE_CERTIFICATE_ID, SiteStack } from '../lib/site-stack.ts';

/**
 * **カスタムドメインと ACM 証明書の結線を縛る。**
 *
 * ここが外れると `https://blog.shutx.net` は **公開されているのに開けない URL** になる
 * （実測 2026-10-02: Cloudflare の CNAME は grey cloud で CloudFront を指しているのに
 * alias も証明書も無く、返るのは `CN=*.cloudfront.net` だけ。`curl` は
 * `SSL: no alternative certificate subject name matches` で落ちる）。
 *
 * ## 期待値はリテラルで書く
 *
 * `CUSTOM_DOMAIN_NAME` を import して `CUSTOM_DOMAIN_NAME` と比べる形は何も証明しない
 * （`admin/test/support/site-renderer.ts` と同じ規律 — 両辺が一緒にずれて緑のまま壊れる）。
 * ドメインもリージョンもプロトコル版も、下ではすべて文字列リテラルで書いてある。
 *
 * **`SITE_CERTIFICATE_ID` だけは import する。** あれを使うのは値の比較ではなく
 * **形（UUID か）の検査**で、「プレースホルダのまま deploy する」を落とすためである。
 * 値そのものは ACM に発行された UUID なので、テストに写しても何も縛れない。
 */

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const siteStackSource = readFileSync(
  fileURLToPath(new URL('../lib/site-stack.ts', import.meta.url)),
  'utf8',
);

interface ViewerCertificate {
  AcmCertificateArn?: unknown;
  CloudFrontDefaultCertificate?: unknown;
  MinimumProtocolVersion?: unknown;
  SslSupportMethod?: unknown;
}

interface DistributionConfig {
  Aliases?: unknown;
  ViewerCertificate?: ViewerCertificate;
}

/** ディストリビューションをちょうど 1 個取る。**件数アサーションが非空ガードを兼ねる。** */
const distributionConfig = (): DistributionConfig => {
  const found = template.findResources('AWS::CloudFront::Distribution');
  expect(Object.keys(found), 'AWS::CloudFront::Distribution はちょうど 1 個').toHaveLength(1);
  const dist = Object.values(found)[0] as { Properties?: { DistributionConfig?: DistributionConfig } };
  return dist.Properties?.DistributionConfig ?? {};
};

const viewerCertificate = (): ViewerCertificate => {
  const certificate = distributionConfig().ViewerCertificate;
  expect(certificate, 'DistributionConfig.ViewerCertificate が描画されていること').toBeDefined();
  return certificate as ViewerCertificate;
};

/** 証明書 ARN を文字列化したもの。`Fn::Join` なので部分文字列で検査する。 */
const certificateArnJson = (): string => JSON.stringify(viewerCertificate().AcmCertificateArn);

describe('カスタムドメインの alias', () => {
  it('**`Aliases` が `blog.shutx.net` ちょうど 1 本である**', () => {
    // これが無い状態が「公開されているのに開けない URL」そのもの。
    // 余分な alias も禁じる（CloudFront グローバルで一意なので、要らないものを
    // 押さえると他人の deploy を壊す）。`*.cloudfront.net` は alias ではないので
    // ここには現れず、しかし配信は続く（退路。CLOUDFRONT_ORIGIN のコメント）。
    expect(distributionConfig().Aliases).toEqual(['blog.shutx.net']);
  });
});

describe('ViewerCertificate', () => {
  it('**ACM 証明書を参照しており、既定の CloudFront 証明書に落ちていない**', () => {
    // 既定のままだと CDK は `ViewerCertificate` を 1 文字も描画しない（実測）。
    // `CloudFrontDefaultCertificate` が立つ経路は CfnDistribution を直接書いたときだけだが、
    // **両方を主張しておく** — 片方だけ見ると「キーが無い」と「既定だと明示されている」の
    // どちらで通ったのか分からない。
    const certificate = viewerCertificate();
    expect(certificate.AcmCertificateArn).toBeDefined();
    expect(certificate.CloudFrontDefaultCertificate).toBeUndefined();
  });

  it('**ARN のリージョン欄が us-east-1 である**（ap-northeast-1 ではない）', () => {
    // CloudFront は us-east-1 の証明書しか読まない。一方このスタックのデプロイ先は
    // ap-northeast-1 で、**間違えても `cdk synth` は通る。**
    //
    // CDK 自身の `DistributionCertificateMustBeInUsEast1` は当てにならない：ARN を
    // `formatArn` で組むと partition / account がトークンになり、構築子の検査が
    // `Token.isUnresolved(region)` で抜ける（aws-cdk-lib 2.267.0 で実測）。
    // **間違いは deploy 時の `InvalidViewerCertificate` という原因の書かれていない
    // エラーになるので、ここで落とす。**
    const arn = certificateArnJson();
    expect(arn).toContain(':acm:us-east-1:');
    expect(arn).not.toContain('ap-northeast-1');
  });

  it('**ARN にアカウント ID のリテラルが載っていない**（`Ref: AWS::AccountId` で組んである）', () => {
    // **このリポジトリは public。** 同じ規律が deploy.yml（role ARN を variable に逃がす）、
    // ADMIN_LOGIN_DOMAIN_PREFIX の JSDoc、infra/docs/custom-domain.md の 3 箇所に
    // 明文で書かれている。
    const arn = certificateArnJson();
    expect(arn).toContain('AWS::AccountId');
    // 12 桁連続の数字はアカウント ID 以外にこの ARN には現れない
    // （UUID の数字列も `TLSv1.2_2021` も 12 桁には届かない）。
    expect(arn).not.toMatch(/\d{12}/);
  });

  it('`MinimumProtocolVersion` が TLSv1.2_2021 である', () => {
    // cdk.json の `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021` で既定も
    // 同値になるが、**フラグを外した日に黙って TLSv1.2_2019 に落ちる**ので値を直接見る。
    expect(viewerCertificate().MinimumProtocolVersion).toBe('TLSv1.2_2021');
  });

  it('`SslSupportMethod` が sni-only である（`vip` は月 600 USD）', () => {
    // 既定値だが、取り違えると**課金が静かに増える**ので固定する。
    expect(viewerCertificate().SslSupportMethod).toBe('sni-only');
  });
});

describe('証明書はスタックの外で作る', () => {
  it('**`AWS::CertificateManager::Certificate` が 0 個である**', () => {
    // このスタックは env-agnostic（`test/site-stack.test.ts` が固定）なので、構築子で
    // 証明書を作るとデプロイ先の ap-northeast-1 に出来てしまい CloudFront から読めない。
    // 検証 CNAME も Cloudflare に手で入れるため、スタック内の証明書は `cdk deploy` を
    // 待たせるだけになる。**発行は帯域外、コードは ARN 参照だけ。**
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    // 「そもそも Distribution が無いから 0 だった」を防ぐ。
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('**`SITE_CERTIFICATE_ID` が UUID の形である**（プレースホルダが残っていない）', () => {
    // 値の比較ではなく形の検査。`'not-configured'` や `'<uuid>'` のまま deploy すると
    // CloudFront は `InvalidViewerCertificate` を返す。
    expect(SITE_CERTIFICATE_ID).toMatch(/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  });
});

describe('site-stack.ts のソーステキスト', () => {
  it('**アカウント ID の形（`:<12 桁>:`）がソースに書かれていない**', () => {
    // テンプレート側（上のケース）は `formatArn` の出力しか見ない。
    // **フル ARN の定数を 1 行足された日はこちらだけが捕まえる。**
    // 期待値にアカウント ID そのものを書くわけにはいかない（それ自体が漏洩になる）ので、
    // 「ARN の中でアカウント ID が占める形」を禁じる。
    expect(siteStackSource).not.toMatch(/:\d{12}:/);
  });
});
