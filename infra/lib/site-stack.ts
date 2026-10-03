import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
// **api の定数をそのまま使う。** 同じ文字列を 2 箇所に書くと、片方だけ直した日に
// Lambda が blog-content の中へ site/src/content/posts/ を作る。
import { CONTENT_POSTS_PATH_PREFIX } from '../../api/src/github/commit.ts';
import { AdminAuth } from './admin-auth.ts';
import { MediaBucket } from './media-bucket.ts';
import { PostingApi } from './posting-api.ts';
import {
  ASTRO_ASSETS_CACHE_CONTROL,
  HSTS_MAX_AGE_SECONDS,
  MEDIA_CACHE_CONTROL,
  REFERRER_POLICY,
  SITE_CACHE_CONTROL,
  buildCsp,
} from './response-headers.ts';

// cdk synth がどこから実行されるか分からないので、cwd 基準の相対パスにしない。
// "type": "module" なので __dirname は存在しない。
const REWRITE_URI_PATH = fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url));

/**
 * メディアバケットに振り分けるパス。
 *
 * '/404.html' はこれに一致しないので、エラーページはデフォルトビヘイビア
 * （配信用バケット）から正しく返る。
 */
export const MEDIA_PATH_PATTERN = '/media/*';

/**
 * 投稿 API に振り分けるパス。
 *
 * **additionalBehaviors のキー順は /media/* -> /api/* から変えないこと。**
 * CDK は Object.entries の順（＝挿入順）でオリジンに Origin1/Origin2/Origin3 と
 * 番号を振り、OAC の論理 ID はその番号から作られる。実測で /api/* を先に書くと
 * メディア用 OAC の論理 ID が SiteDistributionOrigin2S3OriginAccessControlE0FE6FAA から
 * SiteDistributionOrigin3S3OriginAccessControl4BE73D82 に変わり、デプロイ時に
 * **OAC の置換とバケットポリシーの書き換え**が起きる。機能は変わらないが差分が出る。
 * test/distribution-oac.test.ts が論理 ID 集合を固定している。
 */
export const API_PATH_PATTERN = '/api/*';

/**
 * Astro がビルドした資産（CSS / JS）に振り分けるパス。**サイト側で唯一 immutable を返す。**
 *
 * `_astro` は Astro の `build.assets` の既定値で、`site/astro.config.mjs` はそれを上書きして
 * いない。長く持たせられる根拠（vite が名前に内容ハッシュを入れる）と、その前提を固定して
 * いるテストは `ASTRO_ASSETS_CACHE_CONTROL` の JSDoc にまとめてある。
 *
 * **admin はここに入らない。** `admin/vite.config.ts` が `base: '/admin/'` を宣言するので
 * 出力は `/admin/assets/*`（実測 391 ファイル）で、このパターンには一致しない。admin の資産は
 * デフォルトビヘイビア経由の `no-cache` のままで、それは意図した判断である（`mediaResponseHeaders`
 * の上のコメント）。
 *
 * # **`additionalBehaviors` の末尾に置くこと**
 *
 * 理由は既存 2 要素（`/media/*` -> `/api/*`）の位置を動かさないため。実測:
 *
 * | 実装 | Origins | OAC | OAC の論理 ID |
 * | --- | --- | --- | --- |
 * | `siteOrigin` を再利用・**末尾**に追加（これ） | 3 | 3 | 3 本とも 1 文字も変わらない |
 * | `siteOrigin` を再利用・先頭に追加 | 3 | 3 | 同じく不変。ただし `CacheBehaviors` 配列の並びが動く |
 * | `withOriginAccessControl` をもう 1 回呼ぶ | **4** | **4** | `SiteDistributionOrigin4S3OriginAccessControl505731E1` が増える |
 *
 * 3 行目は配信用バケットに 2 本目の OAC が生えた状態で、`test/distribution-oac.test.ts` の
 * 論理 ID 集合が落とす（機構は `siteOrigin` の宣言のコメント）。**ビヘイビアは 1 本増えるが
 * オリジンは増えない**という形を保つこと。
 *
 * # 懸念していた故障モードは起きない: 存在しない `/_astro/*` の 404 は `no-cache`
 *
 * `CustomErrorResponses` はディストリビューション全体に効く（ビヘイビア単位ではない）ので、
 * 消えたファイル名への要求にも `/404.html` の中身が返る。**そこで `immutable` が付くと、
 * `aws s3 sync --delete` と invalidation の間に古い HTML を受け取った閲覧者が、消えた旧 CSS の
 * URL を最大 1 年ぶん「無い」と覚えうる** — 当初はそれを新しい故障モードとして書いていた。
 * **デプロイ後に測った結果、そうはならない。**
 *
 * 実測（2026-10-03、デプロイ後の本番）:
 *
 * ```sh
 * curl -sI https://blog.shutx.net/_astro/does-not-exist.css
 * # => HTTP/2 404 / content-type: text/html / cache-control: no-cache
 * curl -sI https://blog.shutx.net/media/   # 対照: /media/* に一致するが鍵が無い
 * # => HTTP/2 404 / content-type: text/html / cache-control: no-cache
 * ```
 *
 * 理由は `/404.html` の出所である。**CloudFront はエラーページの差し替えに、要求が一致した
 * ビヘイビアのポリシーではなくデフォルトビヘイビアの ResponseHeadersPolicy を当てる。**
 * `/404.html` は `MEDIA_PATH_PATTERN` にもこのパターンにも一致しない（上のコメント）ので
 * デフォルトビヘイビア＝配信用バケットから返り、ヘッダもそちらの `SITE_CACHE_CONTROL`
 * （`no-cache`）に従う。`ErrorCachingMinTTL` の 10 秒はエッジのキャッシュ期間であって
 * 閲覧者に渡るヘッダではないが、**閲覧者に渡る値がそもそも `no-cache` なので救いは要らない。**
 *
 * したがって残るのは `/media/*` が今日すでに持っている性質と同じもので、1 パス増えただけ —
 * 存在しない資産には HTML の 404 が返り、その 1 回の表示が素のままになる。HTML は `no-cache`
 * なので次のナビゲーションで検証が走り、新しいファイル名を取りに行って自然に治る。
 *
 * **これはテンプレートからは読み取れない**（`CustomErrorResponses` にヘッダの話は書かれて
 * いない）ので、固定しているのはテストではなく上の 1 回の観測だけである。CloudFront が
 * この当て方を変えれば黙って元の懸念に戻るので、**ヘッダの付き方を触る変更を入れるときは
 * 同じ `curl` を打ち直すこと。** 同じ内容は `infra/README.md` の
 * 「`/_astro/*` は immutable、`/admin/assets/*` は no-cache」にも書いてある。
 */
export const ASTRO_ASSETS_PATH_PATTERN = '/_astro/*';

/**
 * CloudFront が自分で配る配信ドメイン。**カスタムドメインを足しても消さないこと。**
 *
 * 許可リストに残すのは退路のため。Cloudflare の CNAME を触って壊しても、ACM の証明書が
 * 切れても、**ここから `/admin/` に入って記事を直せる。** admin は
 * `resolveRedirectUri(location.origin)`（admin/src/main.ts）でオリジンを導出するので、
 * Cognito の許可リストに載っているオリジンならどれでもそのままログインが通る。
 */
export const CLOUDFRONT_ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';

/**
 * カスタムドメイン。**DNS は Cloudflare、証明書は us-east-1 の ACM**（どちらも帯域外）。
 *
 * **ここに書いただけでは配信は切り替わらない。** ディストリビューションの `domainNames`
 * （= `Aliases`）に入れるまで、`https://blog.shutx.net` は SNI 不一致で TLS ハンドシェイクに
 * 失敗する。この定数の役目は、**証明書が付く前に Cognito の許可リストとメディアの CORS を
 * 広げておくこと**だけである。
 */
export const CUSTOM_DOMAIN_NAME = 'blog.shutx.net';

/** `CUSTOM_DOMAIN_NAME` のオリジン表記。`https://` を 2 箇所に書き足さないため。 */
export const CUSTOM_ORIGIN = `https://${CUSTOM_DOMAIN_NAME}`;

/**
 * **証明書を置けるリージョンの全体集合。1 要素しかない。**
 *
 * 型注釈を別名に逃がしてあるのは oxlint のため。`: 'us-east-1' = 'us-east-1'` と直に書くと
 * `typescript(prefer-as-const)` が「`as const` にしろ」と言い、`npm run lint` は
 * `--deny-warnings` なので exit 1 になる（実測）。**だが `as const` では守れない** —
 * あれは初期化子から型を推論するので、**値を別リージョンに書き換えると型も一緒に動いて
 * 素通りする。** 下の注釈だけが「値を書き換えたら typecheck が落ちる」を成立させている。
 */
type SiteCertificateRegion = 'us-east-1';

/**
 * ACM 証明書のリージョン。**CloudFront は us-east-1 の証明書しか読まない**（デプロイ先が
 * ap-northeast-1 であることとは無関係の、CloudFront 側の制約）。
 *
 * **型で固定してある**（上の `SiteCertificateRegion`）。他のリージョンを書くと typecheck で
 * 落ちる。間違っていても `cdk synth` は通り、`cdk deploy` が `InvalidViewerCertificate` という
 * 原因の書かれていないエラーで落ちるだけなので、型とテストの 2 段で手前に寄せる。
 *
 * **CDK 自身の検査には頼れない。** `Distribution` の構築子は
 * `splitArn(certificateArn).region !== 'us-east-1'` を見るが、その前に
 * `Token.isUnresolved(region)` で抜ける（実測、aws-cdk-lib 2.267.0）。下で ARN を
 * `formatArn` に組ませると partition と account がトークンになり ARN 全体がトークンに
 * なるので、**あの検査は常に沈黙する。** 代わりに
 * `test/distribution-custom-domain.test.ts` がテンプレート上の ARN を見ている。
 */
export const SITE_CERTIFICATE_REGION: SiteCertificateRegion = 'us-east-1';

/**
 * ACM 証明書の UUID（ARN の `.../certificate/<ここ>`）。**ARN を丸ごと書かない。**
 *
 * ARN にはアカウント ID が入り、**このリポジトリは public である。** 同じ規律が既に
 * 3 箇所に明文で書かれている — `.github/workflows/deploy.yml` が role ARN を variable に
 * 逃がす理由、`ADMIN_LOGIN_DOMAIN_PREFIX` の JSDoc、`infra/README.md` の
 * 「アカウント ID をマスクして貼る」。だから ARN は `Stack.formatArn` が
 * `AWS::Partition` / `AWS::AccountId` から組み立て、**コードに載るのはこの UUID と
 * `'us-east-1'` だけ**にする。フル ARN の定数 1 本に替えたいなら 1 行で済むが、
 * そのときはアカウント ID が public に載ることを承知の上で行うこと。
 *
 * **証明書は帯域外で手で作る。** `new acm.Certificate` も `DnsValidatedCertificate` も
 * このスタックには置かない。理由は 2 つ。
 *
 * 1. **このスタックは env-agnostic** である（`bin/blog.ts` は env を渡さず、
 *    `test/site-stack.test.ts` がそれを固定している）。構築子で作るとデプロイ先の
 *    ap-northeast-1 に出来てしまい、**CloudFront から読めない証明書が生える。**
 * 2. 検証用の CNAME は Cloudflare に手で入れる。スタック内に置くと `cdk deploy` が
 *    `ISSUED` になるまで待ち続けるだけで、待ち時間を CFN に肩代わりさせる意味がない。
 *
 * 再発行したときに直すのはこの 1 行だけ（`aws acm describe-certificate` の ARN 末尾）。
 */
export const SITE_CERTIFICATE_ID = '943c0a33-26c2-4fa9-910c-3c50e4b7d204';

/**
 * 正（canonical）のオリジン。**この定数自身はテンプレートに 1 文字も現れない。**
 *
 * 描画されるのは下の `SITE_ORIGINS` のほうで、こちらは「正はどれか」という宣言である。
 * **実体は `.github/workflows/deploy.yml` の build ステップの `SITE_URL`** で、canonical link も
 * sitemap も RSS の `<guid isPermaLink="true">` もそこから生える。ここはその鏡にすぎず、
 * 定数として存在する理由は **`test/site-origins.test.ts` が deploy.yml を実際に parse して
 * 両者の一致を固定するため**（片方だけ差し替えた半端な状態を禁じる唯一のアサーション）。
 *
 * **許可リストと違って「両方」にはできない。** Astro の `site:` は 1 値で、guid が変われば
 * 購読者に全記事が再配信される（取り消せない。AGENTS.md）。だからここを動かすのは
 * 不可逆な決定であり、許可リストを 1 本広げるのとは別の作業になる。
 *
 * **正は `blog.shutx.net`（`CUSTOM_ORIGIN`）。** `*.cloudfront.net` は下の `SITE_ORIGINS` に
 * 残してあるので、**admin はどちらのホストからでもログインできる** — DNS や証明書を壊しても
 * 既定ドメインから `/admin/` に入って記事を直せる（`CLOUDFRONT_ORIGIN` の JSDoc の「退路」）。
 * **サイトの出力が名乗るのはこの 1 本だけ**で、canonical link も sitemap も RSS の guid も
 * `blog.shutx.net` を指す。
 *
 * **`CLOUDFRONT_ORIGIN` に戻しても切り戻しにはならない。** 定数と `SITE_URL` を戻せば次の
 * ビルドの出力は元の形に戻るが、**一度配信されたフィードは戻らない。** 戻すと全記事が
 * もう一度「新着」として配られるだけで、損害が 2 倍になる。
 */
export const SITE_ORIGIN = CUSTOM_ORIGIN;

/**
 * 配信オリジンの許可リスト。**Cognito の `CallbackURLs` / `LogoutURLs` とメディアバケットの
 * CORS `AllowedOrigins` が、どちらもこの 1 つの配列を参照する。**
 *
 * 2 か所に別々の文字列を書くと「ログインはできるが画像が上がらない」というデバッグしにくい
 * 壊れ方をする。`test/site-origins.test.ts` が**テンプレート上でこの 2 つの集合の一致**を
 * 見ている（1 定数が担っていた役目をテストに移したもの）。
 *
 * 「物理名をハードコードしない」方針の**意図的な例外**。理由は 2 つ。
 *
 * 1. **`distribution.distributionDomainName` は原理的に使えない。** メディアバケットの CORS
 *    （`CorsConfiguration` は `AWS::S3::Bucket` 本体のプロパティ）に入れると、
 *      Media.Properties.CorsConfiguration...AllowedOrigins = Fn::GetAtt [Dist, DomainName]
 *      Dist.Properties...Origins[0].DomainName            = Fn::GetAtt [Media, RegionalDomainName]
 *    という循環参照になる。**`cdk synth` はこれを検出せず成功し**、cfn-lint の E3004 だけが
 *    捕まえる（実測で 2 件）。バケットポリシー（別リソース）が Distribution を参照するのは
 *    問題ないが、CorsConfiguration には逃げ道が無い。
 * 2. Cognito の `CallbackURLs` でも同じ値が必要で、どのみち synth 時に確定した文字列が要る。
 *
 * **移行は 2 段で、可逆なのは前半だけ。**
 *
 * - **この配列に 1 本足す。** 両方のオリジンが同時に有効になるだけなので、外して
 *   deploy し直せば戻る。**可逆。**
 * - **`SITE_ORIGIN` と deploy.yml の `SITE_URL` を同時に差し替える。** RSS の guid が変わるので
 *   **不可逆**（上の `SITE_ORIGIN` のコメント）。
 *
 * **順序を入れ替えないこと。** 機能は変わらないが、テンプレートには配列として描画されるので
 * 並べ替えただけで `cdk diff` に差分が出る（CORS と Cognito の 2 リソースが更新される）。
 * **先頭は正のオリジンではない。** ここは追加順のままで、`SITE_ORIGIN` が `CUSTOM_ORIGIN` に
 * 移ったあとも `CLOUDFRONT_ORIGIN` が先頭に残っている。「正を先頭に」と並べ替えたくなるが、
 * 得られるのは `describe-user-pool-client` を目で見たときの見た目だけで、代わりに意味の無い
 * 差分と deploy が 1 回要る。`test/site-origins.test.ts` が期待値をリテラルの順序付き配列で
 * 固定しているので、並べ替えるとそこが落ちる。
 *
 * 配信ドメインが変わったときは `describe-stacks` の Output `DistributionDomainName` と
 * 突き合わせること（手順は infra/README.md）。
 */
export const SITE_ORIGINS: readonly string[] = [CLOUDFRONT_ORIGIN, CUSTOM_ORIGIN];

/**
 * Managed Login のドメイン接頭辞。**AWS グローバルで一意でなければならない。**
 *
 * CDK に自動生成させられないので、これも「物理名をハードコードしない」方針の
 * 意図的な例外になる。秘密ではないし、他アカウントに取られていれば `cdk deploy` が
 * 明示的なエラーで落ちるだけなので静かには壊れない。
 *
 * **アカウント ID を混ぜて一意性を上げる案は採らない** — hosted UI の URL は
 * 利用者のブラウザに表示されるので、そこに AWS アカウント ID を載せたくない。
 */
export const ADMIN_LOGIN_DOMAIN_PREFIX = 'shutx-blog-admin';

/**
 * 投稿を許可する唯一の Cognito ユーザ名。
 *
 * **`@` を含めないこと。** メールアドレスを入れても、`usernameAttributes` を設定して
 * いないこのプールでは `cognito:username` に一致しない。public リポジトリに個人の
 * メールアドレスを書かないという方針とも合う（AGENTS.md）。
 *
 * ユーザの作成は帯域外（`aws cognito-idp admin-create-user`）。CDK は作らない。
 */
export const ADMIN_USERNAME = 'shutx';

/**
 * GitHub App の client ID。JWT の `iss` に入る（GitHub は app ID よりこちらを推奨）。
 *
 * **秘密ではない。** GitHub は app ID / client ID を公開識別子として扱う。秘密は秘密鍵だけで、
 * それは Secrets Manager にある（CDK は空のシークレットを作るだけで値を持たない。
 * DEVELOPERS.md の手順で運用者が CLI から入れる）。
 *
 * ここが間違っていると GitHub は App JWT を 401 で拒否する。症状は「鍵は読めているのに GitHub
 * 呼び出しだけ失敗する」で鍵の問題と紛らわしい（`/api/health/github-app` は鍵の有無しか見ない）。
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23liVPDAakRE2AKX45';

/**
 * `StackProps` に**テスト専用の seam を 1 つだけ**足したもの。
 *
 * `apiBundleDir` は `lambda-bundle-freshness.test.ts` が使う。あのテストは成果物をわざと壊すので、
 * 本物の `api/dist` を壊すと同時に走る他のテストが巻き添えになる。
 * **既定は `api/dist` のままで、本番の挙動は変わらない。**
 */
export interface SiteStackProps extends StackProps {
  /** 既定は `API_BUNDLE_DIR`。テスト以外で渡さないこと。 */
  apiBundleDir?: string;
}

/**
 * 静的サイト配信スタック。
 *
 * env は意図的に指定しない（env-agnostic）。AWS 認証情報を一切必要とせず cdk synth が
 * 通ることを要件にしているため。
 */
export class SiteStack extends Stack {
  /** `aws s3 sync` の宛先。CicdStack がデプロイロールの権限をここに絞る。 */
  readonly siteBucket: s3.Bucket;

  /** 記事の画像。CI からは一切触らせない（設計判断5）。 */
  readonly mediaBucket: s3.Bucket;

  /** CicdStack がキャッシュ無効化の権限をここに絞る。 */
  readonly distribution: cloudfront.Distribution;

  /** 管理画面のログイン（単一著者の Cognito ユーザプール）。 */
  readonly adminAuth: AdminAuth;

  constructor(scope: Construct, id: string, props?: SiteStackProps) {
    super(scope, id, props);

    // 配信対象は CloudFront の OAC 経由でのみ読ませる。バケット自体は完全に非公開。
    // bucketName は指定しない（物理名をハードコードしない）。実名は CfnOutput で出す。
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.siteBucket = siteBucket;

    // メディアは配信用と別バケットにする。同居させると sync --delete が巻き込んで消す。
    // 別 Stack ではなく Construct なのは、別 Stack だと synth が DependencyCycle で落ちるため
    // （media-bucket.ts のコメントと README を参照）。
    // **siteOrigins に distribution.distributionDomainName を渡してはいけない** — 循環参照になる
    // （SITE_ORIGINS の定義のコメントを参照）。
    const media = new MediaBucket(this, 'MediaBucket', { siteOrigins: SITE_ORIGINS });
    this.mediaBucket = media.bucket;

    // 管理画面のログイン（単一著者の Cognito ユーザプール）。Stack ではなく Construct
    // （CloudFront に紐づくものを別 Stack にすると DependencyCycle になる、という実測に揃える）。
    const adminAuth = new AdminAuth(this, 'AdminAuth', {
      domainPrefix: ADMIN_LOGIN_DOMAIN_PREFIX,
      siteOrigins: SITE_ORIGINS,
    });
    this.adminAuth = adminAuth;

    // 投稿 API。Stack ではなく Construct（理由は README と posting-api.ts のコメント）。
    // Distribution が functionUrl を参照するのでここで先に作る。
    const postingApi = new PostingApi(this, 'PostingApi', {
      bundleDir: props?.apiBundleDir,
      mediaBucket: this.mediaBucket,
      // 型が判別可能ユニオンなので、userPool / userPoolClient / allowedUsername を揃えずに
      // mode: 'cognito' にすることはできない。
      //
      // **切り戻しは `{ mode: 'deny-all' }` に戻して deploy し直すだけ。** Cognito のリソースは
      // 消えない（deletionProtection + RemovalPolicy.RETAIN）し、api 側の deny-all は COGNITO_* を
      // 1 つも読まないので、**壊れた Cognito 設定を抱えたまま安全側に倒せる。**
      auth: {
        mode: 'cognito',
        userPool: adminAuth.userPool,
        userPoolClient: adminAuth.userPoolClient,
        allowedUsername: ADMIN_USERNAME,
      },
      githubOwner: 'shutx-net',
      // **記事は private な blog-content、ワークフローは public な blog。** この 2 つが別で
      // あることが分離の実体で、Lambda は記事リポジトリにしか contents:write を持たない
      // （code repo には actions:write だけ）。
      githubContentRepo: 'blog-content',
      githubCodeRepo: 'blog',
      postsPathPrefix: CONTENT_POSTS_PATH_PREFIX,
      // **記事が別リポジトリに移ったので push ではデプロイが走らない。** dispatch が唯一の
      // 起動経路である。
      deployWorkflowFile: 'deploy.yml',
      // GitHub App の client ID。**秘密ではない**ので public リポジトリに置いてよい。
      // 秘密は秘密鍵のほうだけで、そちらは Secrets Manager にあり CDK は値を持たない。
      githubAppClientId: GITHUB_APP_CLIENT_ID,
    });

    // セキュリティヘッダ。サイトと admin で 1 つのポリシーを共有する（admin はデフォルト
    // ビヘイビアで配信されるので `/admin/*` 専用のビヘイビアは要らない。新設すると
    // distribution-behavior.test.ts と distribution-media-behavior.test.ts のビヘイビア件数・
    // 順序のアサーションを書き換えることになる）。
    //
    // **ホストは construct から導出する。** 物理名を書くと、片方だけ変わったときに
    // 「ログインだけ動かない」「画像だけ上がらない」という最も分かりにくい壊れ方をする。
    //
    // ポリシーが 3 本あるのは Cache-Control の値がパスごとに違うから。サイトは毎回検証させ
    // （`no-cache`）、メディアと `/_astro/*` は 1 年持たせる（`immutable`）。後者 2 本は**値が
    // 同じでも根拠が別**なので定数も別にしてある（`response-headers.ts` の JSDoc）。
    // **セキュリティヘッダのほうは 3 本で同一でなければならない**ので、ローカル変数に
    // 括り出して値の出所を 1 つにしておく。3 箇所に書くと CSP に connect-src を足した日に
    // どれかだけ古くなる。distribution-response-headers.test.ts が 3 本の一致を固定している。
    const securityHeadersBehavior: cloudfront.ResponseSecurityHeadersBehavior = {
      contentSecurityPolicy: {
        contentSecurityPolicy: buildCsp({
          cognitoOrigin: adminAuth.domain.baseUrl(),
          mediaOrigin: `https://${this.mediaBucket.bucketRegionalDomainName}`,
        }),
        override: true,
      },
      contentTypeOptions: { override: true },
      referrerPolicy: {
        referrerPolicy: REFERRER_POLICY as cloudfront.HeadersReferrerPolicy,
        override: true,
      },
      // frame-ancestors の二重化。古いブラウザ向け。
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      // **カスタムドメインが付いて、HSTS が初めて実利を持つ。** 手で打たれたり
      // リンクされたりするのは `blog.shutx.net` のほうで、スキームを省いた最初の 1 本は
      // 平文で出て 301 を踏む。HSTS があれば 2 回目以降はブラウザが送る前に https へ上げる
      // （AWS が配る配信ドメインを手で打つ人は居ないので、そこでは実質何も守っていなかった）。
      //
      // **それでも includeSubdomains も preload も付けない**（理由 3 つは
      // `HSTS_MAX_AGE_SECONDS` の JSDoc）。要点だけ: `blog.shutx.net` の下にホストが無いので
      // includeSubDomains には守る対象が無く、将来そこに平文のホストを置いた日に
      // max-age の残りだけ到達不能にする。親の `shutx.net` はこのスタックの管理外。
      strictTransportSecurity: {
        accessControlMaxAge: Duration.seconds(HSTS_MAX_AGE_SECONDS),
        includeSubdomains: false,
        preload: false,
        override: true,
      },
    };

    // サイト（HTML / RSS / sitemap / admin）用。**論理 ID は 'SecurityHeaders' のまま。**
    // 変えると CloudFormation は「削除して作り直す」と解釈し、ビヘイビアの差し替えと削除の順序で
    // 失敗しうる。名前も `${stackName}-security-headers` のままにする。
    //
    // override: true は、今日はオリジン（S3）が Cache-Control を返さないので false でも同じだが、
    // **将来 s3 sync に --cache-control が入った日にどちらが勝つか**を今ここで決めておくため。
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${Stack.of(this).stackName}-security-headers`,
      comment: 'CSP ほか + Cache-Control: no-cache（ブラウザに毎回検証させる）',
      securityHeadersBehavior,
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: SITE_CACHE_CONTROL, override: true },
        ],
      },
    });

    // メディア用。セキュリティヘッダは上と同一で、Cache-Control だけが違う。
    //
    // **`/admin/assets/*` は引き続きデフォルトビヘイビア経由の `no-cache` である。**
    // Vite のハッシュ付きファイル（実測 391 個、shiki の文法定義）なので中身は不変だが、
    // `admin/vite.config.ts` が `base: '/admin/'` を宣言するので下の `/_astro/*` には
    // 一致しない。**それでよしとする** — 利用者は 1 人、遅延ロードで実際に読むのは数本、
    // CloudFront にキャッシュがあるので 304 が返り S3 には行かない。
    //
    // **伸ばしたくなったら専用ビヘイビアを足すこと。`aws s3 sync --cache-control` は使わない**
    // （以前このコメントはそちらを勧めていた。AGENTS.md が明文で禁じているものだった）。
    // sync の比較はサイズと更新時刻だけで**メタデータを見ない**ので、内容が変わっていない
    // オブジェクトは古いヘッダのまま取り残される。加えて Cache-Control の定義が S3 と CDK の
    // 2 箇所に分かれる（同じ理由が `SITE_CACHE_CONTROL` の JSDoc にも書いてある）。
    const mediaResponseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'MediaHeaders', {
      responseHeadersPolicyName: `${Stack.of(this).stackName}-media-headers`,
      comment: 'CSP ほか + Cache-Control: immutable（キーがランダムで上書きされない）',
      securityHeadersBehavior,
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: MEDIA_CACHE_CONTROL, override: true },
        ],
      },
    });

    // Astro の資産（`/_astro/*`）用。**3 本目。** セキュリティヘッダは上 2 本と同一で、
    // Cache-Control だけが違う。値はメディアと同じだが**真である条件が別**なので、定数も
    // 別にしてある（`ASTRO_ASSETS_CACHE_CONTROL` の JSDoc）。
    //
    // **論理 ID は 'AssetsHeaders' のまま。** 変えると CloudFormation は「削除して作り直す」と
    // 解釈し、ビヘイビアの差し替えと削除の順序で失敗しうる。名前も
    // `${stackName}-assets-headers` のままにする（実測で `BlogSiteStack-assets-headers`）。
    const assetsResponseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'AssetsHeaders', {
      responseHeadersPolicyName: `${Stack.of(this).stackName}-assets-headers`,
      comment: 'CSP ほか + Cache-Control: immutable（vite が内容ハッシュを付ける）',
      securityHeadersBehavior,
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: ASTRO_ASSETS_CACHE_CONTROL, override: true },
        ],
      },
    });

    // runtime を省略すると既定は JS_1_0。1.0 は const / let / endsWith を保証しないので
    // 必ず 2.0 を明示する。ここが消えるとテンプレートは通るのにデプロイ後に壊れる。
    const rewriteUriFunction = new cloudfront.Function(this, 'RewriteUriFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: REWRITE_URI_PATH }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'viewer-request: /about -> /about/index.html',
    });

    // カスタムドメインの証明書。**帯域外で発行済みのものを ARN で参照するだけ**なので、
    // `AWS::CertificateManager::Certificate` は 1 つも生えない（理由は
    // `SITE_CERTIFICATE_ID` の JSDoc）。
    //
    // **アカウント ID をコードに書かない**ため ARN は `formatArn` に組ませる。前例は下の
    // `AllowCloudFrontInvokeFunction` の `sourceArn`。代償として ARN がトークンになり、
    // CDK 自身の `DistributionCertificateMustBeInUsEast1` 検査が `Token.isUnresolved` で
    // 抜ける（`SITE_CERTIFICATE_REGION` の JSDoc）。us-east-1 はテストで固定する。
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'SiteCertificate',
      Stack.of(this).formatArn({
        service: 'acm',
        region: SITE_CERTIFICATE_REGION,
        resource: 'certificate',
        resourceName: SITE_CERTIFICATE_ID,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      }),
    );

    // withOriginAccessControl は OAC リソースの作成とバケットポリシーの更新を
    // まとめて行う。手で addToResourcePolicy すると文が重複するので書かない。
    // 既定の originAccessLevels は [READ] なので読み取り専用。
    //
    // **配信用バケットのオリジンはこの 1 インスタンスだけを作り、デフォルトと `/_astro/*` の
    // 2 つのビヘイビアで使い回す。呼び出しを 2 回に分けるとテンプレートが変わる。**
    //
    // `Distribution.addOrigin` は `boundOrigins.find(b => b.origin === origin)` と
    // **インスタンス同一性**で既存のオリジン ID を引き当てる（aws-cdk-lib 2.267.0 の実装）。
    // `withOriginAccessControl` は呼ぶたびに別のオブジェクトを返すので、同じバケットに対して
    // 2 回呼ぶと `Origin4` のスコープが生え、**2 本目のオリジンと 2 本目の OAC**（実測
    // `SiteDistributionOrigin4S3OriginAccessControl505731E1`）がデプロイされる。使い回すほうは
    // `S3BucketOriginWithOAC.bind` が `this.originAccessControl ||` で自分の OAC を再利用するので
    // 1 本に留まる。`test/distribution-oac.test.ts` が OAC の論理 ID 集合をリテラルで固定して
    // いるので、2 回呼ぶ実装はそこで落ちる。
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      // defaultRootObject はルート '/' にしか効かない。/about は Function 側が担当する。
      defaultRootObject: 'index.html',
      // **HTTP/3（QUIC）も受ける。** 下の `minimumProtocolVersion` と同じ「既定に任せない」の線
      // だが、性格が 1 つ違う — あちらは既定と**同値**を書き写した保険で、こちらは既定
      // （`http2`）と**違う値**なので行そのものが機能を担っている。そして消えたときの見え方が
      // 悪い: aws-cdk-lib 2.267.0 の実装は `this.httpVersion = props.httpVersion ?? HttpVersion.HTTP2`
      // なので、**この行を消してもテンプレートから `HttpVersion` が消えるのではなく `"http2"` が
      // 描画される。** 欠けたようには見えないまま HTTP/3 だけが無効に戻るので、
      // `test/distribution-behavior.test.ts` がテンプレート上の値を `'http2and3'` で
      // リテラル固定している。
      //
      // 描画先は `DistributionConfig.HttpVersion` の 1 行だけで、**ビヘイビアもオリジンも OAC も
      // 1 文字も動かない**（実測。`cdk diff` は Distribution の in-place 更新 1 件、置換は無い）。
      // 効くのは**ビューアとの接続だけ**で、CloudFront からオリジンへの接続には関係しない。
      //
      // 得るもの: QUIC は TCP の 3-way と TLS の握手を畳んで 2 RTT を 1 RTT にする。実測
      // （2026-10-03、国内から本番）の握手は connect 34 ms / tls 56 ms なので、**取れるのは
      // 握手 1 往復ぶんだけ**で転送そのものは速くならない。`HTTP3` 単独ではなく `HTTP2_AND_3`
      // なので退路は常にある — CloudFront の HTTP/3 は TLS1.3 と SNI を話せるビューアにだけ
      // 使われ、話せないビューアや UDP/443 が塞がれている経路は h2 のまま通る。
      //
      // 効いたかどうかの見方: 有効なら応答に `alt-svc: h3=":443"; ma=86400` が付く。
      // **有効化前の `blog.shutx.net` には無かった**ことを実測済み（2026-10-03）。正の対照は
      // h3 が有効な CloudFront である `d1.awsstatic.com` で、あちらはこのヘッダを返す。
      //
      // **反対側の実測（見込みが崩れたら判断を見直すこと）。** PSI mobile のスコアを作る
      // Lighthouse の Lantern は **h3 をモデル化していない** — `ConnectionPool.js:46` が
      // `request.protocol === 'h2'` とリテラル比較しており、`'h3'` は非多重化（1 オリジン
      // 6 本の HTTP/1.1 相当）として扱われる。同じ `TCPConnection` を rtt 150 ms / 1.6 Mbps で
      // 走らせた実測では、同一オリジン 2 本目の CSS 1846 B は h2 なら **0 ms**、h2 扱いされないと
      // **150 ms**。**PSI が h3 を記録したら、シミュレートされる FCP / LCP が 150 ms 悪化しうる。**
      //
      // そうならないと見込んだ根拠は 2 つあった。**うち 1 つは有効化後に崩れた。**
      // (a) PSI は毎回クリーンプロファイルなので `alt-svc` のキャッシュを持たない — これは今も有効。
      // (b) CloudFront の DNS HTTPS(SVCB) RR が h3 を広告していない — **これは崩れた。**
      //
      // RR は `d8gsxbwzr6ft8.cloudfront.net` に付いていて **TTL 60 秒**で、有効化の前後で
      // こう動いた（実測）:
      //
      //   有効化前（2026-10-03 22:49）        1 . alpn="h2"
      //   デプロイ直後（23:35）                1 . alpn="h2"      <- まだ切り替わっていない
      //   約 25 分後（翌 00:0x）               1 . alpn="h2,h3"   <- system / 1.1.1.1 / 8.8.8.8 で一致
      //
      // **Chrome は HTTPS(SVCB) の `alpn` を見て初回接続から QUIC を試すので、PSI が h3 を
      // 記録しうる状態になった = 上の 150 ms の下振れは仮定ではなく現実の可能性である。**
      // （RR を書き換える AWS 側の規則は観測できていない。値の変化だけを測った。）
      //
      // **したがって次にやることは PSI の FCP / LCP の実測である。** 悪化していたら
      // `HTTP2` に戻す — 直すのはこの行、`test/distribution-behavior.test.ts` の
      // `'http2and3'` のリテラル、README の「HTTP/3 を有効にする」の 3 箇所。
      // 悪化していなければ、Lantern の挙動がこのサイトの構成（リクエスト 2 本・
      // 合計 2582 B で初期輻輳ウィンドウに収まる）では効いていないということなので、
      // その実測値を README に足して判断を確定させる。
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // **この 3 つは `DistributionConfig` 直下の `Aliases` と `ViewerCertificate` にしか
      // 描画されない。** `renderOrigins()` も `additionalBehaviors` も通らないので、
      // **OAC の論理 ID 集合（上の `API_PATH_PATTERN` のコメント）もビヘイビア件数 3 も不変**
      // であり、`cdk diff` は Distribution の in-place 更新 1 件だけになる（実測）。
      //
      // **`*.cloudfront.net` は alias ではないので消えない。** 退路として残す
      // （`CLOUDFRONT_ORIGIN` のコメント）。alias のほうは CloudFront グローバルで一意で、
      // 他人が押さえていれば deploy が `CNAMEAlreadyExists` で落ちる — 静かには壊れない。
      domainNames: [CUSTOM_DOMAIN_NAME],
      certificate,
      // cdk.json の `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021` で既定も
      // 同値になるが **明示する** — あのフラグを外した日に黙って TLSv1.2_2019 へ落ちる。
      // **既定の `*.cloudfront.net` 証明書のままだと `ViewerCertificate` ごと描画されない**
      // ので、この指定が効くのは証明書を付ける今日から（それまで README の TODO に
      // 「TLS 最低バージョンを上げられない」として残っていた。経緯は README の
      // 「カスタムドメイン blog.shutx.net」の「付随して閉じた宿題」）。
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // `sslSupportMethod` は書かない。既定が `sni-only` で、`vip`（専用 IP）は
      // 月 600 USD 付く。SNI を話せないクライアントは相手にしない。
      defaultBehavior: {
        // **`/_astro/*` と同じインスタンスであること**（上の `siteOrigin` の宣言）。
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // **admin もここから配信される**（/admin/* 専用のビヘイビアは無い）。
        responseHeadersPolicy: responseHeaders,
        functionAssociations: [
          {
            function: rewriteUriFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // メディアは 2 本目の OAC オリジンから返す。
      //
      // functionAssociations は付けない。URI 書き換え Function は拡張子の無いパスに /index.html を
      // 足すので、メディアのキーに適用してはいけない。
      //
      // originAccessLevels も指定しない（既定 [READ] でバケットポリシーは s3:GetObject だけ）。
      // **LIST を足してはいけない** — CDK が
      // '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk' の警告を出すうえ、メディアの一覧が
      // CloudFront 経由で晒される。書き込みは presigned PUT で S3 に直接行くので読み取りだけでよい。
      //
      // cachePolicy も既定（CACHING_OPTIMIZED）のまま。メディアは不変な静的ファイル。
      additionalBehaviors: {
        [MEDIA_PATH_PATTERN]: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // **メディアにも付ける。** SVG は許可していない（api の ALLOWED_CONTENT_TYPES に
          // image/svg+xml は無い）が、入口の制限と二重化しておく。サイトとは別のポリシーで、
          // 違うのは Cache-Control だけ（1 年 + immutable）。
          responseHeadersPolicy: mediaResponseHeaders,
        },
        // 投稿 API。**/media/* より後に書く**（上の API_PATH_PATTERN のコメント）。
        [API_PATH_PATTERN]: {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(postingApi.functionUrl),
          // **https-only。redirect-to-https ではない。**
          // リダイレクトされると POST のボディが失われる。API へのプレーン HTTP は
          // 曖昧に転送せず拒否する。
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          // 既定は GET/HEAD だけ。指定を忘れると POST が 405 になる。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // API の応答をキャッシュさせない。Lambda 側も Cache-Control: no-store を返す
          // （二重化。ポリシー ID を取り違えても API 側で守られる）。
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // **Host を転送してはいけない。** 転送すると OAC の SigV4 署名が
          // Lambda URL のホストと一致せず必ず失敗する。
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // functionAssociations は付けない。URI 書き換え Function は拡張子の無いパスに
          // /index.html を足すので、/api/posts が /api/posts/index.html になってしまう。
        },
        // Astro の資産。**末尾に置く**（上の ASTRO_ASSETS_PATH_PATTERN のコメント）。
        //
        // origin は**デフォルトと同じ `siteOrigin` インスタンス**。同じバケットなので
        // オリジンは増えず、ビヘイビアだけが 1 本増える（Origins 3 / OAC 3 のまま）。
        //
        // functionAssociations は付けない。`rewrite-uri.js` は最終セグメントにドットがある URI を
        // 素通しするので `/_astro/Layout.<hash>.css` に対しては何もしないが、
        // distribution-behavior.test.ts が「デフォルト以外に Function が付いていない」を
        // 全ビヘイビア走査で固定している。
        //
        // cachePolicy も allowedMethods も指定しない（既定の Managed-CachingOptimized と
        // GET/HEAD のまま）。**エッジの TTL を 1 年にする独自キャッシュポリシーは作らない** —
        // 閲覧者に届く Cache-Control を決めるのは下の responseHeadersPolicy のほうで、
        // 違いは POP ごとに 1 日 1 回 S3 まで検証に行くかどうかだけ。閲覧者から見える差は無い。
        [ASTRO_ASSETS_PATH_PATTERN]: {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: assetsResponseHeaders,
        },
      },
      // **403 も入れるのが本質。** OAC + S3 REST オリジンではバケットポリシーに s3:ListBucket が
      // 無く、S3 が「存在しない」と「権限が無い」を区別しないため、存在しないキーは 404 ではなく
      // 403 (AccessDenied) で返る。404 だけマップしても閲覧者には 403 が見えたままになる。
      //
      // ttl は既定と同じ 10 秒だが、明示するとテンプレートに ErrorCachingMinTTL が描画されて
      // テストで固定できる。デプロイ直後に一時的に 404 になったオブジェクトを長時間キャッシュ
      // されると困るので、短い値であること自体に意味がある。
      //
      // CustomErrorResponses はディストリビューション全体に効く（ビヘイビア単位ではない）。
      // 存在しない /media/* の画像には HTML の 404 ページが返るが、壊れた画像に見えるだけ。
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.seconds(10),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.seconds(10),
        },
      ],
    });

    this.distribution = distribution;

    // **CDK が作る permission だけでは CloudFront は Lambda を呼べない。**
    //
    // FunctionUrlOrigin.withOriginAccessControl が出すのは lambda:InvokeFunctionUrl の 1 文だけ
    // だが、CloudFront 開発者ガイド「Restrict access to an AWS Lambda function URL origin」は
    // add-permission を 2 回実行するよう指示している。lambda:InvokeFunction が無いと Function URL
    // の IAM 認可が 403 を返し、**関数が起動しないのでログも残らない。**
    //
    // 実測（2026-08-30, 初回デプロイ後）: POST /api/posts -> 404, server: AmazonS3、ロググループは
    // 空のまま。403 が CustomErrorResponses(403 -> /404.html) で 404 に化けるので、症状だけ見ると
    // 「ルーティングが効いていない」と誤読しやすい。
    //
    // AWS のブログ記事は InvokeFunctionUrl だけを示していて食い違うが、
    // **実環境の挙動は開発者ガイドのほうと一致する。**
    new lambda.CfnPermission(this, 'AllowCloudFrontInvokeFunction', {
      action: 'lambda:InvokeFunction',
      functionName: postingApi.handler.functionArn,
      principal: 'cloudfront.amazonaws.com',
      sourceArn: Stack.of(this).formatArn({
        service: 'cloudfront',
        region: '',
        resource: 'distribution',
        resourceName: distribution.distributionId,
      }),
    });

    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'aws s3 sync の宛先バケット',
    });

    new CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: '管理画面が presigned PUT で画像を上げる先のバケット',
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront の配信ドメイン',
    });

    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'キャッシュ無効化に使うディストリビューション ID',
    });
  }
}
