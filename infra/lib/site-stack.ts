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
    // ポリシーが 2 本あるのは Cache-Control の値がサイトとメディアで正反対だから（毎回検証させる /
    // 1 年持たせる）。**セキュリティヘッダのほうは同一でなければならない**ので、ローカル変数に
    // 括り出して値の出所を 1 つにしておく。2 箇所に書くと CSP に connect-src を足した日に
    // 片方だけ古くなる。
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
    // admin/dist/assets の Vite ハッシュ付きファイル（実測 391 個、shiki の文法定義）も
    // デフォルトビヘイビア経由なので no-cache になる。**それでよしとする** — 利用者は 1 人、
    // 遅延ロードで実際に読むのは数本、CloudFront にキャッシュがあるので 304 が返り S3 には行かない。
    // 必要になったら専用ビヘイビアを足すより、ハッシュ付き資産だけ s3 sync --cache-control で
    // 長い値を付けるほうが安い。
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
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      // defaultRootObject はルート '/' にしか効かない。/about は Function 側が担当する。
      defaultRootObject: 'index.html',
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
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
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
