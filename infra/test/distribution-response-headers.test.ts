import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  HSTS_MAX_AGE_SECONDS,
  MEDIA_CACHE_CONTROL,
  REFERRER_POLICY,
  SITE_CACHE_CONTROL,
  buildCsp,
} from '../lib/response-headers.ts';
import { API_PATH_PATTERN, MEDIA_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

interface CacheBehavior {
  PathPattern?: string;
  ResponseHeadersPolicyId?: unknown;
}

interface DistributionConfig {
  DefaultCacheBehavior?: CacheBehavior;
  CacheBehaviors?: CacheBehavior[];
}

interface CustomHeader {
  Header?: string;
  Value?: string;
  Override?: boolean;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

/**
 * ポリシーは **Name で引く。件数と順序では引かない。**
 *
 * `Object.values(...)[0]` は「ポリシーが 1 本しかない」ことに暗黙に依存していた。
 * 2 本になった時点で、どちらが返るかはテンプレートのキー順という**主張していない性質**で
 * 決まる。`distribution-media-behavior.test.ts:33` が同じ理由で名指しに直っている
 * （Phase 3 で /api/* が増えて「ちょうど 1 件」の形が 6 件まとめて赤くなった）。
 *
 * 接尾辞で照合するのはスタック名を前提にしないため。`${stackName}-security-headers` の
 * 前半は呼び出し側が決める。
 */
const SITE_POLICY_SUFFIX = '-security-headers';
const MEDIA_POLICY_SUFFIX = '-media-headers';

interface FoundPolicy {
  logicalId: string;
  config: Record<string, unknown>;
}

const policyByNameSuffix = (suffix: string): FoundPolicy => {
  const found = Object.entries(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))
    .map(([logicalId, resource]) => ({
      logicalId,
      config: (resource as { Properties?: { ResponseHeadersPolicyConfig?: Record<string, unknown> } })
        .Properties?.ResponseHeadersPolicyConfig,
    }))
    .filter(
      (entry): entry is FoundPolicy =>
        entry.config !== undefined &&
        typeof entry.config['Name'] === 'string' &&
        (entry.config['Name'] as string).endsWith(suffix),
    );
  expect(found, `Name が ${suffix} で終わる ResponseHeadersPolicy がちょうど 1 件`).toHaveLength(1);
  return found[0] as FoundPolicy;
};

const sitePolicy = (): FoundPolicy => policyByNameSuffix(SITE_POLICY_SUFFIX);
const mediaPolicy = (): FoundPolicy => policyByNameSuffix(MEDIA_POLICY_SUFFIX);

const policyLogicalId = (): string => sitePolicy().logicalId;

const policyProperties = (): Record<string, unknown> => sitePolicy().config;

const securityHeadersOf = (
  policy: FoundPolicy,
): Record<string, Record<string, unknown>> =>
  policy.config['SecurityHeadersConfig'] as Record<string, Record<string, unknown>>;

const securityHeaders = (): Record<string, Record<string, unknown>> =>
  securityHeadersOf(sitePolicy());

/**
 * `Cache-Control` は `CustomHeadersConfig` に入る。
 *
 * **`SecurityHeadersConfig` には Cache-Control の枠が無い**（CDK / CloudFront とも
 * セキュリティ系ヘッダしか持たない）ので、カスタムヘッダとして足す以外にない。
 */
const customHeaders = (policy: FoundPolicy): CustomHeader[] => {
  const custom = policy.config['CustomHeadersConfig'] as { Items?: CustomHeader[] } | undefined;
  return custom?.Items ?? [];
};

const cacheControlHeader = (policy: FoundPolicy): CustomHeader | undefined =>
  customHeaders(policy).find((header) => header.Header === 'Cache-Control');

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

const cspTextOf = (policy: FoundPolicy): string =>
  flatten(
    (securityHeadersOf(policy)['ContentSecurityPolicy'] as Record<string, unknown>)[
      'ContentSecurityPolicy'
    ],
  );

const cspText = (): string => cspTextOf(sitePolicy());

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

describe('**ResponseHeadersPolicy がちょうど 2 個**', () => {
  it('リソースが 2 個である', () => {
    // **1 個から 2 個に増やしたのは意図的。** サイトとメディアで Cache-Control の値が
    // 正反対（毎回検証させる / 1 年持たせる）で、1 本のポリシーでは表現できない。
    // ここは「増えたこと自体が見える」ための件数ガードなので残す。
    // **個々のポリシーの特定には使わない**（下の policyByNameSuffix を見ること）。
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 2);
  });

  it('ポリシーに名前が付いている（コンソールで識別できる）', () => {
    expect(typeof policyProperties()['Name']).toBe('string');
    expect(typeof mediaPolicy().config['Name']).toBe('string');
  });

  it('**2 本の論理 ID が別物である**（同じリソースを 2 回数えていない）', () => {
    expect(sitePolicy().logicalId).not.toBe(mediaPolicy().logicalId);
  });
});

describe('**Cache-Control**（ブラウザのヒューリスティックキャッシュを止める）', () => {
  // 実測: 修正前は配信 HTML に Cache-Control が 1 つも無かった。
  // Cache-Control も Expires も無いとブラウザは *ヒューリスティックキャッシュ* を適用し、
  // 一般に Last-Modified からの経過時間の 10% 程度を勝手にキャッシュ期間にする。
  // デプロイ時の invalidation は CloudFront にしか効かないので、
  // **一度サイトを見た人は不定の時間だけ古い HTML を見続ける。** 実際に踏んだ。

  it('サイト側に Cache-Control が入っている', () => {
    expect(cacheControlHeader(sitePolicy())?.Value).toBe(SITE_CACHE_CONTROL);
  });

  it('メディア側に Cache-Control が入っている', () => {
    expect(cacheControlHeader(mediaPolicy())?.Value).toBe(MEDIA_CACHE_CONTROL);
  });

  it('**2 つの値が異なる**（同じポリシーを 2 本並べただけになっていない）', () => {
    const site = cacheControlHeader(sitePolicy())?.Value;
    const media = cacheControlHeader(mediaPolicy())?.Value;
    expect(site).toBeDefined();
    expect(media).toBeDefined();
    expect(site).not.toBe(media);
  });

  it('**サイト側は再利用の前に必ず検証させる**（no-cache 相当である）', () => {
    // 値そのものを固定するのではなく、性質を主張する。定数を書き換えたときに
    // 「意味が変わっていないか」が見える。
    const value = cacheControlHeader(sitePolicy())?.Value ?? '';
    expect(value).toMatch(/no-cache|max-age=0/);
    expect(value).not.toMatch(/max-age=[1-9]/);
  });

  it('**メディア側は長く持たせる**（キーがランダムで上書きされない）', () => {
    // api/src/media/presign.ts のキーは media/YYYY/MM/<randomBytes(12) の 24 桁 hex>.<ext>。
    // 同じキーが二度使われないので immutable が成立する。
    const value = cacheControlHeader(mediaPolicy())?.Value ?? '';
    expect(value).toContain('immutable');
    expect(value).toMatch(/max-age=\d{6,}/);
  });

  it('両方とも Override が true である', () => {
    expect(cacheControlHeader(sitePolicy())?.Override).toBe(true);
    expect(cacheControlHeader(mediaPolicy())?.Override).toBe(true);
  });

  it('**カスタムヘッダは Cache-Control だけ**（他のヘッダが紛れ込んでいない）', () => {
    expect(customHeaders(sitePolicy()).map((header) => header.Header)).toEqual(['Cache-Control']);
    expect(customHeaders(mediaPolicy()).map((header) => header.Header)).toEqual(['Cache-Control']);
  });
});

describe('**CSP が 2 本のポリシーで一致している**', () => {
  it('メディア側にも CSP がある（分割で落ちていない）', () => {
    expect(cspTextOf(mediaPolicy()).length).toBeGreaterThan(0);
  });

  it('**2 本の CSP が同一である**（片方だけ古くなる乖離が起きていない）', () => {
    // securityHeadersBehavior を 1 つのローカル変数から共有しているので、
    // ここが食い違ったら「片方に直接書いた」ということ。
    expect(cspTextOf(mediaPolicy())).toBe(cspTextOf(sitePolicy()));
  });

  it('**他のセキュリティヘッダも 2 本で一致している**', () => {
    for (const key of ['ContentTypeOptions', 'ReferrerPolicy', 'FrameOptions', 'StrictTransportSecurity']) {
      expect(securityHeadersOf(mediaPolicy())[key], `${key} がメディア側で欠けている`).toEqual(
        securityHeadersOf(sitePolicy())[key],
      );
    }
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

  it('**/media/* には別のポリシーが付いている**（同じものを使い回していない）', () => {
    // **意図的に反転させた主張。** 以前は「/media/* にも同じポリシー」を固定していたが、
    // Cache-Control の値がサイトと正反対（毎回検証させる / 1 年持たせる）なので
    // 1 本では表現できない。CSP など他のヘッダが落ちていないことは
    // 「CSP が 2 本のポリシーで一致している」の describe が別に固定している。
    const media = (distributionConfig().CacheBehaviors ?? []).find(
      (behavior) => behavior.PathPattern === MEDIA_PATH_PATTERN,
    );
    expect(media, `${MEDIA_PATH_PATTERN} のビヘイビアが無い`).toBeDefined();
    expect(media?.ResponseHeadersPolicyId).toEqual({ Ref: mediaPolicy().logicalId });
    expect(media?.ResponseHeadersPolicyId).not.toEqual({ Ref: policyLogicalId() });
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

  it("**`style-src-attr` を設定しない。** 対称に見えるが、足すと shiki が色を失う", () => {
    // `script-src-attr 'none'` と並べると「style 側も閉じるべき」に見える。**閉じてはいけない。**
    //
    // shiki はコードフェンスを `style="color:#F97583"` のような **属性**で色付けする
    // （実測: ts のフェンス 1 本で `style=` 属性 8 個、`<style>` ブロック 0 個）。
    // `style-src-attr` を設定すると `style=` 属性はそちらに支配され、
    // `style-src` の `'unsafe-inline'` は**届かなくなる**。設定しないことで
    // `style-src` にフォールバックし、属性が許可される。
    //
    // **バイト一致テストはこれを捕まえない。** 公開済み記事にコードフェンスがまだ無いので
    // `site/dist` の `style=` 属性は 0 個であり、`published-html.test.ts` は素通りする。
    // admin/test/parity/corpus.test.ts と同じ穴で、こちらは CSP 側の対になる。
    expect(
      directives().has('style-src-attr'),
      "style-src-attr を足すと shiki のシンタックスハイライトが無色になる。" +
        "script-src-attr 'none' との非対称は意図的である",
    ).toBe(false);
  });

  it("`script-src-attr` は 'none' のまま（インラインイベントハンドラを止める本体）", () => {
    // onerror= / onload= を止めているのはこれ。style 側と違い、ここは閉じる。
    expect(directive('script-src-attr')).toEqual(["'none'"]);
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
