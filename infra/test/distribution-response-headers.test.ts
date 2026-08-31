import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { HSTS_MAX_AGE_SECONDS, REFERRER_POLICY, buildCsp } from '../lib/response-headers.ts';
import { API_PATH_PATTERN, MEDIA_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

interface CacheBehavior {
  PathPattern?: string;
  ResponseHeadersPolicyId?: unknown;
}

interface DistributionConfig {
  DefaultCacheBehavior?: CacheBehavior;
  CacheBehaviors?: CacheBehavior[];
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

const policyLogicalId = (): string => {
  const ids = Object.keys(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
  expect(ids, 'ResponseHeadersPolicy が 1 つも無い').toHaveLength(1);
  return ids[0] as string;
};

const policyProperties = (): Record<string, unknown> => {
  const found = Object.values(
    template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
  )[0] as { Properties?: { ResponseHeadersPolicyConfig?: Record<string, unknown> } } | undefined;
  const config = found?.Properties?.ResponseHeadersPolicyConfig;
  expect(config, 'ResponseHeadersPolicyConfig が無い').toBeDefined();
  return config as Record<string, unknown>;
};

const securityHeaders = (): Record<string, Record<string, unknown>> =>
  policyProperties()['SecurityHeadersConfig'] as Record<string, Record<string, unknown>>;

/**
 * CDK トークンを含む値を**読める文字列**に潰す。
 *
 * `connect-src` にはメディアバケットと認可サーバのドメインが入り、どちらも
 * `Fn::Join` / `Fn::GetAtt` になる。**素の文字列を前提にしたテストは必ず落ちる**ので、
 * 参照はプレースホルダに置き換えたうえでディレクティブとして解析する。
 */
const flatten = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).join('');
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('Fn::Join' in record) {
      const [separator, parts] = record['Fn::Join'] as [string, unknown[]];
      return parts.map(flatten).join(separator);
    }
    if ('Fn::GetAtt' in record) return `<GetAtt:${JSON.stringify(record['Fn::GetAtt'])}>`;
    if ('Ref' in record) return `<Ref:${String(record['Ref'])}>`;
    return `<${Object.keys(record).join('|')}>`;
  }
  return String(value);
};

const cspText = (): string =>
  flatten(
    (securityHeaders()['ContentSecurityPolicy'] as Record<string, unknown>)[
      'ContentSecurityPolicy'
    ],
  );

/**
 * **ディレクティブ名で厳密に引く。**
 *
 * 素朴な `not.toContain("'unsafe-inline'")` は `style-src` 側の `'unsafe-inline'` に
 * 当たって誤検出する。`;` で分割し、**ディレクティブ名の完全一致**で取り出すこと
 * （`script-src` を探して `script-src-attr` を巻き込まない）。
 */
const directives = (): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const part of cspText().split(';')) {
    const tokens = part.trim().split(/\s+/).filter((token) => token.length > 0);
    const name = tokens.shift();
    if (name === undefined) continue;
    map.set(name, tokens);
  }
  return map;
};

const directive = (name: string): string[] => {
  const values = directives().get(name);
  expect(values, `${name} が CSP に無い`).toBeDefined();
  return values as string[];
};

describe('**ResponseHeadersPolicy がちょうど 1 個**', () => {
  it('リソースが 1 個である', () => {
    // **Phase 5 まで 0 個だった新しいリソース種別。** 既存のどの resourceCountIs も
    // 数えていないので、まず件数ガードを置く（増やしても既存が赤くならないため）。
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
  });

  it('ポリシーに名前が付いている（コンソールで識別できる）', () => {
    expect(typeof policyProperties()['Name']).toBe('string');
  });
});

describe('**ビヘイビアへの結線**', () => {
  it('デフォルトビヘイビアが上のポリシーを参照している', () => {
    // **別のマネージドポリシー ID が入っていても通る形にしない。**
    // 論理 ID を突き合わせる。
    expect(distributionConfig().DefaultCacheBehavior?.ResponseHeadersPolicyId).toEqual({
      Ref: policyLogicalId(),
    });
  });

  it('/media/* にも同じポリシーが付いている', () => {
    const media = (distributionConfig().CacheBehaviors ?? []).find(
      (behavior) => behavior.PathPattern === MEDIA_PATH_PATTERN,
    );
    expect(media, `${MEDIA_PATH_PATTERN} のビヘイビアが無い`).toBeDefined();
    expect(media?.ResponseHeadersPolicyId).toEqual({ Ref: policyLogicalId() });
  });

  it('**/api/* には付けない**（JSON 応答に CSP は効かず、OAC の署名条件が繊細）', () => {
    const api = (distributionConfig().CacheBehaviors ?? []).find(
      (behavior) => behavior.PathPattern === API_PATH_PATTERN,
    );
    expect(api, `${API_PATH_PATTERN} のビヘイビアが無い`).toBeDefined();
    expect(api?.ResponseHeadersPolicyId).toBeUndefined();
  });

  it('**/admin/* 専用のビヘイビアを新設していない**（admin はデフォルト経由）', () => {
    const patterns = (distributionConfig().CacheBehaviors ?? []).map(
      (behavior) => behavior.PathPattern,
    );
    expect(patterns).toEqual([MEDIA_PATH_PATTERN, API_PATH_PATTERN]);
  });
});

describe('**CSP の中身（ディレクティブ名で厳密に引く）**', () => {
  it('CSP が空でない', () => {
    expect(cspText().length).toBeGreaterThan(0);
  });

  it('ディレクティブが 1 つ以上ある（解析が空振りしていない）', () => {
    expect(directives().size).toBeGreaterThan(0);
  });

  it('**script-src に `unsafe-inline` が無い**（ここが XSS 緩和の心臓部）', () => {
    // インラインイベントハンドラ（onerror / onload）と javascript: URL を
    // 無効化しているのはこの 1 点である。
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it('**素朴な検査では誤検出することの確認**（style-src 側に unsafe-inline がある）', () => {
    // not.toContain("'unsafe-inline'") を CSP 全体に掛けると落ちる。
    // ディレクティブ名で引く必要があることを、テスト自身が示しておく。
    expect(cspText()).toContain("'unsafe-inline'");
    expect(directive('style-src')).toContain("'unsafe-inline'");
  });

  it('**script-src に `unsafe-eval` が無い**（wasm-unsafe-eval とは別物）', () => {
    // 'wasm-unsafe-eval' は WebAssembly だけを許し、JS の eval() は許さない。
    // 'unsafe-eval' は eval() を開けてしまうので防御が崩れる。
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
  });

  it("**script-src に 'wasm-unsafe-eval' がある**（shiki の wasm）", () => {
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it("script-src に 'self' がある", () => {
    expect(directive('script-src')).toContain("'self'");
  });

  it('**script-src-attr が none**（インラインイベントハンドラの明示的な遮断）', () => {
    // script-src へのフォールバックに頼らず二重化する。
    expect(directive('script-src-attr')).toEqual(["'none'"]);
  });

  it.each([
    ['default-src', "'self'"],
    ['base-uri', "'self'"],
    ['object-src', "'none'"],
    ['frame-src', "'none'"],
    ['frame-ancestors', "'none'"],
    ['form-action', "'self'"],
    ['img-src', "'self'"],
    ['font-src', "'self'"],
  ])('%s が %s である', (name, expected) => {
    expect(directive(name)).toEqual([expected]);
  });

  it('**connect-src に self と 2 つの外部オリジンがある**', () => {
    // 'self' + 認可サーバ + メディアバケット。**どちらが欠けても機能が死ぬ**
    // （前者はログイン、後者は画像アップロード）。
    const values = directive('connect-src');
    expect(values[0]).toBe("'self'");
    expect(values.length).toBe(3);
  });

  it('**connect-src のホストが construct から導出されている**（物理名を書いていない）', () => {
    // CDK トークンが解決された痕跡（GetAtt / Ref / Join の断片）があること。
    const values = directive('connect-src').slice(1).join(' ');
    expect(values).toMatch(/GetAtt|Ref|amazoncognito/);
    // 実測のバケット物理名がテンプレートに直書きされていないこと。
    expect(cspText()).not.toContain('blogsitestack-mediabuckete52fc6e4');
  });

  it('**知らないディレクティブが混ざっていない**', () => {
    // 将来誰かが足したときに「増えたこと」自体が見えるようにする。
    expect([...directives().keys()].sort()).toEqual(
      [
        'base-uri',
        'connect-src',
        'default-src',
        'font-src',
        'form-action',
        'frame-ancestors',
        'frame-src',
        'img-src',
        'object-src',
        'script-src',
        'script-src-attr',
        'style-src',
      ].sort(),
    );
  });

  it('CSP が override される（オリジンの値に負けない）', () => {
    expect(
      (securityHeaders()['ContentSecurityPolicy'] as Record<string, unknown>)['Override'],
    ).toBe(true);
  });
});

describe('**その他のセキュリティヘッダ**（実配信は現状 1 つも返していない）', () => {
  it('X-Content-Type-Options: nosniff を出す', () => {
    expect(securityHeaders()['ContentTypeOptions']).toEqual({ Override: true });
  });

  it(`Referrer-Policy が ${REFERRER_POLICY} である`, () => {
    expect(securityHeaders()['ReferrerPolicy']).toEqual({
      ReferrerPolicy: REFERRER_POLICY,
      Override: true,
    });
  });

  it('X-Frame-Options: DENY を出す（frame-ancestors の二重化）', () => {
    expect(securityHeaders()['FrameOptions']).toEqual({ FrameOption: 'DENY', Override: true });
  });
});

describe('**HSTS は includeSubDomains も preload も付けない**', () => {
  it('HSTS が設定されている', () => {
    expect(securityHeaders()['StrictTransportSecurity']).toBeDefined();
  });

  it('**IncludeSubdomains が false**（*.cloudfront.net は他人と共有するドメイン）', () => {
    // サブドメイン全体に HSTS を宣言するのは、自分のものでないホストに対する宣言になる。
    expect(
      (securityHeaders()['StrictTransportSecurity'] as Record<string, unknown>)[
        'IncludeSubdomains'
      ],
    ).toBe(false);
  });

  it('**Preload が false**（プリロードリストへの登録は取り消しが難しい）', () => {
    expect(
      (securityHeaders()['StrictTransportSecurity'] as Record<string, unknown>)['Preload'],
    ).toBe(false);
  });

  it(`max-age が ${HSTS_MAX_AGE_SECONDS} 秒である`, () => {
    expect(
      (securityHeaders()['StrictTransportSecurity'] as Record<string, unknown>)[
        'AccessControlMaxAgeSec'
      ],
    ).toBe(HSTS_MAX_AGE_SECONDS);
  });
});

describe('buildCsp（純粋関数）', () => {
  const built = buildCsp({
    cognitoOrigin: 'https://example.auth.ap-northeast-1.amazoncognito.com',
    mediaOrigin: 'https://bucket.s3.ap-northeast-1.amazonaws.com',
  });

  it('渡した 2 つのオリジンが connect-src に入る', () => {
    expect(built).toContain(
      "connect-src 'self' https://example.auth.ap-northeast-1.amazoncognito.com https://bucket.s3.ap-northeast-1.amazonaws.com",
    );
  });

  it('テンプレートに描画された CSP と同じ関数から作られている', () => {
    // ディレクティブの集合が一致すること（値は token の有無で違う）。
    const fromTemplate = [...directives().keys()].sort();
    const fromFunction = built
      .split(';')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name): name is string => name !== undefined && name.length > 0)
      .sort();
    expect(fromFunction).toEqual(fromTemplate);
  });

  it('**依存ゼロの純粋関数である**（admin のテストから import できる）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../lib/response-headers.ts', import.meta.url)),
      'utf8',
    );
    // **import 文が 1 つも無いこと。** CDK を引き込むと admin のテストから
    // 読めなくなる（散文で名前に触れるのは構わないので、行頭の import を見る）。
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('検出規則そのものが機能する', () => {
    expect(/^\s*import\s/m.test("import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';")).toBe(
      true,
    );
    expect(/^\s*import\s/m.test('// import は散文では検出しない')).toBe(false);
  });
});
