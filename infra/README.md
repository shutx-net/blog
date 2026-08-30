# infra

`BlogSiteStack` — 非公開 S3 + CloudFront (OAC) による静的サイト配信の CDK スタック。

## コマンド

```sh
npm run -w infra test        # pretest で cdk synth してから vitest run
npm run -w infra typecheck   # tsc --noEmit（型検査のみ。テスト実行には使わない）
npx -w infra cdk synth BlogSiteStack
npx -w infra cdk diff        # deploy の前に必ず。PR 本文に貼る（AGENTS.md）
```

`test/synth-artifact.test.ts` はディスク上の `cdk.out/BlogSiteStack.template.json` を読むため、
`pretest` で必ず `cdk synth` を先に走らせている。単体で `vitest run` する場合は先に synth すること。

## 構成

| リソース | 論理 ID | 要点 |
| --- | --- | --- |
| `AWS::S3::Bucket` | `SiteBucket397A1860` | ブロックパブリックアクセス 4 つとも有効 / SSE-S3 / `enforceSSL` / `DeletionPolicy: Retain` |
| `AWS::S3::BucketPolicy` | `SiteBucketPolicy3AC1D0F8` | SecureTransport=false の Deny と、CloudFront への `s3:GetObject` Allow のみ |
| `AWS::CloudFront::OriginAccessControl` | `SiteDistributionOrigin1S3OriginAccessControl7D960FE6` | `s3` / `always` / `sigv4` |
| `AWS::CloudFront::Distribution` | `SiteDistribution3FF9535D` | `redirect-to-https` / `DefaultRootObject: index.html` |
| `AWS::CloudFront::Function` | `RewriteUriFunctionF5D8A5AC` | `cloudfront-js-2.0` / viewer-request |

バケットの論理 ID は `test/site-bucket.test.ts` で固定している。ステートフル資源の論理 ID が
変わると置換（＝バケット作り直し）になるため、リファクタで動かさないこと。

## 検証結果（aws-cdk-lib 2.267.0 / aws-cdk 2.1139.0 で実測）

### cfn-lint

`validate_cloudformation_template` — **0 error / 0 warning / 0 info**。

### cfn-guard（bundled `aws-security` ルールセット）

**6 件の違反。すべて S3 関連で、CloudFront への指摘は 0 件。**
このルールセットはこの構成では原理的に 0 件にできない（指摘どおりに直すと、ログ用バケットが
新たな違反を生んで件数が増える）。したがって受け入れ条件は「0 件」ではなく
「全件をトリアージして理由付きで記録する」こととする。

違反は `resource: "Unknown"` とルール単位で集約されて返るため、どのリソースが原因かは
ツール側からは特定できない。本スタックのバケットは 1 個なので下表の判断は一意に定まる。

| ルール | 判断 | 理由 |
| --- | --- | --- |
| `S3_BUCKET_SSL_REQUESTS_ONLY` | **対応済み（誤検知）** | `enforceSSL: true` により `aws:SecureTransport=false` を Deny する文が実際に入っている。ルールは remediation に `"Resource":"*"` を期待するが、CDK は Resource をバケット ARN と `<ARN>/*` に絞る。絞ったほうが厳しいので、ルールの期待する形に合わせて緩める理由がない |
| `S3_BUCKET_NO_PUBLIC_RW_ACL` | **対応済み（誤検知）** | ブロックパブリックアクセス 4 つとも `true`、`AccessControl`（ACL）プロパティは未設定。テンプレート中で `Principal` がワイルドカードなのは SecureTransport の **Deny** 文だけで、`Allow` のワイルドカードは 0 件（`test/distribution-oac.test.ts` で機械的に固定済み） |
| `S3_BUCKET_DEFAULT_LOCK_ENABLED` | **意図的に見送り** | 配信物は毎デプロイ `aws s3 sync --delete` で作り直す静的ビルド成果物。オブジェクトロックは上書き・削除と正面から衝突する |
| `S3_BUCKET_VERSIONING_ENABLED` | **意図的に見送り** | 同上。`sync --delete` のたびに削除マーカーと旧版が溜まり続け、ストレージ費用が増えるだけ。中身は Git から完全に再生成できる |
| `S3_BUCKET_REPLICATION_ENABLED` | **意図的に見送り** | Git から再生成可能なビルド成果物に対するクロスリージョンレプリケーションは費用しか生まない |
| `S3_BUCKET_LOGGING_ENABLED` | **意図的に見送り（後続フェーズで再検討）** | S3 サーバアクセスログには第 2 のバケットが要り、そのバケット自体が新たな違反を生む（実測で 6 件 → 8 件に増える）。必要になった時点で CloudFront 標準ログとあわせて運用フェーズで設計する |

## TODO（本フェーズで意図的に残した宿題）

- **403 が 404 にならない。** OAC + S3 REST オリジンでは、存在しないキーへのリクエストが
  404 ではなく **403 (AccessDenied)** で返る。バケットポリシーが `s3:GetObject` しか許して
  いない（`s3:ListBucket` が無い）ため、S3 が「存在しない」と「権限が無い」を区別させない仕様による。
  結果、`/nonexistent/index.html` が無いとき閲覧者には 403 が見える。
  **対応**: `site/` 側に `404.html` を作るフェーズで、CloudFront の `errorResponses` に
  403 と 404 の両方を `/404.html`・`responseHttpStatus: 404` へマップし、
  そのときテンプレートアサーションを追加する。本フェーズでは 404.html の実体が無いので入れない。
- **TLS 最低バージョンを上げられない。** デフォルトの `*.cloudfront.net` 証明書を使う限り
  ディストリビューションは TLSv1 のセキュリティポリシーに固定され、`minimumProtocolVersion` は
  カスタム証明書を指定したときにしか描画されない。カスタムドメイン + ACM を入れるフェーズで
  `SecurityPolicyProtocol.TLS_V1_2_2021` を設定する。`cdk.json` の context に
  `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021: true` を入れて地ならしだけ済ませてある。

## 設計上の約束ごと

### CloudFront Function は ES5.1 の範囲で書く

`functions/rewrite-uri.js` は CloudFront Functions のランタイムで動く。ローカルの単体テストは
node 24 の `node:vm` 上で走るため、**実ランタイムより大幅に寛容**で、ローカル green でも
デプロイ後に落ちうる。node 側に ES5.1 相当への静的な制限機構は無いので、規律で守る。

- `var` / `lastIndexOf` / `charAt` の範囲で書く。`const` / `let` / アロー関数 / `endsWith` を使わない
- ランタイムは `cloudfront-js-2.0` に固定してある（CDK の既定は `JS_1_0`。省略すると静かに 1.0 に落ちる）
- テストハーネスはソースの先頭に `'use strict';` を付けて評価する。CloudFront Functions は
  常に strict mode で動作し、これは変更できないため
- 実ランタイムでの検証は、デプロイを行うフェーズで `aws cloudfront test-function` による
  スモークテストとして足す

### 記事スラッグにドットを使わない

URI 書き換えは「最後のスラッシュより後にドットがあれば静的ファイル」というヒューリスティック。
そのため `/posts/node-24.19-notes` のようなドット入りスラッグは書き換えられない
（`test/rewrite-uri.test.ts` に既知の限界として固定済み）。
`site/src/content.config.ts` の Zod スキーマでスラッグを検証する際にドットを弾くこと。

### cdk_best_practices との既知の乖離

いずれも意図的。

- **`env` を明示していない。** 本フェーズは AWS 認証情報が無く、env-agnostic でないと
  `cdk synth` が資格情報を要求しうる。`env` はデプロイを扱う `CicdStack` のフェーズで導入する
- **ステートフル（S3）とステートレス（CloudFront）を同一スタックに置いている。**
  個人ブログでバケットの中身は Git から完全に再生成できるビルド成果物であり「ステートフル」の
  実質が薄い。スタックを割るとクロススタック参照が増え、`withOriginAccessControl` による
  バケットポリシーの自動更新（同一スタック内で行われる）が使えなくなる副作用のほうが大きい
- **`terminationProtection` を設定していない。** `removalPolicy: RETAIN` でバケット自体は
  保護しており、個人ブログの規模には過剰と判断した
- **`cdk init` を使っていない。** 空ディレクトリを要求し独自の `package.json` と jest 構成を
  吐くうえ、CDK CLI が PATH に無く `npx -w infra cdk` は `infra/package.json` が先に無いと
  呼べない（鶏と卵）。そのため `cdk.json` の context（フィーチャーフラグ）は手で書いている
- **cdk-nag を入れていない。** `cdk_best_practices` が「適用前に必ずユーザーの同意を取れ」と
  明示しているため、導入可否は人間の判断待ち

### ツールチェーン

- `aws-cdk-lib` と `aws-cdk`（CLI）は **完全固定**（`^` を付けない）。両者のバージョンを
  ずらさないため。`test/toolchain.test.ts` が固定文字列であることを機械的に検査している
- CDK CLI は nix ではなく npm の devDependency。必ず `npx -w infra cdk` で呼ぶ（DEVELOPERS.md）
- TypeScript のトランスパイラは入れていない。node 24 の型ストリップで `node bin/blog.ts` が
  そのまま動くため、`cdk.json` の `app` は `node bin/blog.ts`。ts-node も tsx も要らない
- その代償として **erasable syntax のみ**に制限される（enum / namespace / パラメータプロパティ /
  decorators が使えない）。`tsconfig.json` の `"erasableSyntaxOnly": true` で型検査時に強制している。
  これが無いと enum を書いた瞬間に `cdk synth` だけが実行時に落ちる
- `"type": "module"` なので相対 import は拡張子必須（`./site-stack.ts` のように `.ts` まで書く）
