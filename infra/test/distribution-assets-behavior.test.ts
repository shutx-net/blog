import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ASTRO_ASSETS_PATH_PATTERN, SiteStack } from '../lib/site-stack.ts';

interface CacheBehavior {
  PathPattern?: string;
  TargetOriginId?: string;
  CachePolicyId?: string;
  ResponseHeadersPolicyId?: unknown;
  FunctionAssociations?: unknown;
}

interface DistributionConfig {
  CacheBehaviors?: CacheBehavior[];
  DefaultCacheBehavior?: CacheBehavior;
}

const template = Template.fromStack(new SiteStack(new App(), 'TestStack'));

const distributionConfig = (): DistributionConfig => {
  const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as
    | { Properties?: { DistributionConfig?: DistributionConfig } }
    | undefined;
  return dist?.Properties?.DistributionConfig ?? {};
};

/**
 * PathPattern で **名指しして** 取る（`distribution-media-behavior.test.ts` と同じ骨格）。
 *
 * 件数で位置を特定する形はビヘイビアが増えるたびに壊れる。総数と並び順は
 * `distribution-media-behavior.test.ts` が別に固定しているので、緩めたことにはならない。
 */
const assetsBehavior = (): CacheBehavior => {
  const found = (distributionConfig().CacheBehaviors ?? []).filter(
    (behavior) => behavior.PathPattern === ASTRO_ASSETS_PATH_PATTERN,
  );
  expect(
    found,
    `${ASTRO_ASSETS_PATH_PATTERN} のビヘイビアがちょうど 1 件であること`,
  ).toHaveLength(1);
  return found[0] as CacheBehavior;
};

const defaultBehavior = (): CacheBehavior => {
  const behavior = distributionConfig().DefaultCacheBehavior;
  expect(behavior, 'DefaultCacheBehavior が無い').toBeDefined();
  return behavior as CacheBehavior;
};

/** ポリシーは **Name で引く。件数と順序では引かない**（3 本あるので `[0]` は何も意味しない）。 */
const policyLogicalIdByNameSuffix = (suffix: string): string => {
  const found = Object.entries(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))
    .filter(([, resource]) => {
      const name = (
        resource as { Properties?: { ResponseHeadersPolicyConfig?: { Name?: unknown } } }
      ).Properties?.ResponseHeadersPolicyConfig?.Name;
      return typeof name === 'string' && name.endsWith(suffix);
    })
    .map(([logicalId]) => logicalId);
  expect(found, `Name が ${suffix} で終わる ResponseHeadersPolicy がちょうど 1 件`).toHaveLength(1);
  return found[0] as string;
};

describe('/_astro/* の追加ビヘイビア', () => {
  it('PathPattern が定数と一致する', () => {
    expect(assetsBehavior().PathPattern).toBe(ASTRO_ASSETS_PATH_PATTERN);
  });

  it('PathPattern がリテラル "/_astro/*" である', () => {
    // 定数だけで比較するとパスを変えたときテストが一緒に動いてしまい固定にならない
    // （`distribution-media-behavior.test.ts` と同じ理由）。**ここが実際の URL 空間を縛る。**
    //
    // `_astro` は Astro の `build.assets` の既定値なので、この文字列が
    // `site/astro.config.mjs` の出力先と一致していることは下の describe が別に見る。
    expect(assetsBehavior().PathPattern).toBe('/_astro/*');
  });

  it('**デフォルトビヘイビアと同じオリジンを向いている**（インスタンスを再利用している）', () => {
    // **これがオリジンのインスタンス再利用という「見えない依存」の直接の主張である。**
    //
    // `Distribution.addOrigin` は `boundOrigins.find(b => b.origin === origin)` と
    // **インスタンス同一性**で既存のオリジン ID を引き当てる（aws-cdk-lib 2.267.0）。
    // `origins.S3BucketOrigin.withOriginAccessControl(siteBucket)` を 2 回呼ぶと、同じ
    // バケットなのに **Origins 4 / OAC 4** になり、2 本目の OAC
    // （実測 `SiteDistributionOrigin4S3OriginAccessControl505731E1`）が生える。
    //
    // そのとき落ちるのは `distribution-oac.test.ts`（論理 ID 集合をリテラルで固定）と
    // `distribution-media-behavior.test.ts`（Origins がちょうど 3 件）で、**どちらも
    // 「同じオリジンを向いている」とは言っていない。** 逆にここは、オリジンが 3 本に
    // 戻っていても `/_astro/*` だけメディアバケットを向いた状態を落とす。**二重化である。**
    const target = assetsBehavior().TargetOriginId;
    expect(target, 'TargetOriginId が無い').toBeDefined();
    expect(target).toBe(defaultBehavior().TargetOriginId);
  });

  it('**ResponseHeadersPolicyId が assets 用ポリシーの Ref である**（デフォルトとは別物）', () => {
    // **別のマネージドポリシー ID が入っていても通る形にしない。** 論理 ID を突き合わせる。
    // デフォルトのポリシーを使い回すと Cache-Control が `no-cache` になり、
    // **immutable を宣言した目的がそのまま消える**（何も壊れたようには見えない）。
    expect(assetsBehavior().ResponseHeadersPolicyId).toEqual({
      Ref: policyLogicalIdByNameSuffix('-assets-headers'),
    });
    expect(assetsBehavior().ResponseHeadersPolicyId).not.toEqual(
      defaultBehavior().ResponseHeadersPolicyId,
    );
  });

  it('**FunctionAssociations が無い**', () => {
    // `rewrite-uri.js` は最終セグメントにドットがある URI を素通しするので
    // `/_astro/Layout.<hash>.css` には何もしない。**付けても動く**が、
    // `distribution-behavior.test.ts` が「デフォルト以外に Function が付いていない」を
    // 全ビヘイビア走査で固定しているので、そちらと二重化しておく。
    expect(assetsBehavior().FunctionAssociations).toBeUndefined();
  });

  it('**CachePolicyId がデフォルトビヘイビアと同じ**（独自キャッシュポリシーを作っていない）', () => {
    // エッジの TTL は既定の Managed-CachingOptimized（DefaultTTL 86400）のままにする。
    // **閲覧者に届く `Cache-Control` を決めるのは ResponseHeadersPolicy のほう**で、
    // 独自キャッシュポリシーで 1 年にしても違いは「POP ごとに 1 日 1 回 S3 まで検証に
    // 行くかどうか」だけ。閲覧者から見える差は無く、リソースと概念が 1 つ増える。
    const policyId = assetsBehavior().CachePolicyId;
    expect(policyId, 'CachePolicyId が無い').toBeDefined();
    expect(policyId).toBe(defaultBehavior().CachePolicyId);
  });
});

// ---- `site/astro.config.mjs` のテキスト走査（site-origins.test.ts が deploy.yml を読むのと同じ越境） ----

const CONFIG_PATH = fileURLToPath(new URL('../../site/astro.config.mjs', import.meta.url));

const configSource = (): string => {
  expect(existsSync(CONFIG_PATH), `${CONFIG_PATH} が存在すること`).toBe(true);
  return readFileSync(CONFIG_PATH, 'utf8');
};

/**
 * コメント行を落とした行だけを返す。
 *
 * **散文を読んではいけない。** `site/astro.config.mjs` のコメントには `build` も `assets` も
 * `_astro` も出てくる（実測: 「the build, but sitemap only logs a warning」
 * 「pins build.assets and build.assetsPrefix as unset」）。全文を `/assets\s*:/` で見る形は、
 * 将来コメントに `assets:` と書いた日に**本物の上書きと区別できない。**
 *
 * 落とすのは**行全体がコメントである行だけ**（行コメントの開始、ブロックコメントの開始、
 * JSDoc 継続行の `*`）。行の途中の `//` には触らない — `https://` を壊すため。
 * 1 行の中でブロックコメントが閉じてコードが続く形は扱えないが、**行を残す側に倒してある**
 * ので、見落とし（偽陰性）ではなく誤検出（偽陽性）の方向にしか外れない。
 */
const codeLinesOf = (source: string): string[] =>
  source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed.length > 0 &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('/*') &&
      !trimmed.startsWith('*')
    );
  });

/**
 * `<key>:` という**キーの代入**が現れるコード行。
 *
 * 前後境界を見るので `assets` は `assetsPrefix` を巻き込まず、`myassets` にも当たらない。
 */
const keyLinesOf = (source: string, key: string): string[] =>
  codeLinesOf(source).filter((line) =>
    new RegExp(`(^|[^A-Za-z0-9_$])${key}\\s*:`).test(line),
  );

const keyLines = (key: string): string[] => keyLinesOf(configSource(), key);

/**
 * **`immutable` の前提は infra 側では保証できない。**
 *
 * `/_astro/*` に 1 年を宣言できる根拠は 2 つとも `site/` にある:
 *
 *   1. 出力先が `_astro` であること（Astro の `build.assets` の既定値）。
 *   2. そもそも外部ファイルとして出ること（`build.inlineStylesheets: "never"`）。
 *
 * どちらが崩れても **CloudFront 側は何も変わらない。** パターンに一致しなくなるだけで
 * ヘッダは静かに `no-cache` へ戻り、あるいは配るものが無くなる。**一致を主張する場所が
 * ここしかない。**
 *
 * **`site/test/unit/stylesheets.test.ts` と二重化している。どちらも相手の上位集合ではない** —
 * あちらは `astro.config.mjs` を import して**設定オブジェクトの値**を読むので、`build` を
 * 組み立てたり spread した形でも解決する。こちらはテキストなので import を通さないが、
 * **CDN の宣言とこの設定ファイルを結び付けているのはこちらだけ**である（あのファイルは
 * infra の定数を知らない）。
 */
describe('**`immutable` の前提が site 側で崩れていない**', () => {
  it('走査が空振りしていない（`inlineStylesheets` のキーがちょうど 1 行ある）', () => {
    // 行の除去がソースを食い尽くした場合、下の 2 本（不在の主張）は**空振りで緑になる。**
    // 非空ガードを先に置く（`distribution-media-behavior.test.ts` の「permission が
    // ちょうど 2 本ある（非空を先に確かめる）」と同じ形）。
    expect(keyLines('inlineStylesheets')).toHaveLength(1);
  });

  it('**`build.assets` を上書きしていない**（既定の `_astro` のまま）', () => {
    // **ここを変えると CloudFront の `/_astro/*` が一致しなくなり、Cache-Control が
    // 黙って `no-cache` に戻る。** ビルドは通り、ページも正しく表示され、
    // ただ 1 年の宣言だけが無効になる。
    expect(keyLines('assets'), 'build.assets が上書きされている').toEqual([]);
  });

  it('**`build.assetsPrefix` を上書きしていない**（資産が同一オリジンに留まる）', () => {
    // プレフィックスは参照を別オリジンに書き換える。`style-src 'self'` も
    // `/_astro/*` ビヘイビアも、同一オリジンであることを前提に書かれている。
    expect(keyLines('assetsPrefix'), 'build.assetsPrefix が上書きされている').toEqual([]);
  });

  it('**`inlineStylesheets` が "never" である**', () => {
    // 既定の `"auto"` に戻ると、ビルド後の CSS が vite の 4096 B を下回った日に
    // **`/_astro/*` に配るものが無くなる**（実測: 3643 B で 13/13 の HTML が
    // インライン `<style>` を持ち、`dist/_astro/` は空になった）。本番ではそれは
    // `style-src 'self'` に全ページまとめてブロックされる状態でもある。
    const line = keyLines('inlineStylesheets')[0] ?? '';
    expect(line).toMatch(/inlineStylesheets\s*:\s*["']never["']/);
  });

  it('コメント行の除去そのものが機能する（散文の `assets:` を拾わない）', () => {
    // 検出規則を自己検査する（`distribution-response-headers.test.ts` の
    // 「検出規則そのものが機能する」と同じ流儀）。これが無いと、除去が行き過ぎて
    // 全行を落とす実装でも上の不在の主張は緑になる。
    expect(codeLinesOf('  // CloudFront serves assets: from /_astro/*')).toEqual([]);
    expect(codeLinesOf('   * pins build.assets and build.assetsPrefix as unset')).toEqual([]);
    expect(codeLinesOf('  /* assets: "static", */')).toEqual([]);
    expect(codeLinesOf('    assets: "static",')).toEqual(['    assets: "static",']);
  });

  it('`assets` の照合が `assetsPrefix` を巻き込まない', () => {
    // 巻き込むと「`assetsPrefix` を書いたら `assets` の主張も落ちる」という
    // 原因の読めない赤になる。逆に境界を見ないと `myassets:` でも落ちる。
    expect(keyLinesOf('  assetsPrefix: "https://cdn.example/",', 'assets')).toEqual([]);
    expect(keyLinesOf('  assets: "static",', 'assets')).toHaveLength(1);
    expect(keyLinesOf('  assetsPrefix: "https://cdn.example/",', 'assetsPrefix')).toHaveLength(1);
  });
});
