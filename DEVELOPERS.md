# 開発環境

ツールチェーンは Nix flake で固定している。ホストに Node や AWS CLI を入れる必要はない。

> **`site/` と `infra/` と `api/` は動く。** `admin/`（管理画面）だけが未着手で、
> ルート `package.json` の `workspaces` にもまだ入っていない。`npm run -w admin ...` は通らない。

## 必要なもの

| | 用途 | 備考 |
| --- | --- | --- |
| **Nix** | 必須 | flakes を有効にすること |
| **direnv** | 任意 | `cd` するだけで shell に入れる |
| **AWS 認証情報** | デプロイ時のみ | ビルドとプレビューだけなら不要 |

Nix のインストールは https://nixos.org/download/ を参照。flakes は experimental 扱いなので、
`~/.config/nix/nix.conf` に次の行が必要になる。

```
experimental-features = nix-command flakes
```

## dev shell に入る

```sh
git clone git@github.com:shutx-net/blog.git
cd blog
nix develop
```

direnv を使うなら、クローン後に一度だけ許可すれば以後は `cd` で自動的に入る。

```sh
direnv allow
```

入ると次のバナーが出る。

```
blog dev shell
  node : v24.19.0  (Lambda runtime: nodejs24.x)
  npm  : 11.17.0
  aws  : aws-cli/2.34.24
  cdk  : npx -w infra cdk   (pinned in infra/package.json)
  docs : DEVELOPERS.md
```

## shell が提供するもの

| ツール | バージョン | なぜ必要か |
| --- | --- | --- |
| `node` / `npm` | 24.19.0 / 11.17.0 | Astro 7 が `>=22.12.0` を要求し、`api/` のデプロイ先が Lambda の `nodejs24.x`。ローカルと本番でメジャーを揃えている |
| `aws` | 2.34.24 | `aws s3 sync`、Secrets Manager、SSO ログイン |
| `gh` | 2.98.0 | PR とワークフローの操作 |
| `jq` | 1.8.2 | aws-cli と cdk の JSON 出力を読む |

### 意図的に入れていないもの

**AWS CDK CLI。** CDK CLI は `aws-cdk-lib` とバージョンを揃える必要があり、それを表現できるのは
`package.json` だけなので `infra/devDependencies` に置いてある。PATH にもう 1 つ `cdk` があると、
プロジェクトが固定しているものと食い違うことしか起きない。**必ず `npx -w infra cdk` で呼ぶこと。**

同じ理由で Astro や esbuild も npm 側に置いている。Nix が面倒をみるのは「言語ランタイムと
OS レベルの CLI」まで、という切り分けにしている。

## ワークスペース

npm workspaces のモノレポ。ルートで一度 `npm install` すれば全部入る。

```sh
npm install
```

| ワークスペース | 中身 | 状態 |
| --- | --- | --- |
| `site/` | Astro。読者向けの本体 | 有効 |
| `infra/` | AWS CDK | 有効 |
| `admin/` | 管理画面（静的 SPA） | 未着手 |
| `api/` | Lambda（投稿 API） | 有効（**`AUTH_MODE=deny-all` で fail-closed 出荷中**） |

```sh
npm run -w site dev              # http://localhost:4321
npm run -w site build            # site/dist/ に出力
npm run -w site preview          # ビルド結果をローカル配信
npm run -w site test             # unit + build 検証
npm run -w site test:unit        # unit のみ（速い）

npm run -w api build             # esbuild で api/dist/index.mjs にバンドル
npm run -w api test              # pretest で build も走る（build 成果物を読むテストがある）
npm run -w api typecheck

npm run -w infra test            # pretest で api のビルドと cdk synth も走る
npm run -w infra typecheck
npx -w infra cdk synth           # 引数なしで全スタック。認証情報は不要
npx -w infra cdk diff            # deploy の前に必ず（要 AWS 認証情報）
```

## SITE_URL

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
`process.env.SITE_URL` を直接見るので、`.env` に書いても効かない。シェルで渡すか、
デプロイ時に GitHub Actions の変数から渡すこと。

独自ドメインを決めるまで `https://blog.invalid/` のままで問題ない。`.invalid` を選んでいるのは、
RSS の `<guid isPermaLink="true">` が記事の恒久 ID であり、ドメインを後から変えると
購読者全員に全記事が再配信されて取り消せないため。プレースホルダは解決しないほうが安全。

## GitHub Actions

ワークフローは 2 本ある。**どちらも AWS のアクセスキーを持たない。**

| ファイル | いつ走るか | すること |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request | `npm run -w site test` / `npm run -w infra typecheck` / `npm run -w infra test`。**AWS には一切触らない** |
| `.github/workflows/deploy.yml` | `main` への push（`site/**` などに変更があったとき）と `workflow_dispatch` | Astro をビルドし、OIDC でロールを assume して `aws s3 sync --delete`、CloudFront を無効化して完了まで待つ |

### 一度だけ入れる変数

`deploy.yml` は次の 3 つを読む。**secret ではなく variable**（3 つとも秘密ではない。
secret にするとログで `***` にマスクされて失敗時の切り分けが難しくなるだけ）。
値の取り方は `infra/README.md` の「GitHub Actions の変数」を参照。

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

### `cdk deploy` は CI から実行しない（意図的）

インフラの変更は手元の SSO セッションからのみ行う。理由は 3 つ。

1. デプロイロールは S3 と CloudFront の 6 アクションしか持たず、CloudFormation を触れない。
   CDK デプロイ用のロールを CI に渡すには実質 AdministratorAccess 相当が要り、
   **public リポジトリから assume できるロールとしては危険すぎる**
2. `AGENTS.md` が「`infra/` を変えた PR では `cdk diff` の出力を本文に貼る」と定めており、
   差分を人間が読む前提の運用になっている
3. CDK bootstrap のロール群（`cdk-hnb659fds-*`）を信頼させる設計は、
   `CicdStack` の最小権限という主題と正面から衝突する

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

## AWS

### 認証情報

**このリポジトリは public。アクセスキーを絶対に置かないこと。** GitHub Actions は OIDC で
ロールを assume するので、リポジトリ側に AWS の秘密は存在しない。

手元からデプロイするときだけ、ホスト側のプロファイルを使う。

```sh
aws configure sso --profile blog
export AWS_PROFILE=blog
aws sts get-caller-identity      # 疎通確認
```

`AWS_PROFILE` を毎回打ちたくないなら、`.envrc` ではなく **`.envrc.local`**（gitignore 済み）に
書いて `source_env_if_exists .envrc.local` で読む。`.envrc` はコミットされる。

### CDK ブートストラップ

アカウント × リージョンごとに一度だけ必要。

```sh
npx -w infra cdk bootstrap aws://<account-id>/ap-northeast-1
```

### GitHub App の秘密鍵

Secrets Manager に置く。**CDK には値を書かない** — CloudFormation テンプレートに平文が残るため、
空のシークレットを CDK で作り、値だけを CLI で流し込む。

**シークレットの物理名は CDK が付けない**（物理名をハードコードしない方針）。名前は
`BlogSiteStack` の CfnOutput `GitHubAppSecretName` から取る。

```sh
SECRET_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey, 'GitHubAppSecretName')].OutputValue" \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --secret-binary fileb://blog-app.private-key.pem
```

`--secret-binary` を使うので、API からは `SecretBinary`（`Uint8Array`）として返る。
`api/src/secret.ts` は **`SecretBinary` を先に見る**（コンソールから貼った場合の
`SecretString` にもフォールバックする）。

PEM ファイルはこのリポジトリの中に置かないこと（`.gitignore` はしているが、そもそも持ち込まない）。

鍵を入れ替えるときは、GitHub App は秘密鍵を複数同時に有効化できるので無停止でいける。

1. GitHub の App 設定で新しい鍵を生成（**API では作れない。Web UI のみ**）

2. `AWSPENDING` として投入する。

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id "$SECRET_ID" \
     --secret-binary fileb://blog-app.private-key.new.pem \
     --version-stages AWSPENDING
   ```

3. **昇格する前に、その鍵で本当に installation token が取れるかを確かめる。**
   API に検証用の経路がある。`?versionStage=AWSPENDING` を付けると
   `AWSPENDING` の鍵だけを読んで（`AWSCURRENT` のキャッシュを使わずに）試す。

   ```sh
   curl -s "https://<distribution-domain>/api/health/github-app?versionStage=AWSPENDING"
   # {"status":"ok","canMintInstallationToken":true,"versionStage":"AWSPENDING"}
   ```

   **この経路は秘密鍵も installation token も返さない。** 返るのは真偽値だけ。
   `canMintInstallationToken` が `false` なら **昇格してはいけない** — 手順 2 に戻る。

   > この経路は認証必須なので、`AUTH_MODE` が `deny-all` の間は 503 が返る。
   > Cognito が入るまでは、代わりに Lambda をコンソールから直接テスト実行して同じ判定ができる。

4. `AWSCURRENT` に昇格する。`--remove-from-version-id` には現在の
   `AWSCURRENT` のバージョン ID を渡す。

   ```sh
   CURRENT_ID=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
     --query "VersionIdsToStages | to_entries(@)[?contains(value, 'AWSCURRENT')] | [0].key" --output text)
   PENDING_ID=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
     --query "VersionIdsToStages | to_entries(@)[?contains(value, 'AWSPENDING')] | [0].key" --output text)
   aws secretsmanager update-secret-version-stage \
     --secret-id "$SECRET_ID" --version-stage AWSCURRENT \
     --move-to-version-id "$PENDING_ID" --remove-from-version-id "$CURRENT_ID"
   ```

5. 昇格後にもう一度確認する（今度は `versionStage` を付けずに）。

   ```sh
   curl -s "https://<distribution-domain>/api/health/github-app"
   ```

   **Lambda の実行環境は鍵をキャッシュしている。** 昇格直後は古い鍵を掴んだままの
   実行環境が残りうるので、確実に切り替えたいなら Lambda の設定を 1 つ更新して
   実行環境を作り直すこと（環境変数の値を変える等）。

6. GitHub 側で古い鍵を削除

## ツールチェーンの更新

```sh
nix flake update          # nixpkgs のピンを更新（flake.lock が変わる）
nix develop               # 新しいピンで入り直す
nix fmt                   # flake.nix の整形
```

`flake.lock` はコミットする。これが「全員が同じツールチェーンを使う」根拠になる。

## 困ったとき

**新しく足したファイルを Nix が見つけてくれない**

Nix は flake が git リポジトリにあるとき、**git が知っているファイルしか見ない**。
`flake.nix` を作った直後は `git add` を忘れると `path does not exist` 系のエラーになる。

```sh
git add flake.nix
```

未コミットの変更は `dirty` 警告が出るだけで、評価自体は通る。

**`nix develop` が遅い**

初回はツールチェーンを丸ごと取得するので数分かかる。2 回目以降は store から即座に入る。
direnv を使っていると `cd` のたびに評価が走るが、これも同様にキャッシュされる。

**ホストの node と衝突する**

shell の中では `PATH` の先頭に Nix の node が来るので、ホスト側に何が入っていても影響しない。
`which node` が `/nix/store/...` を指していれば正しい。
