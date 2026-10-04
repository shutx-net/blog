# ルーティングとビヘイビア

### CloudFront Function は ES5.1 の範囲で書く

`functions/rewrite-uri.js` は CloudFront Functions のランタイムで動く。ローカルの単体テストは
node 24 の `node:vm` 上で走るため、**実ランタイムより大幅に寛容**で、ローカル green でも
デプロイ後に落ちうる。node 側に ES5.1 相当への静的な制限機構は無いので、規律で守る。

- `var` / `lastIndexOf` / `charAt` の範囲で書く。`const` / `let` / アロー関数 / `endsWith` を使わない
- ランタイムは `cloudfront-js-2.0` に固定してある（CDK の既定は `JS_1_0`。省略すると静かに 1.0 に落ちる）
- テストハーネスはソースの先頭に `'use strict';` を付けて評価する。CloudFront Functions は
  常に strict mode で動作し、これは変更できないため
- 実ランタイムでの検証は、デプロイを行うフェーズで `aws cloudfront test-function` による
  スモークテストとして足す

### エラーページは `/404.html` に解決される

CloudFront の `errorResponses` は 403 と 404 の両方を `ResponsePagePath: /404.html`・
`responseHttpStatus: 404` にマップしている。403 も入れるのは、OAC + S3 REST オリジンでは
バケットポリシーに `s3:ListBucket` が無く、S3 が「存在しない」と「権限が無い」を区別しないため、
存在しないキーが 404 ではなく 403 (AccessDenied) で返るからである。

- **`/404.html` は S3 のキー `404.html` に解決される。** Astro は `src/pages/404.astro` を
  `build.format` に関わらず `dist/404.html` として出す特別扱いをするが、これは infra からは
  検証できない（別ワークスペース）。もし `dist/404/index.html` になっていると
  エラーページ自体が 403 になって無意味になるので、site トラック側のビルド出力テストで固定すること
- **`CustomErrorResponses` は `DistributionConfig` 直下にあり、ビヘイビア単位ではなく
  ディストリビューション全体に効く。** したがって存在しない `/media/xxx.png` へのリクエストは
  403 → HTML の 404 ページ（`Content-Type: text/html`）を 404 ステータスで返す。`<img>` から見ると
  壊れた画像になるが、害は無いので受け入れる。ビヘイビア単位にする方法は CloudFront に存在しない
- `ErrorCachingMinTTL` は既定と同じ 10 秒を明示している。既定と同値でも、明示すると
  テンプレートに描画されてテストで固定でき、将来 300 秒などに変えたときに差分として見える

### 記事スラッグにドットを使わない

URI 書き換えは「最後のスラッシュより後にドットがあれば静的ファイル」というヒューリスティック。
そのため `/posts/node-24.19-notes` のようなドット入りスラッグは書き換えられない
（`test/rewrite-uri.test.ts` に既知の限界として固定済み）。

**強制点は `site/src/content.config.ts` ではない**（あのスキーマはフロントマターを検証するもので、
スラッグはファイル名から決まる）。実際に弾いているのは次の 2 つで、どちらもドットを含まない
文字だけを許す。**緩めるとここが壊れる。**

- `api/src/posts/slug.ts` の `DATE_SLUG_PATTERN` — 投稿 API がコミット先のパスを組む前に検査する
- `.github/workflows/deploy.yml` の `slug_shape` — ビルド後に publish されるスラッグを検査する

スラッグは日付パス（`2026/09/27/142621`）の 1 形式だけ。**文字クラスが `[0-9]` と `/` しか無く
桁数も固定なので、ドットは構造的に表現できない。** 以前は手入力の平坦スラッグも許していたが撤廃した。

### `/api/*` のビヘイビアで既定に任せてはいけない 4 つ

| 設定 | 既定 | 既定のままだと |
| --- | --- | --- |
| `allowedMethods` | `GET` / `HEAD` | **POST が 405 になる**（`ALLOW_ALL` なので `PUT` / `DELETE` も届く。下記） |
| `cachePolicy` | `CACHING_OPTIMIZED` | API の応答がキャッシュされる |
| `originRequestPolicy` | なし | — （`ALL_VIEWER` にすると `Host` が転送され、**OAC の署名が必ず失敗する**） |
| `viewerProtocolPolicy` | — | `redirect-to-https` にすると **リダイレクトで POST のボディが失われる**。`https-only` で拒否する |

`functionAssociations` は **付けない**。URI 書き換え Function は拡張子の無いパスに `/index.html` を
足すので、`/api/posts` が `/api/posts/index.html` になって 404 になる。
`test/distribution-api-behavior.test.ts` が 4 つとも固定している。

`allowedMethods` は `ALLOW_ALL`（7 メソッド）にしてある。**そのおかげで記事の更新（`PUT`）と
削除（`DELETE`）を足すときに infra を 1 行も変えずに済んだ** — 動詞を増やすのは
`api/src/router.ts` の `ROUTES` に行を足すだけになる。CloudFront 側で絞っていたら、
API の変更とディストリビューションの変更が同じ PR に縛られていた。

トークンも増えていない。記事用の installation token は `contents:write` で、
**write が read を含む**ので一覧・取得のために新しいトークンを鋳造する必要がない。
`actions:write` の 2 本目（デプロイの `workflow_dispatch` 用）とは別物のまま。

### `additionalBehaviors` の宣言順が本番の差分になる

`additionalBehaviors` のキー順は **`/media/*` -> `/api/*` -> `/_astro/*` から変えてはいけない。**

CDK は `Object.entries` の順（＝挿入順）でオリジンに `Origin1` / `Origin2` / `Origin3` と
番号を振り、OAC の論理 ID はその番号から作られる。実測で `/api/*` を先に書くと、
メディア用 OAC の論理 ID がこう変わる。

| 宣言順 | メディア用 OAC の論理 ID |
| --- | --- |
| `/media/*` -> `/api/*`（正） | `SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA` |
| `/api/*` -> `/media/*`（誤） | `SiteDistributionOrigin3S3OriginAccessControl4BE73D82` |

機能は同じだが、デプロイ時に **OAC の置換とバケットポリシーの書き換え** が起きる。
ソース上まったく見えない依存なので、`test/distribution-oac.test.ts` が OAC の論理 ID 集合を
リテラルで固定している。

`/_astro/*` を **末尾**に足したのも同じ理由である（先頭や中間に入れると既存 2 要素の位置が動く）。

#### 同じバケットへ 2 本目のビヘイビアを足すときはオリジンのインスタンスを再利用する

`/_astro/*` は配信用バケットを向く **2 本目**のビヘイビアで、オリジンはデフォルトビヘイビアと
**同じ `IOrigin` インスタンス**を渡している（`site-stack.ts` の `siteOrigin` をローカル変数に
括り出してある）。`Distribution.addOrigin` は `boundOrigins.find(b => b.origin === origin)` と
**インスタンス同一性**で既存のオリジン ID を引き当てるため（aws-cdk-lib 2.267.0 の実装）、
`withOriginAccessControl` をもう一度呼ぶと同じバケットなのにオリジンが増える。実測:

| 実装 | Origins | OAC | 結果 |
| --- | --- | --- | --- |
| インスタンスを再利用・**末尾**に追加（これ） | 3 | 3 | OAC の論理 ID 3 本が 1 文字も変わらない。増えるのは `ResponseHeadersPolicy` 1 本だけ |
| インスタンスを再利用・先頭に追加 | 3 | 3 | 論理 ID は同じく不変。ただし `CacheBehaviors` 配列の並びが動いて差分が増える |
| `withOriginAccessControl` を**もう 1 回呼ぶ** | **4** | **4** | 配信用バケットに 2 本目の OAC（`SiteDistributionOrigin4S3OriginAccessControl505731E1`）が生える |

固定しているテストは 2 本で、**どちらも相手の上位集合ではない。**

- `test/distribution-oac.test.ts` — OAC の論理 ID 集合をリテラルで固定する。3 行目の実装を落とすが、
  「`/_astro/*` がどのオリジンを向いているか」は見ていない
- `test/distribution-assets-behavior.test.ts` — `/_astro/*` の `TargetOriginId` が
  **デフォルトビヘイビアと一致する**ことを主張する。オリジンが 3 本に戻っていても、
  `/_astro/*` だけメディアバケットを向いた状態を落とす
