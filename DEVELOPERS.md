# 開発環境

ツールチェーンは Nix flake で固定している。ホストに Node や AWS CLI を入れる必要はない。

> **スキャフォールド中。** dev shell と `flake.nix` は動作確認済み。
> `site/` `admin/` `api/` `infra/` の各ワークスペースはこれから作るため、
> 「ワークスペース」以降のコマンドはまだ通らない。

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

| ワークスペース | 中身 |
| --- | --- |
| `site/` | Astro。読者向けの本体 |
| `admin/` | 管理画面（静的 SPA） |
| `api/` | Lambda（投稿 API） |
| `infra/` | AWS CDK |

```sh
npm run -w site dev              # http://localhost:4321
npm run -w site build            # site/dist/ に出力
npm run -w site preview          # ビルド結果をローカル配信

npm run -w admin dev
npm run -w api build             # esbuild で Lambda をバンドル

npx -w infra cdk diff            # deploy の前に必ず
npx -w infra cdk deploy BlogSiteStack
```

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

```sh
aws secretsmanager put-secret-value \
  --secret-id blog/github-app-private-key \
  --secret-binary fileb://blog-app.private-key.pem
```

PEM ファイルはこのリポジトリの中に置かないこと（`.gitignore` はしているが、そもそも持ち込まない）。

鍵を入れ替えるときは、GitHub App は秘密鍵を複数同時に有効化できるので無停止でいける。

1. GitHub の App 設定で新しい鍵を生成（**API では作れない。Web UI のみ**）
2. `--version-stages AWSPENDING` で新しい鍵を投入し、動作を確認
3. `update-secret-version-stage` で `AWSCURRENT` に昇格
4. GitHub 側で古い鍵を削除

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
