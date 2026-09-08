# blog

shutx-net の個人ブログ。Markdown を Git で管理し、静的サイトとして AWS から配信する。

**現在スキャフォールド中。** 下の構成とコマンドは合意済みの設計であり、まだ存在しないファイルもある。

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

npx -w infra cdk diff            # ★ deploy の前に必ず差分を見る
npx -w infra cdk deploy <Stack>
```

## 守ること

### Git が唯一の正

- 記事の実体は **private リポジトリ `shutx-net/blog-content` の `posts/*.md` だけ**。データベースはない。
  下書きを public に晒さないため、かつコード側の履歴を記事コミットで動かさないために分離してある
- **このリポジトリに記事を置かない。** `site/src/content/posts/` は `.gitignore` 済み。
  `.gitkeep` も置かないこと。`site/test/fixtures/posts/*.md` はテスト用フィクスチャで本番には出ない
- **content repo を `site/src/content/posts` へ直接 checkout しない。**
  `actions/checkout` はリポジトリの**ルート**を `path` に置くので、`README.md` が
  コレクションに混ざり、記事が 1 階層深くなって `entry.id` が `posts/hello-world` になる。
  **URL と RSS の `<guid>` が変わる = 購読者への全記事再配信で、取り消せない。**
  `content-repo` に降ろしてから `posts/` だけを移すこと（ローカルで clone するときも同じ）
- **astro は記事 0 本でもビルドに成功する**（glob loader は warn して return するだけ）。
  だから `deploy.yml` に**ガードが 3 つ**書いてある（本数 / rss item 数 /
  スラッグの平坦性と集合の一致）。下限は整数リテラル。
  記事を意図的に下限より減らすときは、その数字も同じ PR で下げること
- **記事のスラッグは平坦**（`/posts/<slug>/` の 1 階層）。`deploy.yml` が直接主張している。
  数と集合の一致だけでは入れ子を検出できない（corpus も dist も同じだけ深くなるため一致してしまう）
- 投稿 API は **Git Data API（blob → tree → commit → ref）で 1 コミットにまとめる**。
  Contents API は 1 リクエスト 1 ファイルなので、複数ファイルを書くと中途半端な状態でビルドが走る
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

### AWS

- Lambda ランタイムは **`nodejs24.x`**（`nodejs20.x` は 2026-04-30 に非推奨）
- S3 はブロックパブリックアクセス 4 つとも有効のまま、CloudFront の **OAC** 経由でのみ読ませる。OAI は使わない
- **CloudFront Functions で URI を書き換える。** S3 を REST オリジンにすると `/about` は
  `/about/index.html` に解決されない（`DefaultRootObject` が効くのはルートだけ）
- CDK CLI は nix ではなく npm の devDependency。`aws-cdk` と `aws-cdk-lib` のバージョンをずらさないため、
  必ず `npx -w infra cdk` で呼ぶ

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
- Cache-Control が無いとブラウザは*ヒューリスティックキャッシュ*（`Last-Modified` からの経過の 10% 程度）を
  適用する。invalidation はブラウザには届かないので、**更新したのに反映されない**という事故になる（実際に踏んだ）

### Lambda のバンドル

- **ビルドの定義は `api/build.ts` ただ 1 つ。** `npm run -w api build` も infra の synth も
  同じ `buildApiBundle()` を呼ぶ。esbuild のフラグを `package.json` や `infra/` に書き戻さない
- **`cdk synth` / `cdk deploy` は、固める直前にソースからバンドルを作り直す。**
  `Code.fromAsset` はディレクトリの中身をそのまま固めるだけで、ソースと一致しているかを見ないため。
  「成果物が新鮮か調べる」方式は採らない — 何を入力と見なすかで必ず取りこぼしが残る
- したがって **`api/dist` を手で汚しても本番には出ない。** 逆に言えば
  **ソースが汚れていればそのまま本番に出る。** 変異テストの後始末は `git status` で確認すること
  （実際に、変異したバンドルが本番に載って 6 バイト食い違ったまま動いた事故がある）

### Markdown

- Astro の既定プロセッサは Sätteri（Rust）だが、**このプロジェクトは `@astrojs/markdown-remark` を明示的に使う。**
  管理画面のプレビューと本番で同じ remark 構成を共有し、見た目を一致させるため
- プレビュー側の remark プラグイン構成を変えたら、`site/astro.config.mjs` も必ず揃える

## コード

- TypeScript。npm workspaces（`site` / `admin` / `api` / `infra`）
- インデント 2 スペース
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
- コミットメッセージは日本語で可。1 行目は 50 字程度に収める
- `infra/` を変えた PR では `npx -w infra cdk diff` の出力を本文に貼る
