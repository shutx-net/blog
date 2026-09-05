# 開発環境

ツールチェーンは Nix flake で固定している。ホストに Node や AWS CLI を入れる必要はない。

> **4 つのワークスペースすべてが動く。** `admin/` の**ログインは Phase 5 で実装済み**
> （Cognito の認可コードフロー + PKCE）。ただし **ユーザプールにユーザを作るのは帯域外の作業**
> なので、下の「Cognito（管理画面のログイン）」の手順を先に 1 度だけ実行すること。
> ログインしていない状態でもエディタとプレビューは動く（送信だけができない）。

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
ただし **7.x からは「npm 側に置く」の意味が 5.x と変わった**ので、次の節を読むこと。

### TypeScript 7 — `tsc` の実体はネイティブバイナリ

`typescript` は Go 実装に移行した。npm の `typescript` パッケージは **node のシムでしかなく**、
コンパイラの実体は `@typescript/typescript-<os>-<arch>`（このマシンでは
`@typescript/typescript-linux-x64`、約 28MB）という **別パッケージ**にある。
`typescript` はそれを 20 プラットフォーム分 `optionalDependencies` に並べ、
npm が `os` / `cpu` に一致する 1 つだけを入れる。

実務上の帰結が 3 つある。

- **`npm ci --omit=optional` を使わないこと。** コンパイラ本体が入らず、`tsc` は
  `Error: Unable to resolve @typescript/typescript-linux-x64.` を投げて**起動すらしない**。
  黙って成功はしないので CI は赤くなるが、原因が分かりにくい。
  `.github/workflows/*.yml` は素の `npm ci` を使っている（そのままにすること）
- **WSL から Windows 版の npm を使わないこと。** 5.x の `tsc` は純 JS だったのでどの npm で
  入れても動いたが、7.x は os/cpu でバイナリを選ぶ。Windows の npm で入れると
  `@typescript/typescript-win32-x64` が Linux のツリーに入り、`node_modules/.bin/tsc` が
  実行不能になる。**`which npm` が `/nix/store/...` を指していることを確認する**
  （すべての作業を `nix develop` 経由にするという既存の規律がそのまま対策になっている）
- **エディタの設定は `tsserver` 前提だと効かない。** 7.x は bin から `tsserver` を落とし、
  `tsc --lsp`（標準 LSP）に統合した。CI とビルドには無関係だが、
  古い tsserver プロトコルを前提にしたエディタ設定は動かない

`api/test/unit/toolchain.test.ts` が **実際に走る `tsc --version`** を package.json のピンと
突き合わせている。上の 3 つはどれもこのテストで赤くなる（ピン文字列を読むだけの
アサーションでは検出できない事故なので、実行結果と突き合わせている）。

## 記事は別リポジトリにある

記事の実体は **private リポジトリ [`shutx-net/blog-content`](https://github.com/shutx-net/blog-content)**
の `posts/*.md`。このリポジトリには 1 本も入っていない（`site/src/content/posts/` は `.gitignore` 済み）。

なぜ分けたか:

- **下書きを公開しないため。** `draft: true` の記事はサイトには出ないが、
  このリポジトリは public なので、同居していればリポジトリを見るだけで読めてしまう
- **コード側の履歴を記事コミットで動かさないため。** 記事を 1 本足すたびに `main` が進むと、
  コードを触る前に毎回 pull が要るし、`git log` にコンテンツの差分が混ざる

### ローカルで実記事を見る

不要なら何もしなくてよい。**テストもビルドも実記事なしで通る**（テストは
`site/test/fixtures/posts/` を使う）。実記事で見たいときだけ:

```sh
git clone git@github.com:shutx-net/blog-content.git site/src/content/posts
```

`site/src/content/posts` は `resolvePostsDir` の既定値で、デプロイ時に
`actions/checkout` が展開するのと同じ場所。**clone しない状態で
`npm run -w site build` を走らせると記事 0 本のサイトができるが、これは正常**
（astro は空のコレクションを警告するだけでビルドを成功させる）。

### 記事が 0 本のまま publish されない仕組み

`deploy.yml` に 2 つのガードがある。

1. content checkout の直後、ビルド前に **`.md` の本数**が下限以上か
2. ビルド後、S3 sync の前に **`rss.xml` の `<item>` 数**が下限以上か

**下限はワークフロー内の整数リテラル。** ディスクから計算する形にすると、記事が
0 本のとき下限も 0 になって主張が空振りする。**記事を意図的に下限より減らすときは、
`deploy.yml` の `minimum=` も同じ PR で下げること。** 下げ忘れるとデプロイが止まる
（安全側に倒れるだけなので、サイトは前の状態のまま残る）。

`infra/test/workflow-deploy-steps.test.ts` がこの 2 つのスクリプトを**実際に実行して**
検証している。テキスト一致だけだと、シェルの意味論を間違えたガードを止められない
（`grep -c` は一致した行数を返すので、改行を含まない `rss.xml` では常に 1 になる）。

### 記事リポジトリに直接コミットしたとき

管理画面から投稿すれば Lambda がデプロイまで起動するが、`blog-content` に直接
push した場合は**デプロイが自動では走らない**（このリポジトリに push が起きないため）。

```sh
gh workflow run deploy.yml -R shutx-net/blog --ref main
```

管理画面が「保存はできたがデプロイを起動できなかった」と表示したときも同じコマンドで復旧する。

### 資格情報

CI は**読み取り専用の deploy key**で `blog-content` を clone する
（秘密鍵は `blog` の Actions secret `CONTENT_DEPLOY_KEY`、公開鍵は `blog-content` の
Deploy keys に **write access なし**で登録）。

**GitHub App の秘密鍵は Actions に置かない。** あの鍵は両リポジトリに書けるこの系で
最も価値の高い資格情報で、AWS Secrets Manager にしか存在しない状態を保つ。

## ワークスペース

npm workspaces のモノレポ。ルートで一度 `npm install` すれば全部入る。

```sh
npm install
```

| ワークスペース | 中身 | 状態 |
| --- | --- | --- |
| `site/` | Astro。読者向けの本体 | 有効 |
| `infra/` | AWS CDK | 有効 |
| `admin/` | 管理画面（静的 SPA） | 有効（**ログイン実装済み**。認可コードフロー + PKCE、トークンは `sessionStorage`） |
| `api/` | Lambda（投稿 API） | 有効（**`AUTH_MODE=cognito`**。Cognito の ID トークンで認証する） |

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

### **テストが全部緑でも、型が正しいことにはならない**

**Vitest は esbuild で型を剥がして実行する。テストの実行に `tsc` は一切関与しない。**
型が壊れていてもテストは通る。

実測がある。`typescript` を 5.9.3 から 7.0.2 に上げた瞬間、**1988 件のうち 1987 件は
そのまま通り、赤くなったのは「ピン文字列を読んでいるテスト」1 件だけ**だった。
このとき型検査が通るかどうかは、まだ 1 度も確かめられていない状態である。

**型を見ているのは `tsc --noEmit` の 3 本だけ。**

```sh
npm run -w api typecheck && npm run -w infra typecheck && npm run -w admin typecheck
```

`.github/workflows/ci.yml` は api / infra / admin の 3 ジョブでこれを
**test とは別のステップ**として回している。**テストジョブに畳み込まないこと。**
畳み込むと「型検査が走らなかったのに緑」という経路ができる。

その 3 本が本当に型を見ていることは、変異で確かめてある（`erasableSyntaxOnly` を破ると
TS1294、`skipLibCheck` を api から外すと 124 件）。詳細は各 `toolchain.test.ts` のコメント。

**`site/` はこの 3 本に入っていない。** `typescript` を devDependency に持たず
`typecheck` スクリプトも無いので、`tsc` は一度も走っていない
（`astro/tsconfigs/strict` を extends しているだけ）。

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

### Cognito（管理画面のログイン）

単一著者用のユーザプールを `BlogSiteStack` の中に持っている。
**ユーザは CDK では作らない**（このリポジトリは public なので、個人のメールアドレスも
ユーザ名以外の情報もテンプレートに書かない）。GitHub App の秘密鍵と同じく帯域外で行う。

#### 値の取り方

物理名はハードコードしていないので、CfnOutput から拾う。**Construct の中で作った Output は
論理 ID にハッシュが付く**ので `ends_with` で引く。

```sh
POOL_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolId')].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolClientId')].OutputValue" --output text)
LOGIN=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminLoginDomain')].OutputValue" --output text)
```

#### ユーザを作る（初回だけ）

```sh
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
  --username shutx --message-action SUPPRESS

aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
  --username shutx --password '<16 文字以上・大小英字と数字と記号>' --permanent
```

**`--username` は `infra/lib/site-stack.ts` の `ADMIN_USERNAME` と完全一致でなければならない。**
プールは `UsernameConfiguration.CaseSensitive: true` なので大文字小文字も区別する。
一致しないトークンは API が **401 `{"error":"not_authorized"}`** で弾く。

`--message-action SUPPRESS` はメールを送らせないため。`selfSignUpEnabled: false` なので
このコマンド以外にユーザが増える経路は無い。

MFA（TOTP）は任意で、Managed Login から後で登録できる。

#### ID トークンを取る

```
$LOGIN/login?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=https://<distribution-domain>/admin/
```

をブラウザで開いてログインし、リダイレクト先の `?code=` を `/oauth2/token` で交換する
（authorization code grant。**implicit は無効にしてある**。client secret は無い public client）。

```sh
curl -s -X POST "$LOGIN/oauth2/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code -d "client_id=$CLIENT_ID" \
  -d "code=$CODE" -d "redirect_uri=https://<distribution-domain>/admin/" | jq -r .id_token
```

#### 管理画面からログインする（Phase 5）

`/admin/` を開いて「ログイン」を押すだけ。**起動しただけでは何も起きない**
（自動リダイレクトはしない）。実装の詳細は `admin/src/auth/` と
`admin/src/auth/THREAT-MODEL.md` にある。

    ブラウザ -> /oauth2/authorize (PKCE S256 + state) -> Managed Login
            -> /admin/?code=... -> /oauth2/token で交換 -> sessionStorage

**トークンは `sessionStorage` に置く。** タブを閉じれば消えるので、ブラウザを
再起動するたびに再ログインが要る。**これは意図した trade-off** であり、
理由は `admin/src/auth/THREAT-MODEL.md` に書いてある（24 時間有効な refresh トークンを
ディスクに残さないことを優先している）。変えたくなったらまずそれを読むこと。

設定のドリフト（コンソールから誰かがクライアント設定を変えた等）は smoke で検出できる。

```sh
npm run -w admin auth-smoke
```

**AWS 認証情報が無いときは `describe-user-pool-client` の 1 件だけ skip して残りを走らせる**
（skip したことは必ず出力される）。認証情報を使うときは `aws sso login --profile blog` を先に。

#### ブラウザでしか確かめられないこと（**必ず人間が 1 度やること**）

このリポジトリの flake にブラウザは無く、jsdom では以下が原理的に検証できない。
**テストが全部緑でもここが壊れている可能性がある。**

1. **`location.assign()` による実リダイレクト。** jsdom は
   「Not implemented: navigation to another Document」を出して**何もしない**
   （例外も投げず URL も変わらない）。テストは注入した関数で URL 文字列だけを見ている。
2. **`crypto.subtle` の secure context 要件。** 本番は https、開発は `http://localhost` で
   どちらも secure context に入るはずだが、ブラウザでしか確かめられない。
3. **`sessionStorage` がタブの寿命に紐づき、Cognito への全画面遷移と復帰を越えて保持されること。**
   **PKCE の verifier と下書きの両方がこの性質に依存している。**
4. **タブ間の `storage` イベント。** jsdom では発火 0 件（実測）。タブ間同期は scope 外。
5. **Managed Login（`ManagedLoginVersion: 2`）の実画面。** `ManagedLoginBranding` が
   未作成で、`/login` の直叩きは 403 とともに既定の HTML を返す（実測）。
   通常の経路（`/oauth2/authorize` から 302）でどう見えるかは未確認。
6. **CSP が実際にスクリプトを止めること。** 実測で **jsdom は CSP を一切強制しない**
   （`script-src-attr 'none'` を与えても `<div onclick>` は発火する）。
   **「CSP が onerror を止めた」という緑のテストは書けない。**

##### 手順（ユーザを作ったあとに 1 度だけ）

1. `/admin/` を開く。**自動で Cognito に飛ばないこと。**
2. 何か入力する。
3. 「ログイン」を押す -> Cognito の画面に飛ぶ。
4. 戻ってきて **入力が残っていること**（= 上の 3 の確認）。
5. アドレスバーに `?code=` が残っていないこと。
6. 投稿できること。
7. サインアウト -> 再訪で未認証になること。**下書きは消えていないこと。**
8. devtools のコンソールに **CSP 違反が 1 件も出ていないこと**。
9. コードフェンス入りの記事で **シンタックスハイライトに色が付くこと**
   （付かなければ CSP が `'wasm-unsafe-eval'` を落として wasm を止めている）。
10. **画像アップロードが通ること**（`connect-src` にメディアバケットが入っているか）。

#### ローカル開発ではログインできない

`CallbackURLs` は `https://<distribution-domain>/admin/` の 1 本だけで、
`http://localhost:5173/admin/` は入っていない。実測で不一致は `redirect_mismatch` になり、
Cognito 自身の `/error` に飛ぶ（**攻撃者の URL には飛ばない**）。

`npm run -w admin dev` でエディタとプレビューは動くが、**ログインと投稿は試せない。**
`redirect_uri` はオリジンから導出しているので、infra 側で `callbackUrls` に
`http://localhost:5173/admin/` を足せば admin は無変更で通る。**ただし public client の
callback に localhost を足すことは、開発者の端末で動く任意のアプリが `code` を
受け取れることを意味する**ので、足すかどうかは意識的に決めること。

#### API に付けるヘッダ

```
x-blog-authorization: Bearer <ID token>
```

**`Authorization` ではない。** CloudFront の OAC が `SigningBehavior: always` で
viewer の `Authorization` を上書きするため（理由と実測は `infra/README.md`）。
**access トークンではなく ID トークンを送ること**（API は `token_use: 'id'` を要求する）。

ボディがある POST / PUT には **`x-amz-content-sha256: <ボディの SHA-256 を小文字 hex で>`**
も必須。付け忘れると 403 になり、CloudFront の `CustomErrorResponses` で
**404 の HTML に化ける**（認証の失敗と紛らわしいので注意）。

### `AUTH_MODE` の運用（切り戻し手順）

`AUTH_MODE` は Lambda の環境変数で、**CDK が唯一の変更経路**である
（コンソールで直接書き換えると次の deploy で戻る）。許容値は `deny-all` と `cognito` の
**2 つだけ**で、それ以外・空文字・未設定はすべて **コールドスタートで例外**になり、
Lambda の初期化が落ちて CloudFront には 502 が返る。
**「打ち間違いが黙って全許可になる」経路は存在しない。**

いま何で動いているかは無認証で確認できる。

```sh
curl -s https://<distribution-domain>/api/health
# {"status":"ok","authMode":"cognito"}
```

Cognito 側で問題が起きたときの切り戻しは、`infra/lib/site-stack.ts` の `PostingApi` の
`auth` を戻して deploy し直すだけ。

```ts
auth: { mode: 'deny-all' },
```

- **Cognito のリソースは消えない**（`deletionProtection: true` / `RemovalPolicy.RETAIN`）
- **`deny-all` は `COGNITO_*` を 1 つも読まない**ので、
  **壊れた Cognito 設定を抱えたまま安全側に倒せる**
- 戻すと認証が必要な 3 経路はすべて `503 {"error":"auth_not_configured"}` になる

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

   > **この経路は認証必須なので、Cognito の ID トークンを付ける必要がある。**
   > 取り方は下の「Cognito（管理画面のログイン）」を参照。
   > `AUTH_MODE` を `deny-all` に戻している間はトークンの有無によらず 503 が返るので、
   > その場合は Lambda をコンソールから直接テスト実行して同じ判定ができる。
   >
   > ```sh
   > curl -s -H "x-blog-authorization: Bearer $ID_TOKEN" \
   >   "https://<distribution-domain>/api/health/github-app?versionStage=AWSPENDING"
   > ```

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
