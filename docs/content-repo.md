# 記事は別リポジトリにある

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
**管理画面は送信前に公開先の URL を表示する。**

手入力をやめた理由は、スラッグが前回の下書きから復元されたまま送られ、
**公開済みの記事が警告なしに置き換わった**事故があったため。連番（最大値 + 1）を採らなかったのは、
データベースが無い設計では「次の番号」をリポジトリから読むことになり、
**同時投稿で同じ番号を計算する**（送信ボタンの二度押しで足りる）。時刻ベースなら採番に読み取りが要らない。

**3 つのガードの下限は 1。** 止めたいのは「checkout が失敗して記事 0 本のサイトが
`aws s3 sync --delete` で publish される」ことなので、1 で足りる。**0 にしてはならない。**
下限 1 では `README.md` 1 つでも本数ガードは通るが、形のガードが `README` を弾く。
層として重ねてあることをテストが固定している。

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
- 記事が 1 階層深くなり、`entry.id` が `posts/2026/09/27/142621` になって
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

**3 が 2 つの主張から成る理由。1 と 2 はどちらも「数」しか見ていない。** content repo の
ルートを丸ごと降ろすと、記事は `posts/2026/09/27/142621` という id で見つかり、件数は変わらないまま
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

スラッグが `pubDate` から導出されるので、**ここに来るのは同じ秒に 2 本投稿したときだけ**
（あるいは過去の記事と同じ `pubDate` を明示したとき）。対処は 2 つ。

- **別の記事を書いているつもりなら `pubDate` を 1 秒ずらす。** 公開先が変わって衝突が消える
- **同じ記事を直しているなら上書きを承認する。** コミットメッセージが「更新」になり、
  以前の内容は Git の履歴に残る

**409 のときリポジトリは 1 バイトも変わらない。** blob もコミットも作られないので、
デプロイも起動しない（何も反映するものが無いため）。

存在確認は `?ref=<base commit sha>`（コミットの親）に固定してあり、確認とコミットの間に
`main` が進めば ref の更新（force なし）が 422 で落ちる。**古い読みに基づいて上書きする窓は無い**
（三段の内訳は下の「編集・削除の並行制御」）。

以前の内容が要るときは Git の履歴から取る（上書きしてもコミットは残る）。

```sh
git -C <blog-content の clone> log --oneline -- posts/<slug>.md
git -C <blog-content の clone> show <sha>:posts/<slug>.md
```

### 記事の一覧・編集・削除

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
