# infra

- `BlogSiteStack` — 非公開 S3 + CloudFront (OAC) による静的サイト配信。配信用とメディア用の 2 バケット。
- `BlogCicdStack` — GitHub Actions が OIDC で assume する最小権限のデプロイロール。

## コマンド

```sh
npm run -w infra test        # pretest で cdk synth（全スタック）してから vitest run
npm run -w infra typecheck   # tsc --noEmit（型検査のみ。テスト実行には使わない）
npx -w infra cdk synth       # スタック名を省くと全スタックを cdk.out に書き出す
npx -w infra cdk diff        # deploy の前に必ず。PR 本文に貼る（AGENTS.md）
```

`test/synth-artifact.test.ts` はディスク上の `cdk.out/*.template.json` を **両スタック分** 読むため、
`pretest` で必ず `cdk synth` を先に走らせている。単体で `vitest run` する場合は先に synth すること。
`pretest` でスタックを名指ししないのは、名指しすると片方のスタックの synth 崩れをテスト前に
検出できなくなるため（`test/toolchain.test.ts` が機械的に固定している）。

`cdk synth` に `--all` というオプションは無い（指定すると `Unknown option(s): --all` と言われて無視される）。

## ドキュメント

| ファイル | 何が書いてあるか |
| --- | --- |
| [`docs/stacks.md`](docs/stacks.md) | スタックとリソースの構成 |
| [`docs/deploy.md`](docs/deploy.md) | デプロイ手順と実デプロイで判明したこと |
| [`docs/validation.md`](docs/validation.md) | cfn-lint と cfn-guard の結果 |
| [`docs/security-headers.md`](docs/security-headers.md) | CSP / HSTS とその観測の限界 |
| [`docs/custom-domain.md`](docs/custom-domain.md) | blog.shutx.net の手順書と ACM 自動更新の前提 |
| [`docs/cloudfront-caching.md`](docs/cloudfront-caching.md) | 配信の実測値と `Cache-Control` の裁定 |
| [`docs/cloudfront-routing.md`](docs/cloudfront-routing.md) | URI 書き換え・エラーページ・ビヘイビアの宣言順 |
| [`docs/api-auth.md`](docs/api-auth.md) | 投稿 API の認証とトークンの運び方 |
| [`docs/cdk-structure.md`](docs/cdk-structure.md) | スタックの割り方・`SITE_ORIGIN`・ツールチェーン |
| [`docs/cicd-oidc.md`](docs/cicd-oidc.md) | OIDC の信頼ポリシーとデプロイロールの権限 |
| [`docs/test-patterns.md`](docs/test-patterns.md) | 複数リソースに対するアサーションの書き方 |

## TODO

- **refresh token rotation を入れていない。** Essentials で使えるが、aws-cdk-lib 2.267.0 の
  `configureAuthFlows` が `props.refreshTokenRotationGracePeriod || authFlows.push('ALLOW_REFRESH_TOKEN_AUTH')`
  と書かれており、**有効にすると `ExplicitAuthFlows` から `ALLOW_REFRESH_TOKEN_AUTH` が消える**（実測）。
  この相互作用を検証してから入れること

**閉じた宿題は結果つきで [`docs/custom-domain.md`](docs/custom-domain.md) に移してある**
（TLS の最低バージョン / alias と証明書 / `env` を明示するかどうか）。
クロススタック参照の強さは**決定事項**として
[`docs/cdk-structure.md`](docs/cdk-structure.md) の「cdk_best_practices との既知の乖離」へ移した。
管理画面（`admin/`）と GitHub App は**どちらも実在する**（`admin/src` 一式と
`site-stack.ts` の `GITHUB_APP_CLIENT_ID`）ので、宿題ではなくなった。
**結果を書かずに消さないこと** — 消すだけだと、次に同じ疑問を持った人が同じ調査をやり直す。
ここに宿題として残し続けるのも同じだけ悪い（次に読む人が「まだ出来ていない」と誤解する）。
