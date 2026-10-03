# テンプレートの検証結果

## 検証結果（aws-cdk-lib 2.267.0 / aws-cdk 2.1139.0 で実測）

### cfn-lint

`validate_cloudformation_template` — **Phase 4 時点の実測（2026-08-31）。**

| スタック | 結果 |
| --- | --- |
| `BlogCicdStack` | **0 error / 0 warning / 0 info** |
| `BlogSiteStack` | **0 error / 1 warning / 0 info**（Phase 3 から変化なし。Cognito 3 リソースと CORS の追加で **1 件も増えなかった**） |

**`E3004`（Circular Dependencies）は 0 件。** これは形式的な確認ではない。
メディアバケットの CORS の `AllowedOrigins` に `distribution.distributionDomainName` を
入れると循環参照になり、**`cdk synth` は exit 0 で素通しする**（実測）。
`E3004` を見ているのが実質的な最後の砦なので、**この確認を省略しないこと**
（`infra/docs/cdk-structure.md` の「`SITE_ORIGIN` 定数」）。

唯一の指摘は **`W3005`**。

```
W3005 'PostingApiExecutionRoleC51CD7D8' dependency already enforced by a 'GetAtt'
      at 'Resources/PostingApiFunctionEFE83FA3/Properties/Role'
```

**トリアージ: 受容する。** これは CDK が `AWS::Lambda::Function` に自動で付ける
`DependsOn: [<Role>DefaultPolicy, <Role>]` のうち、`Role` のほうが `Fn::GetAtt` で
既に暗黙の依存になっているという指摘である。しかし **`DefaultPolicy` への依存は暗黙にはならず、
消すとポリシー添付前に関数が作られて実行時に権限不足になりうる**ため、CDK は意図的に両方を書いている。
ユーザコードから片方だけ削るにはエスケープハッチが要り、得られるのは lint の 1 行、
失うのはデプロイ順序の保証である。割に合わない。

### cfn-guard（bundled `aws-security` ルールセット）

| スタック | 結果 |
| --- | --- |
| `BlogCicdStack` | **0 件（COMPLIANT）** |
| `BlogSiteStack` | **6 件**。すべて S3 関連で、CloudFront・IAM・**Cognito** への指摘は 0 件 |

6 件の内訳は `S3_BUCKET_DEFAULT_LOCK_ENABLED` / `S3_BUCKET_LOGGING_ENABLED` /
`S3_BUCKET_NO_PUBLIC_RW_ACL` / `S3_BUCKET_REPLICATION_ENABLED` /
`S3_BUCKET_SSL_REQUESTS_ONLY` / `S3_BUCKET_VERSIONING_ENABLED`。
**Phase 1 から件数もルール ID も動いていない**（Phase 4 と Phase 5 は 2026-08-31 に実測）。

| 追加したもの | 指摘件数 | 増分 |
| --- | --- | --- |
| Phase 2: IAM ロール / IAM ポリシー / OIDC プロバイダ / 追加ビヘイビア / `CustomErrorResponses` | 6 件 | **0 件** |
| Phase 3: Lambda 一式（下記） | 6 件 | **0 件** |
| Phase 4: Cognito 一式（下記） | 6 件 | **0 件** |
| Phase 5: ResponseHeadersPolicy（下記） | 6 件 | **0 件** |

**6 件が「ツールが動いていない」ではなく「本当に増えていない」と分かるように**、
1 件も指摘を生まなかったリソース種別を列挙しておく（bundled `aws-security` ルールセットには
**Cognito のルールが 1 つも無い**）。

- Phase 3: `AWS::Lambda::Function` / `AWS::Lambda::Url` / `AWS::Lambda::Permission` /
  `AWS::SecretsManager::Secret` / `AWS::Logs::LogGroup` / `AWS::IAM::Role` / `AWS::IAM::Policy` /
  3 本目の `AWS::CloudFront::OriginAccessControl`（`lambda` タイプ）/ `/api/*` の追加ビヘイビア
- Phase 4: `AWS::Cognito::UserPool` / `AWS::Cognito::UserPoolClient` /
  `AWS::Cognito::UserPoolDomain` / メディアバケットの `CorsConfiguration`（S3 の 5 ルールは
  **CORS の有無と無関係に**発火するので、件数もルール ID も変わらない）
- Phase 5: `AWS::CloudFront::ResponseHeadersPolicy` / `defaultBehavior` と `/media/*` の
  `ResponseHeadersPolicyId`

cfn-lint も Phase 5 で変化なし（`BlogSiteStack` は error 0 / warning 1 / info 0。warning は既知の
`W3005`。`BlogCicdStack` は 0/0/0）。

**違反は `resource: "Unknown"` とルール単位に集約されて返る**ので、どのバケットが原因かは
ツール側からは特定できない。したがって受け入れ条件は「0 件」ではなく
**「全件をトリアージして理由付きで記録する」** こととする（指摘どおりに直すと、ログ用バケットが
新たな違反を生んで 6 件 → 8 件に増えるため、この構成では原理的に 0 件にできない）。
バケットが 2 個あるので、下表は **バケットごとに判断を分けて** 書く。

> **重要な観察: メディアバケットに `versioned: true` を入れても `S3_BUCKET_VERSIONING_ENABLED` は消えない。**
> ルール単位の集約なので、テンプレート内に 1 つでも条件を満たさないバケット（＝配信用）があれば
> 発火し続ける。件数だけ見ていると「対応しても減らない」ように見えるが、実際にはメディア側は対応済みである。

| ルール | 配信用 `SiteBucket` | メディア用 `MediaBucket` | 理由 |
| --- | --- | --- | --- |
| `S3_BUCKET_SSL_REQUESTS_ONLY` | **対応済み（誤検知）** | **対応済み（誤検知）** | どちらも `enforceSSL: true` で `aws:SecureTransport=false` の Deny 文が入っている。ルールは remediation に `"Resource":"*"` を期待するが、CDK は Resource をバケット ARN と `<ARN>/*` に絞る。絞ったほうが厳しいので、ルールの形に合わせて緩める理由がない |
| `S3_BUCKET_NO_PUBLIC_RW_ACL` | **対応済み（誤検知）** | **対応済み（誤検知）** | どちらもブロックパブリックアクセス 4 つとも `true`、`AccessControl`（ACL）は未設定。`Principal` がワイルドカードなのは SecureTransport の **Deny** 文だけで、`Allow` のワイルドカードは 0 件（`test/distribution-oac.test.ts` が固定） |
| `S3_BUCKET_VERSIONING_ENABLED` | **意図的に見送り** | **対応済み** | 配信用は `sync --delete` のたびに削除マーカーと旧版が溜まるだけで、中身は Git から完全に再生成できる。メディアは「画像を Git に入れない」方針（`AGENTS.md`）により Git から再生成できない唯一の資産なので有効にし、`noncurrentVersionExpiration: 90 日` で無限増加を防いでいる。**この非対称は意図的**で、`test/media-bucket.test.ts` が両方向を固定している |
| `S3_BUCKET_DEFAULT_LOCK_ENABLED` | **意図的に見送り** | **意図的に見送り** | 配信用は毎デプロイ `sync --delete` で作り直す成果物で、オブジェクトロックは上書き・削除と正面から衝突する。メディアは誤削除対策をバージョニングで足りると判断した（オブジェクトロックは一度有効にすると解除できず、運用の自由度を大きく損なう） |
| `S3_BUCKET_REPLICATION_ENABLED` | **意図的に見送り** | **意図的に見送り（後続フェーズで再検討の余地）** | 配信用は Git から再生成可能なので費用しか生まない。メディアは再生成できないぶん価値はゼロではないが、個人ブログの規模ではバージョニング + `Retain` で足りると判断した |
| `S3_BUCKET_LOGGING_ENABLED` | **意図的に見送り（後続フェーズで再検討）** | **意図的に見送り（後続フェーズで再検討）** | S3 サーバアクセスログには第 3 のバケットが要り、そのバケット自体が新たな違反を生む（実測で 6 件 → 8 件に増える）。必要になった時点で CloudFront 標準ログとあわせて運用フェーズで設計する |
