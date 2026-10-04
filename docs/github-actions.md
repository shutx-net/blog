# GitHub Actions

ワークフローは 2 本ある。**どちらも AWS のアクセスキーを持たない。**

| ファイル | いつ走るか | すること |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request | 4 ワークスペースの `typecheck` と `test`、および `npm run lint`。**AWS には一切触らない** |
| `.github/workflows/deploy.yml` | `main` への push（`site/**` などに変更があったとき）と `workflow_dispatch` | Astro をビルドし、OIDC でロールを assume して `aws s3 sync --delete`、CloudFront を無効化して完了まで待つ |

### 一度だけ入れる変数

`deploy.yml` は次の 3 つを読む。**secret ではなく variable**（3 つとも秘密ではない。
secret にするとログで `***` にマスクされて失敗時の切り分けが難しくなるだけ）。
値の取り方は `infra/docs/stacks.md` の「GitHub Actions の変数」を参照。

| 変数名 | 値 |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `BlogCicdStack` の Output `DeployRoleArn` |
| `SITE_BUCKET` | `BlogSiteStack` の Output `SiteBucketName` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `BlogSiteStack` の Output `DistributionId` |

```sh
gh variable list -R shutx-net/blog     # 3 つ入っているか確認
```

未設定のまま走らせても `${{ vars.X }}` は空文字に展開されるだけでエラーにならないので、
`deploy.yml` の**最初のステップ**が 3 つの有無を確認して落とす。落ちたときは上のコマンドで確認する。

### Lambda のバンドルは synth のたびに作り直される

`infra/lib/posting-api.ts` は `Code.fromAsset` に渡す**直前に `api/build.ts` の
`buildApiBundle()` を呼ぶ**。したがって `cdk synth` / `cdk diff` / `cdk deploy` は、
その時点のソースから作ったバンドルを固める。**手で `npm run -w api build` を先に走らせる必要はない。**

そうしている理由。`Code.fromAsset` はディレクトリの中身をそのまま固めるだけで、それがソースと
一致しているかは見ない。**実際に事故が起きた** — 変異テストが `pretest` 経由で `api/dist` を汚し、
ソースだけ復旧したため、**本番の Lambda がソースと 6 バイト食い違ったまま動いた**
（dispatch の成功判定が 2xx ではなく 204 ちょうどのままで、GitHub が返す 200 を失敗と判定していた）。
そのときテストは 2119 件緑、`git status` もクリーンだった。

「成果物が新鮮かどうか調べて古ければ落とす」方式は採らなかった。**何を入力と見なすかで必ず
取りこぼしが残る**（`node_modules` の入れ替えは？ mtime を保つコピーは？）。作り直す方式には
その余地が無い。esbuild は 100ms 前後で、1 プロセス 1 回に抑えてある。

**裏を返すと、ソースが汚れていればそのまま本番に出る。** 変異テストの後始末は
`git status` で確認すること。

### `cdk deploy` は CI から実行しない（意図的）

インフラの変更は手元の SSO セッションからのみ行う。理由は 3 つ。

1. デプロイロールは S3 と CloudFront の 6 アクションしか持たず、CloudFormation を触れない。
   CDK デプロイ用のロールを CI に渡すには実質 AdministratorAccess 相当が要り、
   **public リポジトリから assume できるロールとしては危険すぎる**
2. `AGENTS.md` が「`infra/` を変えた PR では `npx -w infra cdk diff` の出力を本文に貼る」と
   定めており、差分を人間が読む前提の運用になっている
3. CDK bootstrap のロール群（`cdk-hnb659fds-*`）を信頼させる設計は、
   `CicdStack` の最小権限という主題と正面から衝突する

### Cache-Control をデプロイ後に確認する

`Cache-Control` は S3 のオブジェクトではなく **CloudFront の ResponseHeadersPolicy** で付けている
（理由は `AGENTS.md` の「Cache-Control」節）。`cdk deploy` のあとに実物を確かめること。

```sh
# サイトは毎回検証させる
curl -sI https://blog.shutx.net/ | grep -i cache-control
# → cache-control: no-cache

# 記事ページも同じ（HTML 全般に効いていること）
curl -sI https://blog.shutx.net/posts/2026/09/27/142621/ | grep -i cache-control

# メディアは 1 年 + immutable
MEDIA_BUCKET=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" --output text)
KEY=$(aws s3 ls "s3://$MEDIA_BUCKET/media/" --recursive | head -1 | awk '{print $4}')
curl -sI "https://blog.shutx.net/$KEY" | grep -i cache-control
# → cache-control: public, max-age=31536000, immutable

# S3 側に二重定義していないこと（null のままであること）
SITE_BUCKET=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
aws s3api head-object --bucket "$SITE_BUCKET" --key index.html --query CacheControl
# → null
```

**invalidation は要らない。** ResponseHeadersPolicy は CloudFront が
*キャッシュから返す応答*にも適用されるので、既存のキャッシュにも即座に効く。
同じ理由で、S3 の既存オブジェクトを貼り直す必要も無い。

**ただし、この変更より前にサイトを見たブラウザは古い HTML を持ち続ける。**
`Cache-Control` が無かった時期のヒューリスティックキャッシュが切れるまでは、
新しいヘッダを受け取る機会そのものが来ない。**一度スーパーリロード（Ctrl+Shift+R）が要る場合がある。**
これは直せない類の後遺症で、以後の更新では起きない。

### ツールチェーンが Nix と一致しない箇所（意図的な例外）

- **`aws` CLI はランナー同梱のものを使う**（nix の 2.34.24 ではない）。使うのは `s3 sync` と
  `cloudfront create-invalidation` / `wait` だけで、どちらも極めて安定した API。
  CI に nix を入れるコスト（サードパーティ action への信頼が増える + 毎回クロージャを取得）と
  釣り合わない
- **`node` のバージョンは `actions/setup-node` に完全一致で書く**（現在 `24.19.0`）。
  `nix flake update` で nixpkgs の node が動くと `infra/test/workflow-ci.test.ts` が
  `process.version` と比較して**ローカルで落ちる。**これは意図した挙動で、
  修正は `ci.yml` と `deploy.yml` の `node-version` を直すだけ。
  **この摩擦が嫌になったときは、比較を緩めるのではなく flake.lock を上げないほうが方針として一貫している**

### ワークフローを編集するときに壊しやすいところ

`deploy.yml` は IAM の信頼ポリシーと結合している。次はどれも YAML として妥当なまま
assume を壊すので、`infra/test/workflow-deploy-oidc.test.ts` が機械的に禁止している。

- `pull_request` をトリガに足す → `sub` が `...:pull_request` になる
- ジョブに GitHub の環境（`environment`）を指定する → `sub` が `...:environment:<name>` になる
- タグ push で走らせる → `sub` が `ref:refs/tags/...` になる
- `id-token: write` を消す・綴りを間違える → トークンが発行されない
- action を SHA ピンから外す / ARN やアカウント ID を YAML に直書きする

**`gh` のトークンに `workflow` スコープが要る場合がある。** `.github/workflows/*` を含む push は
HTTPS リモートだと拒否される（このリポジトリは ssh なので通常は通る）。
詰まったら `gh auth refresh -h github.com -s workflow`。

### SITE_URL

RSS と sitemap は絶対 URL を要求するため、`site/astro.config.mjs` は環境変数 `SITE_URL` を読む。

| 値 | 挙動 |
| --- | --- |
| 未設定 | `https://blog.invalid/` を使う。RFC 2606 で絶対に解決しないドメインなので、漏れても目に見えて安全に失敗する |
| 絶対 https URL | そのまま使う（オリジン + `/` に正規化） |
| それ以外 | **ビルドを exit 1 で落とす。** 誤った URL の feed を配ってしまうより止めるほうがいい |

```sh
SITE_URL=https://blog.example.com npm run -w site build
```

**Astro は設定ファイルの評価時に `.env` を読まない。** `site/astro.config.mjs` は
`process.env.SITE_URL` を直接見るので、`.env` に書いても効かない。手元ではシェルで渡す。
**本番の値は `.github/workflows/deploy.yml` に直書きしてある** — Actions 変数にすると
未設定でも空文字に展開され、`.invalid` のフィードが exit 0 で本番に配られる。

既定を `.invalid` にしているのは、RSS の `<guid isPermaLink="true">` が記事の恒久 ID であり、
ドメインを後から変えると購読者全員に全記事が再配信されて取り消せないため。
プレースホルダは解決しないほうが安全。
