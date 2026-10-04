# スタック構成と定数

### メディアバケットを別 Stack にできない（実験で確定済み）

`AGENTS.md`「サイト配信用とメディア用で S3 バケットを分ける」が要求しているのは
「**バケット**を分ける」ことであって「**スタック**を分ける」ことではない。
`sync --delete` からメディアを守る目的は、同一スタック内の別バケットで完全に満たされる。
`MediaBucket` は `lib/media-bucket.ts` の Construct として `SiteStack` の中に置いてある。

これは好みではなく、別 Stack が **物理的に不可能** だと実験で確定したためである。
`BlogMediaStack` がバケットを持ち、`SiteStack` の Distribution が `additionalBehaviors` で
参照する版を実際に書いて `cdk synth` すると、こう落ちる。

```
[«DependencyCycle» 'BlogMediaStack' depends on 'BlogSiteStack'
 (BlogMediaStack -> BlogSiteStack/SiteDistribution/Resource.Ref).
 Adding this dependency (BlogSiteStack -> BlogMediaStack/MediaBucket/Resource.RegionalDomainName)
 would create a cyclic reference.]
```

原因は依存が双方向になること。`aws-cloudfront-origins/lib/s3-bucket-origin.js` の
`grantDistributionAccessToBucket()` を読むと、`withOriginAccessControl()` は
`bucket.addToResourcePolicy()` を呼び、`AWS:SourceArn` 条件に Distribution の `Ref` を埋め込む。
つまり **バケット側のポリシーが Distribution を参照する**。同時に Distribution の
`Origins[].DomainName` は **バケットの `RegionalDomainName` を参照する**。別スタックにあると
この 2 本が逆向きのクロススタック参照になって循環する。

回避策はどれも代償が大きく、**採ってはならない**。

- バケットに物理名をハードコードして `fromBucketAttributes` で import する — 「物理名を
  ハードコードしない」方針に反するうえ、import したバケットには `addToResourcePolicy` が効かず、
  CDK が `Cannot update bucket policy of an imported bucket` と **警告するだけで失敗せず、
  バケットポリシーが黙って作られない**。confused deputy 対策を手書きで維持する羽目になる
- `SourceArn` をワイルドカードに緩める — セキュリティを落として構造の都合を通すことになり本末転倒

将来どうしても別スタックにしたくなったら、Distribution も一緒に移すか、メディア専用の
第 2 ディストリビューションを立てるしかない。

対照的に `CicdStack` は Stack にしてよい。参照が **一方向** だからである（`CicdStack` は
`SiteStack` のバケット ARN とディストリビューションを読むだけで、`SiteStack` 側に何も書き込まない）。
`cdk_best_practices` の「Model with constructs, deploy with stacks — Represent logical units as
Construct, not Stack. Use stacks only for deployment composition」とも一致する。

### 投稿 API も別 Stack にできない（ただし理由が上とは違う）

`PostingApi` も `lib/posting-api.ts` の Construct として `SiteStack` の中にある。
ここを「OAC だから循環する」と丸めて覚えると、メディアバケットに触らない別の Lambda まで
不要に `SiteStack` へ押し込むことになる。

`FunctionUrlOrigin.withOriginAccessControl()` は `S3BucketOrigin` と **形が違う**。
`s3-bucket-origin` はバケット側のリソースポリシーを書き換えるので、バケットのスタックに
Distribution の `Ref` が入る。対して `function-url-origin` の `addInvokePermission()` は
`new lambda.CfnPermission(scope, ...)` を **bind の scope（＝ Distribution 側のスタック）** に作る。
実測でも `AWS::Lambda::Permission` は `BlogSiteStack` 側に生成され、参照は
`SiteStack -> ApiStack` の一方向で済む。**つまり OAC だけなら別スタックにできる。**

循環させているのは presigned URL 側の要件のほうである。

- Lambda はメディアバケットの **名前** を環境変数で知る必要がある（Api -> Site）
- Lambda の IAM は同バケットの ARN に `s3:PutObject` を必要とする（Api -> Site）
- Distribution は Function URL を必要とする（Site -> Api）

実測エラー（環境変数だけの版でも起きる）。

```
'BlogSiteStack' depends on 'BlogApiStack'
 (BlogSiteStack -> BlogApiStack/Api/Function/FunctionUrl/Resource.FunctionArn).
 Adding this dependency (BlogApiStack -> BlogSiteStack/MediaBucket/Bucket/Resource.Ref)
 would create a cyclic reference.
```

正確な条件は「**Distribution が参照するリソースと、そのリソースが参照する `SiteStack` 内の
リソースが両方存在すること**」。将来どうしても分けたくなったら、メディアバケットも
Distribution も一緒に動かすしかない。

### `SITE_ORIGIN` 定数

`infra/lib/site-stack.ts` に配信ドメインを **文字列でハードコードしている。**
「物理名をハードコードしない」方針の **意図的な例外**である。カスタムドメインが入って
**定数は「許可リスト」と「正のオリジン」の 2 系統**になった。

```ts
/** CloudFront が自分で配るドメイン。alias ではないので消えない（退路） */
export const CLOUDFRONT_ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';
/** カスタムドメイン。DNS は Cloudflare / 証明書は us-east-1 の ACM（どちらも帯域外） */
export const CUSTOM_DOMAIN_NAME = 'blog.shutx.net'; // Distribution の domainNames にも入る
export const CUSTOM_ORIGIN = `https://${CUSTOM_DOMAIN_NAME}`;

/** **正（canonical）のオリジン 1 本。テンプレートには 1 文字も現れない。** */
export const SITE_ORIGIN = CUSTOM_ORIGIN;
/** **許可リスト。テンプレートに描画されるのはこちら。** */
export const SITE_ORIGINS: readonly string[] = [CLOUDFRONT_ORIGIN, CUSTOM_ORIGIN];
```

**理由 1: `distribution.distributionDomainName` は原理的に使えない。**
`CorsConfiguration` は `AWS::S3::Bucket` **本体**のプロパティなので、そこに Distribution の
`Fn::GetAtt` を入れると循環参照になる。

```
Media.Properties.CorsConfiguration...AllowedOrigins = Fn::GetAtt [Dist, DomainName]
Dist.Properties...Origins[0].DomainName            = Fn::GetAtt [Media, RegionalDomainName]
```

**実測（実際に循環を作って確認した）:**

| 検出手段 | 結果 |
| --- | --- |
| `npx -w infra cdk synth` | **exit 0 で成功する。** CLI は同一スタック内のリソース間循環を検出しない |
| `Template.fromStack()`（vitest） | **throw する。** ただしテストファイルの読み込み時点で落ちるので、どのアサーションが何を言っているか分からない（全 `it` が消える） |
| cfn-lint | **E3004** で検出する |

`cdk synth` だけを回していると `cdk deploy` で初めて分かる。だから
`test/media-bucket.test.ts` に「**`AWS::S3::Bucket` の `Properties` から Distribution を
`Fn::GetAtt` している箇所が 1 つも無い**」という名指しの回帰テストを置いてある。
バケットポリシー（別リソース）が Distribution を参照するのは問題ない。

**理由 2:** 同じ値が Cognito の `CallbackURLs` でも必要で、どのみち synth 時に確定した
文字列でなければならない。**メディアの CORS と `CallbackURLs` / `LogoutURLs` は、どれも
`SITE_ORIGINS` という同じ 1 つの配列を参照する**（2 か所に別々の文字列を書くと
「ログインはできるが画像が上がらない」というデバッグしにくい壊れ方をする）。

一致は `test/site-origins.test.ts` が**テンプレートから読んだ 2 つの集合を突き合わせて**
保証する（定数を import して定数と比べる形は両辺が一緒にずれるので、値そのものは
リテラル 2 本で別に主張している）。

**理由 3: 許可リストと正のオリジンは別物で、可逆性が違う。** 許可リストは広げても戻せるが、
正のオリジンは戻せない。

| 定数 | どこに描画されるか | 変えると |
| --- | --- | --- |
| `SITE_ORIGINS`（許可リスト） | Cognito の `CallbackURLs` / `LogoutURLs`、メディアバケットの CORS `AllowedOrigins` | **可逆。** 1 本足すと両方のオリジンが同時に有効になるだけで、外して deploy し直せば戻る |
| `SITE_ORIGIN`（正のオリジン） | **どこにも描画されない。** `.github/workflows/deploy.yml` の `SITE_URL` の鏡である | **不可逆。** canonical link / sitemap / RSS の `<guid isPermaLink="true">` が動く ＝ 購読者への全記事再配信（AGENTS.md） |

`SITE_ORIGIN` が deploy.yml の `SITE_URL` と一致することは、`test/site-origins.test.ts` が
**deploy.yml を実際に parse して**固定している。これが**切替をやりかけて止めた状態を禁じる
唯一のアサーション**であり、片方だけ倒すことはできない。
手順は `infra/docs/custom-domain.md` の 9 番。

**`SITE_ORIGINS` の順序を入れ替えないこと。** 機能は変わらないが配列としてテンプレートに
描画されるので、並べ替えただけで `cdk diff` に差分が出る（CORS と Cognito の 2 リソース）。
**先頭は正のオリジンではない。** 配列は追加順のままで、`SITE_ORIGIN` が `CUSTOM_ORIGIN` に
移ったあとも `CLOUDFRONT_ORIGIN` が先頭に残っている。「正を先頭に」と直したくなるが、
得られるのはコンソールを目で見たときの見た目だけで、代わりに意味の無い差分と deploy が 1 回要る
（`test/site-origins.test.ts` は期待値を**順序付きのリテラル配列**で固定しているので落ちる）。

**`CLOUDFRONT_ORIGIN` を変えるのは CloudFront のドメインが変わったときだけ。** ドリフトの確認:

```sh
aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
```

**カスタムドメインの方はこの Output には出ない**（`Aliases` は CfnOutput にしていない）。
そちらは `aws cloudfront get-distribution-config` か、`infra/docs/custom-domain.md` の
「8. 受け入れ確認」の `openssl s_client` で見る。

`ADMIN_LOGIN_DOMAIN_PREFIX`（`shutx-blog-admin`）も同じ性質の例外である。Cognito の
プレフィックスドメインは **AWS グローバルで一意**でなければならず、CDK に自動生成させられない。
他アカウントに取られていれば `cdk deploy` が明示的なエラーで落ちるだけなので静かには壊れない。
**アカウント ID を混ぜて一意性を上げる案は採らない** — Managed Login の URL は利用者の
ブラウザに表示されるので、そこに AWS アカウント ID を載せたくない。

### cdk_best_practices との既知の乖離

いずれも意図的。

- **`env` を明示していない。env を入れる予定はもう無い。** 理由は 3 つ。(1) AWS 認証情報が
  無い環境では `env: { account: process.env.CDK_DEFAULT_ACCOUNT, ... }` が認証情報の有無で
  展開を変えてしまい、アサーションテストが環境依存になる。(2) 必要な ARN はすべて
  `AWS::Partition` / `AWS::AccountId` の疑似パラメータで組める（実測で確認）。
  (3) **ACM 証明書は帯域外で us-east-1 に作り、ARN で参照するだけにした**ので、カスタムドメインを
  入れても要らなかった — `Stack.formatArn` が同じ疑似パラメータから ARN を組み、リージョンだけを
  `'us-east-1'` で上書きする（`SITE_CERTIFICATE_ID` の JSDoc）。`test/site-stack.test.ts` が
  env-agnostic（`account` / `region` がトークンであること）を固定し続ける
- **ステートフル（S3）とステートレス（CloudFront）を同一スタックに置いている。**
  個人ブログでバケットの中身は Git から完全に再生成できるビルド成果物であり「ステートフル」の
  実質が薄い。スタックを割るとクロススタック参照が増え、`withOriginAccessControl` による
  バケットポリシーの自動更新（同一スタック内で行われる）が使えなくなる副作用のほうが大きい
- **`terminationProtection` を設定していない。** `removalPolicy: RETAIN` でバケット自体は
  保護しており、個人ブログの規模には過剰と判断した
- **`cdk init` を使っていない。** 空ディレクトリを要求し独自の `package.json` と jest 構成を
  吐くうえ、CDK CLI が PATH に無く `npx -w infra cdk` は `infra/package.json` が先に無いと
  呼べない（鶏と卵）。そのため `cdk.json` の context（フィーチャーフラグ）は手で書いている
- **cdk-nag を入れていない。** `cdk_best_practices` が「適用前に必ずユーザーの同意を取れ」と
  明示しているため、導入可否は人間の判断待ち
- **クロススタック参照は `strong` のまま。** `cdk.json` の
  `@aws-cdk/core:defaultCrossStackReferences` は `strong`。strong は Export /
  `Fn::ImportValue` を使うため、producer である `BlogSiteStack` は consumer が存在する限り
  Export を消せない（deadly embrace）。`weak`（`Fn::GetStackOutput`）なら結合を作らない。
  **1 行で切り替えられたのは初回デプロイ（2026-08-30）までで、いまは `both` → deploy →
  `weak` の 3 段階移行が要る。** 判断の材料は「strong の失敗は静かで後から効き、weak の
  失敗は最初のデプロイで大きな音を立てて落ちる」

### ツールチェーン

- `aws-cdk-lib` と `aws-cdk`（CLI）は **完全固定**（`^` を付けない）。両者のバージョンを
  ずらさないため。`test/toolchain.test.ts` が固定文字列であることを機械的に検査している
- CDK CLI は nix ではなく npm の devDependency。必ず `npx -w infra cdk` で呼ぶ（DEVELOPERS.md）
- TypeScript のトランスパイラは入れていない。node 24 の型ストリップで `node bin/blog.ts` が
  そのまま動くため、`cdk.json` の `app` は `node bin/blog.ts`。ts-node も tsx も要らない
- その代償として **erasable syntax のみ**に制限される（enum / namespace / パラメータプロパティ /
  decorators が使えない）。`tsconfig.json` の `"erasableSyntaxOnly": true` で型検査時に強制している。
  これが無いと enum を書いた瞬間に `cdk synth` だけが実行時に落ちる
- `"type": "module"` なので相対 import は拡張子必須（`./site-stack.ts` のように `.ts` まで書く）
