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

### 投稿 URL の決まり方

**管理画面に slug の入力欄は無い。** 公開先は `pubDate` から導出される。

```
pubDate 2026-09-27T05:26:21.486Z  ->  posts/2026/09/27/142621.md
                                      /posts/2026/09/27/142621/
```

**Asia/Tokyo の壁時計時刻**を `YYYY/MM/DD/HHmmss` にしたもの。上の例は UTC の 05:26 =
JST の 14:26 なので `142621` になる。`pubDate` を空にすると送信時刻で確定する。
**投稿する前に管理画面が公開先の URL を表示する**ので、送信前に確認できる。

手入力をやめた理由は、スラッグが前回の下書きから復元されたまま送られ、
**公開済みの記事が警告なしに置き換わった**事故があったため。連番（最大値 + 1）を採らなかったのは、
データベースが無い設計では「次の番号」をリポジトリから読むことになり、
**同時投稿で同じ番号を計算する**（送信ボタンの二度押しで足りる）。時刻ベースなら採番に読み取りが要らない。

**スラッグは日付パスだけ。** 以前は手入力の平坦スラッグ（`/posts/hello-world/` など）も
許していたが撤廃した。撤廃時に残っていた平坦スラッグの記事 8 本はすべて捨て記事
（スキャフォールドと動作確認用）だったので削除し、**URL の消滅に伴う
`<guid isPermaLink="true">` の変更を許容した** — 独自ドメインが無く公開直後で購読者が
実質いなかったため。記事が 1 本だけになったので、3 つのガードの下限も 3 → 1 に下げた。

**下限 1 でも本来の危険は止まる。** 止めたいのは「checkout が失敗して記事 0 本のサイトが
`aws s3 sync --delete` で publish される」ことなので、1 で足りる。**0 にしてはならない。**
副作用として `README.md` 1 つでも本数ガードは通るようになったが（下限 3 の時代は足りなかった）、
形のガードが `README` を弾く。層として重ねてあることをテストが固定している。

**既存の URL は変えないこと。** `<guid isPermaLink="true">` が変わると購読者に全記事が
再配信され、取り消せない。

#### `pubDate` は明示的なオフセットが必須

`<input type="datetime-local">` が返すのは `2026-09-27T14:26:21` のような**オフセットの無い
文字列**で、`Date.parse` はそれをホストの TZ で解釈する。そのまま送ると
**著者のブラウザの TZ が公開先を決めてしまう**（実測: 同じ入力が JST で `142621`、
UTC で `232621`）。

管理画面は入力を **JST の壁時計時刻**として `+09:00` を付けて送り、API は
オフセットの無い `pubDate`（日付だけの `2026-09-27` も）を **400** で拒否する。
画面の表示と実際の公開先は同じ変換を通るので食い違わない。

**このバグは JST のマシンでは原理的に検出できない。** 変換を通さない実装との差が
JST では全入力でゼロになるため、どんなテストを書いても区別できない（実測で変異は
JST 0 件 / UTC 6 件が落ちた）。**CI が UTC で走っていたことだけが捕まえた。**
TZ 依存を疑うときは `TZ=UTC npm run -w <ws> test` のように振って走らせること。

### ローカルで実記事を見る

不要なら何もしなくてよい。**テストもビルドも実記事なしで通る**（テストは
`site/test/fixtures/posts/` を使う）。実記事で見たいときだけ:

```sh
git clone git@github.com:shutx-net/blog-content.git content-repo
cp content-repo/posts/*.md site/src/content/posts/
```

**記事ディレクトリに直接 clone しないこと。** `site/src/content/posts` は
`resolvePostsDir` の既定値で、コレクションの base はそこ。`blog-content` は
`README.md` + `posts/*.md` という構成なので、そこへ丸ごと clone すると:

- `README.md` がコレクションに混ざる（フロントマターが無いのでスキーマ検証で落ちる）
- 記事が 1 階層深くなり、`entry.id` が `posts/hello-world` になって
  **URL と RSS の `<guid>` が変わる**

`deploy.yml` も同じ理由で `content-repo` に checkout してから `posts/` だけを移している。

**clone しない状態で `npm run -w site build` を走らせると記事 0 本のサイトができるが、
これは正常**（astro は空のコレクションを警告するだけでビルドを成功させる）。

### 記事が 0 本のまま publish されない仕組み

`deploy.yml` に 3 つのガードがある。

1. 移送の直後、ビルド前に **`.md` の本数**が下限以上か
2. ビルド後、S3 sync の前に **`rss.xml` の `<item>` 数**が下限以上か
3. 同じくビルド後、**スラッグが想定の形であること**と、**publish されるスラッグ集合が
   checkout した記事と過不足なく一致すること**

3 が 2 つの主張から成るのには理由がある。

**1 と 2 はどちらも「数」しか見ていない。** content repo のルートを丸ごと降ろすと、
記事は `posts/2026/09/27/142621` という id で見つかり、件数は変わらないまま
`/posts/posts/2026/09/27/142621/` として publish される。RSS の
`<guid isPermaLink="true">` が変わる = 購読者への全記事再配信で、この系で唯一
取り消せない出力。

**そして集合の一致でもこれは捕まらない。** 期待値は記事ディレクトリからの相対パスで
作るので、corpus が入れ子なら期待値も `posts/2026/09/27/142621` になり、dist 側も同じで
一致してしまう。集合の比較が見ているのは corpus と dist の**内部整合**だけ。
だから**スラッグの「形」を直接主張する** — 日付パス（`2026/09/27/142621`）に合致すること。
事故の形（`posts/2026/09/27/142621`）は桁数とスラッシュの数が合わないので弾かれる。

```sh
slug_shape='^[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9]{6}$'
```

**シェルは POSIX ERE なので `(?:` が書けず、`api/src/posts/slug.ts` の
`DATE_SLUG_PATTERN` と同じ意味の別表現になっている。** 定義が 2 箇所にあるので、
`infra/test/workflow-deploy-steps.test.ts` が**両方を実際に走らせて**、
同じ入力集合を受理することを固定している。**スラッグの形を変えるときは両方を直すこと。**

集合の一致のほうは、記事の取りこぼし・余分な出力・draft の leak・改名の取りこぼしを
捕まえる。

**下限はワークフロー内の整数リテラル。** ディスクから計算する形にすると、記事が
0 本のとき下限も 0 になって主張が空振りする。**記事を意図的に下限より減らすときは、
`deploy.yml` の `minimum=` も同じ PR で下げること。** 下げ忘れるとデプロイが止まる
（安全側に倒れるだけなので、サイトは前の状態のまま残る）。

`infra/test/workflow-deploy-steps.test.ts` がこれらのスクリプトを**実際に実行して**
検証している。テキスト一致だけだと、シェルの意味論を間違えたガードも、`path:` の値
としては妥当な文字列も止められない（`grep -c` は一致した行数を返すので改行を含まない
`rss.xml` では常に 1 になるし、`path: site/src/content/posts` は YAML として何も
おかしくない）。移送の検証は **`actions/checkout` が作るのと同じ形**
（`README.md` + `posts/` + `.git/`）を組み立てて走らせている。

### 記事リポジトリに直接コミットしたとき

管理画面から投稿すれば Lambda がデプロイまで起動するが、`blog-content` に直接
push した場合は**デプロイが自動では走らない**（このリポジトリに push が起きないため）。

```sh
gh workflow run deploy.yml -R shutx-net/blog --ref main
```

管理画面が「保存はできたがデプロイを起動できなかった」と表示したときも同じコマンドで復旧する。
**ただし、実行する前に run が既に立っていないか確認すること。**

```sh
gh run list -R shutx-net/blog --workflow=deploy.yml --limit 5
```

`actor` が `shutx-blog[bot]` の `workflow_dispatch` が投稿の直後に立っていれば、
**起動は成功している**ので再実行は要らない（デプロイが 2 本走るだけになる）。

起動していない場合、Lambda のログに理由が残っている。

```sh
aws logs tail BlogSiteStack-PostingApiFunctionLogGroupCAC55A4B-GblcBe1AHAYb --since 30m
```

`deploy dispatch failed after publish` の `reason` で切り分ける。

| `reason` | 意味 | 見るところ |
| --- | --- | --- |
| `status` | GitHub が応答して拒否した。`status` フィールドに HTTP ステータスが出る | 403 なら GitHub App の **Actions: Read and write** と installation の再承認 |
| `transport` | HTTP 応答が無かった。`transportErrorName` に例外名が出る | ネットワーク側。**GitHub に届いた可能性は残るので、上の run 一覧を先に見る** |
| `unknown` | `DeployDispatchError` 以外が投げられた | 実装の不具合。`name` を手掛かりに追う |

**本文とメッセージは意図的に記録していない。** 応答が要求をエコーする実装に変わったとき、
installation token がログに落ちるため。載せてよいのは列挙値と HTTP ステータスだけ。

### スラッグが既にある記事とぶつかったとき

投稿 API は既存のスラッグを **409 `{ "error": "slug_conflict", "field": "slug" }`** で拒否する。
管理画面は確認を出し、**承認したときだけ** `overwrite: true` を付けて再送する。

スラッグが `pubDate` から導出されるようになったので、**ここに来るのは同じ秒に 2 本投稿したとき
だけ**（あるいは過去の記事と同じ `pubDate` を明示したとき）。対処は 2 つ。

- **別の記事を書いているつもりなら `pubDate` を 1 秒ずらす。** 公開先が変わって衝突が消える
- **同じ記事を直しているなら上書きを承認する。** コミットメッセージが「更新」になり、
  以前の内容は Git の履歴に残る

**409 のときリポジトリは 1 バイトも変わらない。** blob もコミットも作られないので、
デプロイも起動しない（何も反映するものが無いため）。

存在確認は `GET /repos/{owner}/{repo}/contents/{path}?ref=<base commit sha>` で、
**コミットの親と同じ sha に固定してある。** 確認とコミットの間に `main` が進んだ場合は、
ref の更新（force なし）が 422 になって `ConcurrentUpdateError` で落ちる。
**古い読みに基づいて上書きする窓は無い。**

以前の内容が要るときは Git の履歴から取る（上書きしてもコミットは残る）。

```sh
git -C <blog-content の clone> log --oneline -- posts/<slug>.md
git -C <blog-content の clone> show <sha>:posts/<slug>.md
```

### 記事の一覧・編集・削除

管理画面は新規投稿しかできなかったが、一覧・編集・削除ができるようになった。
経路の一覧は `api/src/router.ts` の `ROUTES` で、**`GET /api/health` 以外はすべて認証必須**。

| メソッド | パス | 入力 | 返り値 |
| --- | --- | --- | --- |
| `GET` | `/api/posts` | — | 一覧（**下書き込み**、各記事の blob `sha` 付き） |
| `GET` | `/api/posts/detail` | `?slug=` | 上記 + `body` |
| `POST` | `/api/posts` | JSON | 新規投稿 |
| `PUT` | `/api/posts` | JSON（`targetSlug` / `sha` / 本文一式） | 更新 |
| `DELETE` | `/api/posts` | `?slug=&sha=` | 削除 |

エラーコードは `invalid_post`(400) / `post_not_found`(404) /
`slug_conflict`(409) / `stale_post`(409) / `concurrent_update`(409) / `would_starve_site`(409)。
綴りは `grep "error: '" api/src/router.ts` で数えるのが速い。

**読み取り経路にも認証が要る。** `blog-content` は private で下書きが入っているので、
開けると下書きが誰にでも読める。`ROUTES` の全件走査がこれを主張しているので、
経路を足して `requiresAuth` を忘れれば赤くなる。

#### `pubDate` は編集で変えられない

スラッグ＝URL＝RSS `<guid>` が `pubDate` から決まるので、編集で日付を変えると
**公開済みの URL が動いて購読者に再配信される。** だから API は `pubDate` の変更を 400 で拒否し、
管理画面も編集モードでは入力欄を読み取り専用にする。日付を直したいときは削除して再投稿する。

**一致の判定は「同じ瞬間」ではなく表記まで byte 一致。** 同じ瞬間を許すと、
`datetime-local` を往復するたびにミリ秒が落ちて front matter が書き換わる。

**その副作用として、日付だけの `pubDate`（`2026-08-03` など）の記事は編集できない**
（オフセット必須の検査に落ちる）。管理画面が書いた記事はすべてオフセット付きなので
現状は起きないが、`blog-content` は直接コミットを許しているので手書きの記事では起こりうる。
黙って正規化すると「`pubDate` は変えない」という約束を破るので、落とす側に倒してある。

#### 最後の公開記事は消せない

**拘束するのは記事の総数ではなく「公開可能な記事の数」。** 下書きは `.md` の本数には入るが
サイトには出ないので、公開分が 0 本になると**スラッグ照合のガードが落ちてデプロイが止まる。**
実測すると、下書きだけが残った状態で本数ガードは通り、スラッグ照合だけが落ちる。

```
下書き 1 本だけ（公開 0 本）
  本数ガード        exit 0  ← 通る
  スラッグ照合      exit 1  ← 落ちる
    ::error::only 0 publishable post(s) ... expected at least 1
```

つまり**公開 1 本 + 下書き 3 本でその公開を消すと、総数は 3 残るのにデプロイが落ちる。**
そこで記事 API が先に **409 `would_starve_site`** で拒否する。
判定は `api/src/posts/publishable-floor.ts` の `wouldStarveSite`（純関数）で、
その `PUBLISHABLE_MINIMUM` が `deploy.yml` の `minimum` と同値であることを
`infra/test/workflow-deploy-steps.test.ts` が固定している
（食い違うと「API は許すのにデプロイが止まる」状態になる）。

**削除だけでなく、最後の公開記事を `draft: true` にする更新も同じ状態を作る**ので同じ床を通る。

#### 編集・削除の並行制御

一覧が返す **blob sha** が並行制御のトークン。更新と削除はこれを必須で受け取り、
**base commit sha に固定した取得**と突き合わせて、変わっていれば **409 `stale_post`**。
`sha` を省略可にしていないのは、省略を許すと並行制御を外して呼べる経路ができるため。

三段で塞いである。

1. クライアントが読んだ blob sha と、base に固定した現在の sha の一致
2. `?ref=<base commit sha>` に固定した存在確認（作成経路と同じ）
3. `PATCH git/refs/heads/main` を **force なし**で撃つ（間に `main` が進めば 422 →
   `concurrent_update`）

**409 のときリポジトリは 1 バイトも変わらず、デプロイも起動しない。**

#### 削除したものは Git の履歴に残る

サイトからは消えるが、コミットは残る。戻すときは履歴から取って再投稿する
（`pubDate` を元のままにすれば同じ URL に戻る）。

```sh
git -C <blog-content の clone> log --oneline --diff-filter=D -- 'posts/**'
git -C <blog-content の clone> show <sha>^:posts/<slug>.md
```

#### 一覧は記事数に比例したリクエストを撃つ

tree を 1 回取ってから記事ごとに blob を取るので、**`3 + 記事数`** 本になる。
床の判定に全記事の `draft` 状態が要るので、どの設計でも front matter は全件読むことになる。
本数は `api/test/unit/github-reader.test.ts` が固定しているので、増えれば気づく。

**`?recursive=1` の `truncated: true` は throw する。** GitHub は 100,000 エントリ /
7 MB を超えると黙って削るので、それを「記事が無い」と読むと一覧が嘘をつく。

#### 起動時に一覧を自動取得しない

「更新」ボタンを押したときだけ取る。`admin/index.html` の「ログインは明示的な操作。
起動時に自動でリダイレクトしない」という方針と揃えたのと、`blog-content` への
直接コミットで増えた記事を任意のタイミングで拾えるため。**未読み込みと 0 件は文言で区別している。**

#### CloudFront が 404 を HTML に差し替える

`CustomErrorResponses` が origin の 404 を差し替えるので、**`post_not_found` は
管理画面側で `non_json_response` に化けうる。**
`admin/src/api/client.ts` が JSON として読めない応答をこのコードに落とす扱いを持っている。
「存在しない記事を開いたのに `post_not_found` が出ない」はこれ。

#### 削除は本番で未検証

偽の GitHub（実際にファイルを持ち、blob sha を中身から導出する）と、
ローカルでの `deploy.yml` のガード実行で閉じてある。実機で確かめるなら:

1. 管理画面で**下書きを 1 本作る**（公開記事を消さずに済む）
2. 一覧から削除し、確認に承認する
3. `blog-content` に削除のコミットが立ち、`blog` の Actions が `workflow_dispatch` で走ること
4. デプロイのログで 3 つのガードが通ったこと、公開サイトから消えたこと
5. **最後の公開記事で削除を試し、409 で拒否されること**（記事が残ることを確認する）

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
npm run -w site typecheck        # astro sync + tsc（sync が要る理由は下記）

npm run -w api build             # api/build.ts が api/dist/index.mjs にバンドル
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

**型を見ているのは `tsc --noEmit` の 4 本だけ。**

```sh
npm run -w api typecheck && npm run -w infra typecheck \
  && npm run -w admin typecheck && npm run -w site typecheck
```

`.github/workflows/ci.yml` は 4 ジョブすべてでこれを
**test とは別のステップ**として回している。**テストジョブに畳み込まないこと。**
畳み込むと「型検査が走らなかったのに緑」という経路ができる。

その 3 本が本当に型を見ていることは、変異で確かめてある（`erasableSyntaxOnly` を破ると
TS1294、`skipLibCheck` を api から外すと 124 件）。詳細は各 `toolchain.test.ts` のコメント。

### `site` の typecheck だけ `astro sync` が前に付く

```
"typecheck": "astro sync && tsc --noEmit"
```

他 3 つは `tsc --noEmit` だけなので**文字列が揃わない。揃えようとして `astro sync` を
外さないこと。** `site/.astro/types.d.ts` は `.gitignore` 済みで、**無い状態で `tsc` を
走らせると `astro:content` が解決できず、テストではなく `site/src/pages/rss.xml.ts` に
エラーが出る。** CI は `npm ci` しかしないので、**これは CI でだけ落ちる形**になる
（手元では前のビルドが残した `.astro/` に助けられて気づけない）。
記事が 0 本でも `astro sync` は成功するので、CI の条件でも通る。

`astro check`（`.astro` ファイル自体の型検査）は**これとは別物**で、まだ入れていない。
ここで走るのは `.ts` の検査だけ。

なお以前この穴は開いていて、`site/test/` に `possibly undefined` 系のエラーが溜まっていた。
CI が検査していなかったので誰も気づかなかった（issue #36）。同じことを繰り返さないために、
**`tsc` を走らせる手順を増やすときは `infra/test/workflow-ci.test.ts` の `TYPECHECKED` にも
足すこと** — ci.yml からステップが消えても、他のどのテストも赤くならない。

## oxlint

```sh
npm run lint          # = oxlint --deny-warnings
```

設定は `.oxlintrc.json`（**jsonc なのでコメントが書ける**。例外を許すときは理由を残すこと）。

### 採用の根拠（実測）

```
oxlint 1.85.0 / MIT / 2026-09-21 公開（週次、212 リリース）
archived=false / pushed_at=2026-09-27 / stars 22897 / deprecated なし
runtime 依存ゼロ / hasInstallScript=false（postinstall を持たない）
npm の maintainer は 1 人（boshen）
```

**最後の 1 行は AGENTS.md の「採用するが注意が要る条件」に該当する**ので理由を書く。
GitHub は `oxc-project` org で活発に動いており放棄プロジェクトではないこと、
**devDependency なので Lambda のバンドルには入らない**こと、postinstall を持たないことが
緩和材料。ESLint と違って推移依存がゼロなのは、この repo の
「同じ用途なら依存の少ない候補を優先する」に直接合致する。

**`flake.nix` には入れない。** `aws-cdk` と同じ理由 — バージョンの真実の所在を
`package.json` 1 箇所に保つため。PATH にもう 1 つ `oxlint` があると、
`.oxlintrc.json` が想定しているバージョンと食い違うことしか起きない。

### 運用上の罠が 2 つある

**1. `--deny-warnings` が無いと素通りする。** 違反を 1 件仕込んだ状態の実測:

```
oxlint                  → exit 0   （素通りする）
oxlint --deny-warnings  → exit 1
npm run lint            → exit 1
```

`categories.correctness` は `warn` なので、これが無いと **CI が緑のまま通る**。
`api/test/unit/toolchain.test.ts` が `scripts.lint` にこのフラグが含まれることを固定している。

**2. 走査対象が静かに縮む。** `ignorePatterns` で一部を外しても exit 0 のままになる:

```
ignore なし                    → number_of_files=174
ignore admin/** infra/**       → number_of_files=73   （exit 0 のまま）
```

`api/test/unit/oxlint-coverage.test.ts` が床 150 を置いている。**「0 より大きい」では不十分**で、
ワークスペースを 1 つ落としたときの残存数（api 125 / admin 105 / infra 143 / **site 149**）の
最小を割る値でなければ意味がない。

なお「対象が 1 件も無い」（`No files found to lint`）は **exit 1** になるので、そこは安全。
**ルール名の typo も無言では通らない** — 設定ファイル経由なら
`Rule 'xxx' not found in plugin 'eslint'` で exit 1 になる
（ただし **CLI の `-D` フラグは検証しない**。`npm run lint` は設定ファイル経由なので問題ない）。

### oxlint で検査できないもの

**次に「これも oxlint で」と考えた人が同じ調査を繰り返さないための一覧。**

| 規約 | なぜ無理か | 実際の担当 |
| --- | --- | --- |
| インデント 2 スペース | **`indent` ルールが存在しない**（`Rule 'indent' not found in plugin 'eslint'`）。oxlint はフォーマッタではない | 誰も検査していない |
| 呼び出し形式の検査全般 | **`no-restricted-syntax` が存在しない**（同上）。AST パターンで縛れない | — |
| `package.json` のバージョン完全固定 | oxlint は `package.json` を読まない | 各 `toolchain.test.ts` |
| ワークフローの YAML と run スクリプト | JS/TS ではない | `infra/test/workflow-*.test.ts` |
| CloudFormation の合成結果 | 同上 | `infra/test/` |
| ビルド成果物の中身 | 同上 | `api/test/build/bundle.test.ts` |
| `media/limits.ts` の「import 文がゼロ」 | 相対 import は正当なので `patterns` で禁じられない | `api/test/unit/media-limits.test.ts` |
| admin が素の `fetch` を使わない | `no-restricted-globals` は**型位置の `typeof fetch` も違反として数える**。注入 seam として `fetchImpl?: typeof fetch` を使う 7 ファイルを除外すると実質 off になる。さらに `globalThis.fetch` / `window.fetch` / `new Request` / `sendBeacon` はメンバ参照で拾えず、**6 形のうち 2 形だけ**。実測で素の `fetch(` を足しても exit 0 | `admin/test/unit/no-raw-fetch.test.ts`（oxlint 側は `XMLHttpRequest` だけに絞ってある） |

### oxlint と既存テストは補完関係で、どちらも外せない

`os.tmpdir()` の検査を同じ入力に通した実測:

| 形 | `scratch-isolation.test.ts`（テキスト走査） | oxlint |
| --- | --- | --- |
| `import { tmpdir } from 'node:os'` | 検出 | 検出 |
| `import { tmpdir as t } from 'node:os'` | **素通り** | 検出 |
| `import * as os` → `os.tmpdir()` | 検出 | 検出 |
| `import os from 'node:os'` → `os.tmpdir()` | 検出 | **素通り** |
| `(await import('node:os')).tmpdir()` | 検出 | **素通り** |
| `export { tmpdir } from 'node:os'` | **素通り** | 検出 |
| `import { tmpdir } from 'os'`（接頭辞なし） | 検出 | **素通り** |

**どちらも相手の上位集合ではない。** oxlint を入れても既存の検査テストは 1 つも消せなかった。
しかも監視の主体である `github-token.test.ts` が実際に使っているのは動的 import の形で、
**oxlint からは見えない側**にある。

逆に `api/src/posts/**` は**これまで規約がコメントにしか無く無防備だった**。
そこは oxlint が新しく塞いだ範囲。

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
| `.github/workflows/ci.yml` | pull request | 4 ワークスペースの `typecheck` と `test`、および `npm run lint`。**AWS には一切触らない** |
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
`git status` で確認すること。`api/dist` の状態は気にしなくてよい。

### `cdk deploy` は CI から実行しない（意図的）

インフラの変更は手元の SSO セッションからのみ行う。理由は 3 つ。

1. デプロイロールは S3 と CloudFront の 6 アクションしか持たず、CloudFormation を触れない。
   CDK デプロイ用のロールを CI に渡すには実質 AdministratorAccess 相当が要り、
   **public リポジトリから assume できるロールとしては危険すぎる**
2. `AGENTS.md` が「`infra/` を変えた PR では `cdk diff` の出力を本文に貼る」と定めており、
   差分を人間が読む前提の運用になっている
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

### CSP の `style-src`（issue #34 の結論）

配信している値は `style-src 'self'` と `style-src-attr 'unsafe-inline'` の 2 本立て。
組み立ては `infra/lib/response-headers.ts` の `buildCsp` ただ 1 つ。

以前は `style-src 'self' 'unsafe-inline'` で、**外せない理由が 2 つあった。**

1. **インライン `<style>`** — `site/astro.config.mjs` が `build.inlineStylesheets: "always"` を
   指定しており、HTML が全件インライン `<style>` を持っていた。設定を外して既定の `"auto"` に
   戻すと、`global.css` は 10600 バイトで vite の 4KB 閾値を超えるので必ず外部
   `/_astro/Layout.*.css` になる（実測: インライン `<style>` 0/5、`<link>` 1 本）。
   同一オリジンなので `'self'` で足りる
2. **shiki の `style="color:#..."` 属性** — コードフェンスの色付けは属性で行われる
   （実測: コードフェンス 2 本の記事 1 件で `style=` 属性 **29 個**、`<style>` ブロック 0 個）。
   **CSP3 では `style-src-attr` を明示すると属性はそちらに支配され `style-src` に
   フォールバックしない**ので、`style-src-attr 'unsafe-inline'` で許すしかない

#### shiki を class 出力にする案を採らなかった理由

`@shikijs/transformers` の `transformerStyleToClass` を使えば属性そのものを無くせる。採らない。

- **未インストールで新規依存になる**（`node_modules/@shikijs` には core / engine-* / langs /
  primitive / themes / types / vscode-textmate しか無い）
- **markdown の出力が変わるので `admin/test/parity/published-html.test.ts` のバイト一致が壊れる。**
  `AGENTS.md` のとおり、プレビュー側と `site/astro.config.mjs` を同じコミットで揃える必要がある
- `themes` / `defaultColor: false` は CSS 変数を**属性の中に**吐くので、属性は消えない

#### 得られた強化は限定的である

できるようになったのは **`<style>` ブロックの注入を禁じること**だけで、`style` 属性は許したまま。
インラインスタイルはスクリプトを実行しないので、`script-src` の厳格さとは重みが違う。
**多層防御の 1 枚**として理解すること。

#### ブラウザでの確認が必須

**CSP 違反はブラウザのコンソールにしか出ない。** `curl` はヘッダしか見ないので、スタイルが
飛んでいてもステータス 200 で通る。過去に `script-src-attr 'none'` の確認で同じ形を踏んでいる。

`cdk deploy` の後に、DevTools の Console を開いたまま次を見ること。

1. `/`・記事ページ・`/admin/` で **CSP 違反が 1 件も出ない**こと、見た目が崩れていないこと
2. **コードフェンスを含む記事**でシンタックスハイライトの色が付くこと。
   **本番の記事にコードフェンスが無い間、2 は既存ページでは検証できない** —
   `style=` 属性が 0 個なので `style-src-attr` を壊しても無症状で通り、
   **色が飛ぶのは記事を書いた日になる**

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
