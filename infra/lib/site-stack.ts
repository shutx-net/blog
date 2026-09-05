import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
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
import { HSTS_MAX_AGE_SECONDS, REFERRER_POLICY, buildCsp } from './response-headers.ts';

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
 * **サイトのオリジン（CloudFront の配信ドメイン）。**
 *
 * 「物理名をハードコードしない」方針の **意図的な例外**である。理由は 3 つ。
 *
 * 1. **`distribution.distributionDomainName` は原理的に使えない。**
 *    メディアバケットの CORS（`CorsConfiguration` は `AWS::S3::Bucket` **本体**の
 *    プロパティ）に入れると、
 *      Media.Properties.CorsConfiguration...AllowedOrigins = Fn::GetAtt [Dist, DomainName]
 *      Dist.Properties...Origins[0].DomainName            = Fn::GetAtt [Media, RegionalDomainName]
 *    という循環参照になる。**`cdk synth` はこれを検出せず成功してしまい**、
 *    cfn-lint の **E3004** だけが捕まえる（実測で 2 件）。バケットポリシー（別リソース）が
 *    Distribution を参照するのは問題ないが、CorsConfiguration には逃げ道が無い。
 * 2. Cognito の `CallbackURLs` でも同じ値が必要で、**どのみち synth 時に確定した
 *    文字列でなければならない。**
 * 3. カスタムドメインを入れるフェーズで、**この 1 定数を差し替えるだけで済む。**
 *
 * **CORS と Cognito の CallbackURLs の両方がこの 1 定数を参照する。** 2 か所に別々の
 * 文字列を書くと「ログインはできるが画像が上がらない」というデバッグしにくい壊れ方をする。
 *
 * **この定数を変えるのは CloudFront のドメインが変わったときだけ。**
 * デプロイ後に `describe-stacks` の Output `DistributionDomainName` と突き合わせること
 * （手順は infra/README.md）。
 */
export const SITE_ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';

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
 * GitHub App の client ID。JWT の `iss` に入る。
 *
 * **秘密ではない。** GitHub は app ID / client ID を公開識別子として扱う。
 * 秘密は秘密鍵だけで、それは Secrets Manager にある（CDK は空のシークレットを
 * 作るだけで値を持たない。DEVELOPERS.md の手順で運用者が CLI から入れる）。
 *
 * **GitHub は app ID より client ID を推奨している。**
 *
 * ここが間違っていると GitHub は App JWT を 401 で拒否する。症状は
 * 「鍵は読めているのに GitHub 呼び出しだけ失敗する」という形になり、
 * 鍵の問題と紛らわしい。`/api/health/github-app` は鍵の有無しか見ない。
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23liVPDAakRE2AKX45';

/**
 * 静的サイト配信スタック。
 *
 * env は意図的に指定しない（env-agnostic）。本フェーズは AWS 認証情報を
 * 一切必要とせず cdk synth が通ることを要件にしているため。
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

  constructor(scope: Construct, id: string, props?: StackProps) {
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
    // 別 Stack ではなく Construct なのは、別 Stack だと synth が DependencyCycle で
    // 落ちるため（media-bucket.ts のコメントと README を参照）。
    // **siteOrigin に distribution.distributionDomainName を渡してはいけない。**
    // CorsConfiguration は S3::Bucket 本体のプロパティなので循環参照になる
    // （SITE_ORIGIN の定義のコメントを参照）。
    const media = new MediaBucket(this, 'MediaBucket', { siteOrigin: SITE_ORIGIN });
    this.mediaBucket = media.bucket;

    // 管理画面のログイン（単一著者の Cognito ユーザプール）。
    // **Stack ではなく Construct**（CloudFront に紐づくものを別 Stack にすると
    // DependencyCycle になる、という Phase 2・3 の実測に揃える）。
    const adminAuth = new AdminAuth(this, 'AdminAuth', {
      domainPrefix: ADMIN_LOGIN_DOMAIN_PREFIX,
      siteOrigin: SITE_ORIGIN,
    });
    this.adminAuth = adminAuth;

    // 投稿 API。**Stack ではなく Construct にしている**（理由は README と
    // posting-api.ts のコメント）。Distribution が functionUrl を参照するので
    // ここで先に作る。
    const postingApi = new PostingApi(this, 'PostingApi', {
      mediaBucket: this.mediaBucket,
      // **Phase 4 でここが deny-all から cognito に変わった。**
      // 型が判別可能ユニオンなので、userPool / userPoolClient / allowedUsername を
      // 揃えずに mode: 'cognito' にすることは **できない**。
      //
      // **切り戻しは `{ mode: 'deny-all' }` に戻して deploy し直すだけ。**
      // Cognito のリソースは消えない（deletionProtection + RemovalPolicy.RETAIN）し、
      // api 側の deny-all は COGNITO_* を 1 つも読まないので、
      // **壊れた Cognito 設定を抱えたまま安全側に倒せる。**
      auth: {
        mode: 'cognito',
        userPool: adminAuth.userPool,
        userPoolClient: adminAuth.userPoolClient,
        allowedUsername: ADMIN_USERNAME,
      },
      githubOwner: 'shutx-net',
      // **記事は private な blog-content、ワークフローは public な blog。**
      // この 2 つが別であることが分離の実体で、Lambda は記事リポジトリにしか
      // contents:write を持たない（code repo には actions:write だけ）。
      githubContentRepo: 'blog-content',
      githubCodeRepo: 'blog',
      postsPathPrefix: CONTENT_POSTS_PATH_PREFIX,
      // **記事が別リポジトリに移ったので、push ではデプロイが走らなくなった。**
      // dispatch がデプロイの唯一の起動経路になる（Phase 2 では二重デプロイを
      // 避けるために意図的に未設定にしていた）。
      deployWorkflowFile: 'deploy.yml',
      // GitHub App の client ID。**秘密ではない**ので public リポジトリに置いてよい。
      // 秘密は秘密鍵のほうだけで、そちらは Secrets Manager にあり CDK は値を持たない。
      githubAppClientId: GITHUB_APP_CLIENT_ID,
    });

    // セキュリティヘッダ。**Phase 5 で新設**（実測で、それまでの実配信は
    // CSP / HSTS / nosniff を 1 つも返していなかった）。
    //
    // **サイトと admin で 1 つのポリシーを共有する。** admin はデフォルトビヘイビアで
    // 配信されているので、`/admin/*` 専用のビヘイビアを新設しなくてよい
    // （新設すると distribution-behavior.test.ts と distribution-media-behavior.test.ts の
    // ビヘイビア件数・順序のアサーションを書き換えることになる）。
    //
    // **ホストは construct から導出する。** 物理名を書くと、片方だけ変わったときに
    // 「ログインだけ動かない」「画像だけ上がらない」という最も分かりにくい壊れ方をする。
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${Stack.of(this).stackName}-security-headers`,
      comment: 'CSP ほか。admin のプレビューに実在する XSS 経路の緩和（Phase 5）',
      securityHeadersBehavior: {
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
        // **includeSubdomains も preload も付けない。**
        // *.cloudfront.net は他人と共有するドメインなので、サブドメイン全体に
        // HSTS を宣言するのは自分のものでないホストに対する宣言になる。
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(HSTS_MAX_AGE_SECONDS),
          includeSubdomains: false,
          preload: false,
          override: true,
        },
      },
    });

    // runtime を省略すると既定は JS_1_0。1.0 は const / let / endsWith を保証しないので
    // 必ず 2.0 を明示する。ここが消えるとテンプレートは通るのにデプロイ後に壊れる。
    const rewriteUriFunction = new cloudfront.Function(this, 'RewriteUriFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: REWRITE_URI_PATH }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'viewer-request: /about -> /about/index.html',
    });

    // withOriginAccessControl は OAC リソースの作成とバケットポリシーの更新を
    // まとめて行う。手で addToResourcePolicy すると文が重複するので書かない。
    // 既定の originAccessLevels は [READ] なので読み取り専用。
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      // defaultRootObject はルート '/' にしか効かない。/about は Function 側が担当する。
      defaultRootObject: 'index.html',
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
      // functionAssociations は付けない。URI 書き換え Function は拡張子の無いパスに
      // /index.html を足すので、メディアのキーに適用してはいけない。
      //
      // originAccessLevels も指定しない。既定は [READ] でバケットポリシーには
      // s3:GetObject だけが入る。**LIST を足してはいけない** — CDK が
      // '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk' の警告を出すうえ、
      // メディアの一覧が CloudFront 経由で晒される。書き込みは管理画面が presigned PUT で
      // S3 に直接行うので、CloudFront 側には読み取りだけあればよい。
      //
      // cachePolicy も既定（CACHING_OPTIMIZED）のままでよい。メディアは不変な静的ファイル。
      additionalBehaviors: {
        [MEDIA_PATH_PATTERN]: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // **メディアにも付ける。** SVG は許可していない（api の
          // ALLOWED_CONTENT_TYPES に image/svg+xml は無い）が、入口の制限と
          // 二重化しておく。
          responseHeadersPolicy: responseHeaders,
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
      // 403 も入れるのが本質。OAC + S3 REST オリジンではバケットポリシーに
      // s3:ListBucket が無く、S3 が「存在しない」と「権限が無い」を区別しないため、
      // 存在しないキーは 404 ではなく 403 (AccessDenied) で返る。404 だけマップしても
      // 閲覧者には 403 が見えたままになる。
      //
      // ttl は既定と同じ 10 秒だが、明示するとテンプレートに ErrorCachingMinTTL が
      // 描画されてテストで固定できる。デプロイ直後に一時的に 404 になったオブジェクトを
      // 長時間キャッシュされると困るので、短い値であること自体に意味がある。
      //
      // CustomErrorResponses は DistributionConfig 直下にあり、ビヘイビア単位ではなく
      // ディストリビューション全体に効く。存在しない /media/* の画像を要求すると
      // HTML の 404 ページが画像として返るが、壊れた画像に見えるだけで害は無い。
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
    // FunctionUrlOrigin.withOriginAccessControl が出すのは lambda:InvokeFunctionUrl の
    // 1 文だけだが、CloudFront 開発者ガイド「Restrict access to an AWS Lambda function
    // URL origin」は add-permission を **2 回** 実行するよう指示している
    // （AllowCloudFrontServicePrincipal と AllowCloudFrontServicePrincipalInvokeFunction）。
    // lambda:InvokeFunction が無いと Function URL の IAM 認可が 403 を返し、
    // **関数が起動しないのでログも残らない。**
    //
    // 実測（2026-08-30, 初回デプロイ後）:
    //   POST /api/posts -> 404, server: AmazonS3, ロググループは空のまま。
    //   403 が CustomErrorResponses(403 -> /404.html) で 404 に化けるので、
    //   症状だけ見ると「ルーティングが効いていない」ように誤読しやすい。
    //
    // AWS のブログ記事は InvokeFunctionUrl だけを示していてドキュメント間で
    // 食い違うが、**実環境の挙動は開発者ガイドのほうと一致する。**
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
