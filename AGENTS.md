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

- 記事の実体は `site/src/content/posts/*.md` だけ。データベースはない
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

### Markdown

- Astro の既定プロセッサは Sätteri（Rust）だが、**このプロジェクトは `@astrojs/markdown-remark` を明示的に使う。**
  管理画面のプレビューと本番で同じ remark 構成を共有し、見た目を一致させるため
- プレビュー側の remark プラグイン構成を変えたら、`site/astro.config.mjs` も必ず揃える

## コード

- TypeScript。npm workspaces（`site` / `admin` / `api` / `infra`）
- インデント 2 スペース
- Astro のコンテンツスキーマは `site/src/content.config.ts` に Zod で定義する。
  フロントマターの書き間違いをビルドで落とすため

## リポジトリ運用

- `main` に直接 push しない。ブランチを切って PR を出す
- コミットメッセージは日本語で可。1 行目は 50 字程度に収める
- `infra/` を変えた PR では `npx -w infra cdk diff` の出力を本文に貼る
