# 開発環境

ツールチェーンは Nix flake で固定している。ホストに Node や AWS CLI を入れる必要はない。

> `admin/` のログインは実装済み（Cognito の認可コードフロー + PKCE）。ただし
> **ユーザプールにユーザを作るのは帯域外の作業**なので、`docs/aws-ops.md` の「Cognito（管理画面のログイン）」
> の手順を先に 1 度だけ実行すること。ログインしていない状態でもエディタとプレビューは動く
> （送信だけができない）。

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

**TypeScript も同じく npm 側**（`api` / `infra` / `admin` の devDependencies に完全固定）。
ただし **7.x からは「npm 側に置く」の意味が 5.x と変わった**ので、`docs/typescript.md` を読むこと。

## ワークスペース

npm workspaces のモノレポ。ルートで一度 `npm install` すれば全部入る。

```sh
npm install
```

| ワークスペース | 中身 | 状態 |
| --- | --- | --- |
| `site/` | Astro。読者向けの本体 | 有効 |
| `infra/` | AWS CDK | 有効 |
| `admin/` | 管理画面（静的 SPA） | 有効（ログイン実装済み。認可コードフロー + PKCE、トークンは `sessionStorage`） |
| `api/` | Lambda（投稿 API） | 有効（`AUTH_MODE=cognito`。Cognito の ID トークンで認証） |

```sh
npm run -w site dev              # http://localhost:4321
npm run -w site build            # site/dist/ に出力
npm run -w site preview          # ビルド結果をローカル配信
npm run -w site test             # unit + build 検証
npm run -w site test:unit        # unit のみ（速い）
npm run -w site typecheck        # astro sync + tsc（sync が要る理由は docs/typescript.md）

npm run -w api build             # api/build.ts が api/dist/index.mjs にバンドル
npm run -w api test              # pretest で build も走る（build 成果物を読むテストがある）
npm run -w api typecheck

npm run -w infra test            # pretest で api のビルドと cdk synth も走る
npm run -w infra typecheck
npx -w infra cdk synth           # 引数なしで全スタック。認証情報は不要
npx -w infra cdk diff            # deploy の前に必ず（要 AWS 認証情報）
```

## ドキュメント

| ファイル | 何が書いてあるか |
| --- | --- |
| [`docs/content-repo.md`](docs/content-repo.md) | 記事リポジトリ・投稿 URL の決まり方・記事 API の運用 |
| [`docs/typescript.md`](docs/typescript.md) | `tsc` の実体と、`typecheck` だけが型を見ていること |
| [`docs/oxlint.md`](docs/oxlint.md) | lint の採用根拠・運用上の罠・oxlint で検査できないもの |
| [`docs/github-actions.md`](docs/github-actions.md) | 2 本のワークフロー・一度だけ入れる変数・`SITE_URL` |
| [`docs/aws-ops.md`](docs/aws-ops.md) | 資格情報・Cognito・`AUTH_MODE`・GitHub App の秘密鍵 |
| [`docs/dependencies.md`](docs/dependencies.md) | 依存を足すときの測り方 |
| [`infra/README.md`](infra/README.md) | CDK スタックの索引（設計の実体は `infra/docs/`） |
| [`AGENTS.md`](AGENTS.md) | 守ること（規約の単一の出所） |
| [`admin/src/auth/THREAT-MODEL.md`](admin/src/auth/THREAT-MODEL.md) | 管理画面のトークン保持方式の脅威モデル |

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
