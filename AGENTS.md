# blog

shutx-net の個人ブログ。Markdown を Git で管理し、静的サイトとして AWS から配信する。

**本番稼働中。** 管理画面からの投稿がデプロイまで自動で通る状態にある。

## アーキテクチャ

管理画面 → Lambda が GitHub にコミット → GitHub Actions が Astro をビルド → S3 + CloudFront が配信。
Amplify Hosting は使わない（CloudFront の 1TB/月 永年無料枠に収まり、CDN を細かく制御できるため）。

## 開発環境

Nix flake で固定している。**セットアップ手順は `DEVELOPERS.md` を読むこと**（このファイルには取り込まない — 毎セッション読み込む必要がないため）。

## コマンド

```sh
npm run -w site dev              # Astro dev server
npm run -w site build            # site/dist/ に静的サイトを出力
npm run -w admin build
npm run -w api build             # esbuild で Lambda をバンドル

npm run lint                     # oxlint。**素の `oxlint` は warning があっても exit 0**
                                 # なので、`--deny-warnings` 込みのこのスクリプトで呼ぶ

npx -w infra cdk diff            # ★ deploy の前に必ず差分を見る
npx -w infra cdk deploy <Stack>
```

## 守ること

### Git が唯一の正

- 記事の実体は **private リポジトリ `shutx-net/blog-content` の `posts/*.md` だけ**。データベースはない。
  下書きを public に晒さないため、かつコード側の履歴を記事コミットで動かさないために分離してある
- **このリポジトリに記事を置かない。** `site/src/content/posts/` は `.gitignore` 済み。
  `.gitkeep` も置かないこと。`site/test/fixtures/posts/*.md` はテスト用フィクスチャで本番には出ない
- **固定ページ（プロフィール・プライバシーポリシー）は例外で、このリポジトリの
  `site/src/content/pages/*.md` に置く**（`pages` コレクション）。公開前提で更新も稀なので、
  記事を分けた 2 つの理由（下書きの秘匿・コード履歴の保護）が当てはまらず、
  プライバシーポリシーは改定履歴が公開されているほうがよい。**`posts` には入れないこと**
  （RSS に配信され、スラッグ照合のガードと記事 API の一覧が落ちる）。
  **ルートは `site/src/pages/*.astro` が持ち、`getEntry` が空なら throw する。**
  コレクションからルートを生成すると、md が消えたとき空のままビルドが緑になり、
  `s3 sync --delete` が本番のページを消す
- **content repo を `site/src/content/posts` へ直接 checkout しない。**
  `actions/checkout` はリポジトリの**ルート**を `path` に置くので、`README.md` が
  コレクションに混ざり、記事が 1 階層深くなって `entry.id` が `posts/2026/09/27/142621` になる。
  **URL と RSS の `<guid>` が変わる = 購読者への全記事再配信で、取り消せない。**
  `content-repo` に降ろしてから `posts/` だけを移すこと（ローカルで clone するときも同じ）
- **astro は記事 0 本でもビルドに成功する**（glob loader は warn して return するだけ）。
  だから `deploy.yml` に**ガードが 3 つ**書いてある（本数 / rss item 数 /
  スラッグの形と集合の一致）。**下限は整数リテラルで、いまは 1。0 にしてはならない**
- **拘束するのは総数ではなく公開可能数。** 下書きは `.md` の本数には入るがサイトには出ないので、
  公開分が 0 本になるとスラッグ照合のガードが落ちる。記事 API は `wouldStarveSite` で先に拒否し、
  その `PUBLISHABLE_MINIMUM` が `deploy.yml` の `minimum` と同値であることをテストが固定している。
  **削除だけでなく、最後の公開記事を `draft: true` にする更新も同じ状態を作る**
- **記事のスラッグは `pubDate` から導出する日付パスだけ**（`YYYY/MM/DD/HHmmss`、Asia/Tokyo）。
  平坦スラッグは撤廃した。**既存の URL を変えないこと**（上と同じ理由で取り消せない）。
  したがって **`pubDate` は編集で変えられない**（400 になる）。日付を直すには削除して再投稿する
- **`deploy.yml` はスラッグが日付パスの形であることを直接主張する。** 数と集合の一致では
  入れ子を検出できない — corpus も dist も同じだけ深くなるため。シェルは POSIX ERE で `(?:` が
  書けないので `DATE_SLUG_PATTERN` と**同義の別表現**になっており、一致はテストが両方走らせて固定している
- **スラッグにドットを使わない。** `infra/functions/rewrite-uri.js` が「最後のスラッシュより後に
  ドットがあれば静的ファイル」で判定するため書き換えが効かない。`DATE_SLUG_PATTERN` は数字と
  スラッシュだけなので自動的に満たされる — **緩めないこと**
- **`pubDate` は明示的なオフセットが必須**（無ければ 400）。オフセットが無いと `Date.parse` が
  ホストの TZ で解釈し、**著者のブラウザの TZ が公開先を決めてしまう**。管理画面は
  `datetime-local` の値を **JST の壁時計時刻**として変換して送る
- 記事 API は **Git Data API（blob → tree → commit → ref）で 1 コミットにまとめる**。作成・更新・削除とも。
  Contents API は 1 リクエスト 1 ファイルなので、複数ファイルを書くと中途半端な状態でビルドが走る。
  **`base_tree` を必ず渡す。** 落とすとリポジトリ全体が 1 コミットで消える（削除は tree の `sha: null`）
- 記事を 1 本足すと一覧・タグ・ページネーション・RSS・sitemap が全部作り直しになる。部分デプロイという概念はない

### 画像を Git に入れない

- 管理画面が Lambda から presigned PUT URL を受け取り、ブラウザから S3 へ直接上げる
  （Lambda の同期ペイロード上限 6MB を避ける。リポジトリも太らせない）
- **`site/public/` に記事の画像を置かない。** ここはファビコンや `robots.txt` 用
- **サイト配信用とメディア用で S3 バケットを分ける。** 同じバケットに同居させると
  `aws s3 sync dist/ s3://... --delete` がメディアを巻き込んで消す

### 認証情報

- **このリポジトリは public。** AWS のアクセスキーを置く選択肢はない。Actions は OIDC でロールを assume する
- GitHub App の**秘密鍵（PEM）だけ**を Secrets Manager に置く。
  installation access token は TTL 1 時間なので保管せず、秘密鍵で JWT を署名して都度交換する
- **CDK に秘密の値を書かない。** 空のシークレットを CDK で作り、値は CLI かコンソールで一度だけ入れる
  （CloudFormation テンプレートに平文が残るため）
- **記事 API は読み取り経路も認証必須。** `blog-content` は private で下書きが入っており、
  一覧・取得を開けると下書きが誰にでも読める。`GET /api/health` だけが例外で、
  `ROUTES` の全件走査がそれを主張している
- **編集と削除は楽観的並行制御（blob sha）を必須にする。** 省略可にすると制御を外して呼べる経路ができる

### AWS

- Lambda ランタイムは **`nodejs24.x`**（`nodejs20.x` は 2026-04-30 に非推奨）
- S3 はブロックパブリックアクセス 4 つとも有効のまま、CloudFront の **OAC** 経由でのみ読ませる。OAI は使わない
- **CloudFront Functions で URI を書き換える。** S3 を REST オリジンにすると `/about` は
  `/about/index.html` に解決されない（`DefaultRootObject` が効くのはルートだけ）
- CDK CLI は nix ではなく npm の devDependency。`aws-cdk` と `aws-cdk-lib` のバージョンをずらさないため、
  必ず `npx -w infra cdk` で呼ぶ
- **CSP の `style-src-attr` から `'unsafe-inline'` を外さない。** shiki はコードフェンスを
  `style="color:#..."` **属性**で色付けするので、外すと色が飛ぶ。`script-src-attr 'none'` との
  非対称は意図的。**本番の記事にコードフェンスが無い間は無症状で通る**ので、テストだけが見張り

### Cache-Control

- **`Cache-Control` は ResponseHeadersPolicy でだけ付ける。S3 のオブジェクトメタデータには書かない。**
  定義が 2 箇所にあると乖離する。加えて現行のキャッシュポリシーは **MinTTL が 1（> 0）**で、
  AWS は「MinTTL > 0 のとき origin の `no-cache` / `no-store` / `private` を無視する」と明記している。
  S3 側に `no-cache` を書くと **CDN キャッシュが 1 秒に潰れ、毎リクエストが S3 に行く**
- `aws s3 sync --cache-control` も使わない。sync の比較は**サイズと更新時刻だけでメタデータを見ない**ので、
  内容が変わっていないオブジェクトは取り残される
- **サイトは `no-cache`。** ブラウザに毎回検証させる（ETag があるので 304 が返り本文は流れない）。
  ResponseHeadersPolicy の `Cache-Control` は **viewer response にしか付かず CloudFront のキャッシュ挙動には
  影響しない**ので、CDN は DefaultTTL 86400 のままデプロイ時の invalidation で更新される
- **`/media/*` は `immutable`。** キーが `media/<年>/<月>/<24 桁の乱数>.<拡張子>` で上書きされないため。
  **キーの作り方を変えるならこの宣言も変えること**
- **`/_astro/*` も `immutable`。** vite が `_astro/<名前>.<内容ハッシュ>.<拡張子>` を出すため
  （Astro の `build.assets` の既定が `_astro`。上書きしていない）。**もう 1 つの前提は
  `site/astro.config.mjs` の `build.inlineStylesheets: "never"`** — 既定の `"auto"` に戻すと、
  ビルド後の CSS が vite の 4096 B を割った日に全ページがインライン `<style>` になり
  `style-src 'self'` に落とされる（実測: 3643 B で 13/13 の HTML がインライン化され
  `dist/_astro/` が空になった。いまの余裕は 6741 - 4096 = 2645 B）。
  **`/admin/assets/*` は含まれない**（`base: '/admin/'` なので `/_astro/*` に一致せず `no-cache` のまま）。
  値は `/media/*` と同じだが**定数もポリシーも別に置く**（真である条件が違う。片方が崩れた日に
  もう片方を道連れにしないため）。**存在しない `/_astro/*` の 404 は `immutable` ではなく
  `no-cache` で返る**（エラーページはデフォルトビヘイビアのポリシーを取る。実測。詳細は `infra/README.md`）
- Cache-Control が無いとブラウザは*ヒューリスティックキャッシュ*（`Last-Modified` からの経過の 10% 程度）を
  適用する。invalidation はブラウザには届かないので、**更新したのに反映されない**という事故になる（実際に踏んだ）

### Lambda のバンドル

- **ビルドの定義は `api/build.ts` ただ 1 つ。** `npm run -w api build` も infra の synth も
  同じ `buildApiBundle()` を呼ぶ。esbuild のフラグを `package.json` や `infra/` に書き戻さない
- **`cdk synth` / `cdk deploy` は、固める直前にソースからバンドルを作り直す。**
  `Code.fromAsset` はディレクトリの中身をそのまま固めるだけで、ソースと一致しているかを見ないため。
  「成果物が新鮮か調べる」方式は採らない — 何を入力と見なすかで必ず取りこぼしが残る
- **書きかけのバンドルを `api/dist` の中に置かない。** そこは `Code.fromAsset` が丸ごと
  指紋を取る対象で、CDK は列挙してから stat するため、途中で消えるファイルがあると
  ENOENT で synth が落ちる（`api/.build-staging/` に逃がしてある）。
  **落ちるとテストがファイルごと実行されずに終わるので、件数を見ないと緑に見える**
- したがって **`api/dist` を手で汚しても本番には出ない。** 逆に言えば
  **ソースが汚れていればそのまま本番に出る。** 変異テストの後始末は `git status` で確認すること
  （実際に、変異したバンドルが本番に載って 6 バイト食い違ったまま動いた事故がある）
- **ただし `api/dist` は `.gitignore` 済みなので `git status` にも `git checkout` にも写らない。**
  変異を戻したあとは `node api/build.ts` で作り直すこと。汚れたままだと
  成果物を読むテスト（`api/test/build/bundle.test.ts`）だけが落ちて原因が見えにくい

### タイムゾーン

- **Asia/Tokyo を `+09:00` の固定オフセット算術で実装している**（`api/src/posts/slug.ts`）。
  `api/src/posts/` はブラウザにもそのまま入る依存ゼロのコードなので、ICU データの有無に
  関わらず決定的にしたい。日本に DST は無い。**ずれないようテストが `Intl` と突き合わせている**
- **JST のマシンでは TZ 依存のバグを原理的に検出できない**（2 つの実装が全入力で真に等価になる。
  実測で変異は JST 0 件 / UTC 6 件）。**CI が UTC で走ることだけが捕まえている。**
  テストの TZ を固定して緑にする逃げを使わないこと

### テスト

- **テストは `os.tmpdir()` に書かない。** `api/test/support/scratch.ts` の `scratchDir()` を使う。
  `github-token.test.ts` が「token をディスクに残さない」を `readdirSync(tmpdir())` の
  前後比較で見ているので、**別スイートが tmpdir を触ると落ちる**
- 見張りは **`scratch-isolation.test.ts`（テキスト走査）と oxlint の 2 本立て。
  どちらも相手の上位集合ではない** — 別名 import は oxlint だけが、動的 import と
  `node:` 接頭辞なしはテキスト走査だけが捕まえる。**片方を消すと穴が開く**
  （実測表は `.oxlintrc.json` のコメント）
- **プロセスを跨いで見える場所を壊すテストを書かない。** 同じ形の事故が 3 回起きた
  （`api/dist` の共有 / 書きかけを `Code.fromAsset` の対象に置く / `os.tmpdir()`）。
  **失敗はファイルごと実行されずに終わるので、件数を見ないと緑に見える**

### Markdown

- Astro の既定プロセッサは Sätteri（Rust）だが、**このプロジェクトは `@astrojs/markdown-remark` を明示的に使う。**
  管理画面のプレビューと本番で同じ remark 構成を共有し、見た目を一致させるため
- プレビュー側の remark プラグイン構成を変えたら、`site/astro.config.mjs` も必ず揃える

## コード

- TypeScript。npm workspaces（`site` / `admin` / `api` / `infra`）
- インデント 2 スペース。**これは機械検査されていない** — oxlint はリンタであって
  フォーマッタではなく、`indent` ルール自体が存在しない。フォーマッタは入れていない
- **機械検査できる規約は `.oxlintrc.json` に書く**（jsonc なので理由もそこに書ける）。
  文章で書くだけの規約を増やさない。**ただし oxlint で表現できないものは多い** —
  何が無理かは `DEVELOPERS.md`。**検査されていないものを「検査されている」と書かないこと**
- Astro のコンテンツスキーマは `site/src/content.config.ts` に Zod で定義する。
  フロントマターの書き間違いをビルドで落とすため

## 外部ライブラリを足すとき

**最重要の基準は「継続的にメンテナンスされているか」。** 機能・性能・書き味・人気より上位に置く。

このリポジトリは public で、`api/` は GitHub App の秘密鍵を Secrets Manager から読んで
JWT に署名し、`admin/` は投稿の全権限を持つ。**依存が乗っ取られる／放棄されると、
被害が本番の資格情報と書き込み経路に直結する。**

### 主張ではなく実測すること

```sh
npm view <pkg> time.modified time.created dist-tags --json    # 最終公開日
npm view <pkg> deprecated maintainers license --json          # 非推奨・メンテナ数
npm view <pkg> dependencies --json                            # 推移依存の表面積
gh api repos/<owner>/<repo> --jq '{archived, pushed_at, open_issues_count}'
```

判断の根拠は数値で `toolchain.rationale`（計画）と PR 本文に残す。
**「広く使われているから」「人気があるから」は理由にならない。**

### 不採用にする条件

- リポジトリが archived
- `deprecated` フィールドが立っている
- 12 か月以上リリースが無い（意図的に完成しているライブラリは例外。その旨を明記する）

採用するが注意が要る条件（理由を明記すること）:

- メンテナが実質 1 人で後継がいない
- 推移依存が多い。**同じ用途なら依存の少ない候補を優先する**

### 依存を足さない選択を先に検討する

- **標準ライブラリで足りないか。** `node:crypto` の枯れたプリミティブで済むなら、依存ゼロが最も安全
- **既にある依存を再利用できないか。** 別系統の同種ライブラリを持ち込まない
  （Markdown は remark 系に統一する。プレビューと本番の一致という要件からも同じものを使う）
- **`<textarea>` で足りるものにリッチエディタを入れない**

### バージョンは完全固定

キャレットもチルダも付けない。`^1.2.3` は「次に誰かが `npm install` した日に別の
コードが入る」という意味であり、固定の目的を失う。更新は意図的な PR で行う。

## リポジトリ運用

- `main` に直接 push しない。ブランチを切って PR を出す
- **コミットメッセージの 1 行目は Conventional Commits のプレフィックスで始める**
  （`feat` / `fix` / `docs` / `test` / `refactor` / `build` / `ci` / `chore`）。
  scope は省略可、使うならワークスペース名。本文は日本語で可、1 行目は 50 字程度
- `infra/` を変えた PR では `npx -w infra cdk diff` の出力を本文に貼る
