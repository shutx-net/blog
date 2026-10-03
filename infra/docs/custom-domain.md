# カスタムドメイン blog.shutx.net

`https://blog.shutx.net` を**既存のディストリビューションの alias に足す**手順。
**DNS は Cloudflare、証明書は us-east-1 の ACM で、どちらも帯域外**にある
（このスタックに `AWS::CertificateManager::Certificate` は 1 つも生えない。理由は
`SITE_CERTIFICATE_ID` の JSDoc、固定しているのは `test/distribution-custom-domain.test.ts`）。

**手順 0〜4 と 7 は人間が実行する**（`infra/docs/stacks.md` の
「初回デプロイの手順（人間が実行する）」と同じ扱い）。
Cloudflare のコンソールと `aws acm` は DNS と AWS を**変更する**操作で、
**`cdk deploy` は利用者が承認して自分で打つ。エージェントには実行させない**
（差分を人間が読む運用。`AGENTS.md`「deploy の前に必ず差分を見る」）。
実装側の仕事は手順 5 の 1 行と、手順 6 の `cdk diff` を PR 本文に貼ることだけである。

手順は上から順に実行できる形にしてある。

### いまの実測値（2026-10-02）

| 対象 | 値 |
| --- | --- |
| ゾーンの NS | `ines.ns.cloudflare.com` / `hassan.ns.cloudflare.com`（＝ Cloudflare が権威） |
| `dig +short blog.shutx.net` | `d8gsxbwzr6ft8.cloudfront.net.` + `13.33.215.x`。**CNAME は既にあり、既に grey cloud** |
| `dig +short shutx.net` | `75.2.60.5` / `99.83.190.102`。**別物。apex は触らない** |
| 証明書 | `ISSUED`（2026-10-02 23:52 JST）/ `AMAZON_ISSUED` / RSA-2048 / SAN なし |
| 有効期限 | `NotAfter` 2027-04-18 — **198 日。13 か月ではない**（下の「証明書の寿命は短くなっていく」） |
| `RenewalEligibility` | `INELIGIBLE`。**ディストリビューションに付いた時点で `ELIGIBLE` になる**（手順 8 の (5)） |
| 検証用 CNAME | `_3806e7a6b01276da36368e2ec610c343.blog.shutx.net` → `_0cabdcadb89de4ad95abf5b6e1dcfea5.wzccmgtwzk.acm-validations.aws`。**消さない**（下の節） |

証明書の UUID を書くのは `infra/lib/site-stack.ts` の `SITE_CERTIFICATE_ID` **1 箇所だけ**にしてある
（ARN にはアカウント ID が入り、**このリポジトリは public** である。再発行時に直すのもその 1 行だけ）。

### 0. 前提の確認（**レコードを作る手順ではない**）

`blog` の CNAME は**既に存在し、既に grey cloud（DNS only）である。** ここは
「そうなっていること」を確認するだけで、**「追加する」と読んで実行すると重複レコードを作る。**

```sh
dig +short blog.shutx.net
# => d8gsxbwzr6ft8.cloudfront.net.
#    13.33.215.x                      <- CloudFront の IP（末尾は変わる）
```

- `13.33.x` のような CloudFront の IP が返れば **DNS only で正しい**
- **`104.x` や `172.67.x` が返ったら Cloudflare のプロキシが ON（orange cloud）になっている。**
  DNS only に戻すこと。理由は下の「Cloudflare のプロキシを ON にしない」
- 何も返らないときだけ、`blog` → `d8gsxbwzr6ft8.cloudfront.net` を
  **Proxy status: DNS only** で 1 本作る

### 1. 証明書を us-east-1 に発行する（人間が実行する）

**`--region us-east-1` を落とさないこと。** CloudFront は us-east-1 の証明書しか読まない
（デプロイ先が ap-northeast-1 であることとは無関係の、CloudFront 側の制約）。別リージョンに
作っても `cdk synth` は通り、`cdk deploy` が `InvalidViewerCertificate` という
原因の書かれていないエラーで落ちるだけになる。

```sh
CERT_ARN=$(aws acm request-certificate \
  --region us-east-1 \
  --domain-name blog.shutx.net \
  --validation-method DNS \
  --query CertificateArn --output text)
echo "$CERT_ARN"
```

以降の `$CERT_ARN` はこれ（`arn:aws:acm:us-east-1:<アカウント ID>:certificate/<UUID>` の形）。
**SAN（`--subject-alternative-names`）は足さない。** apex も `www` もこのディストリビューションに
向けないので、増えるのは検証すべき CNAME の本数だけである。

既に発行済みのものを拾い直すときは:

```sh
CERT_ARN=$(aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='blog.shutx.net'].CertificateArn | [0]" \
  --output text)
```

### 2. 検証用 CNAME の名前と値を取り出す（人間が実行する）

```sh
aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# => { "Name": "_3806....blog.shutx.net.", "Type": "CNAME", "Value": "_0cab....acm-validations.aws." }
```

### 3. Cloudflare に検証用 CNAME を 1 本入れる（人間が実行する・grey cloud）

- **Type**: `CNAME`
- **Name**: 手順 2 の `Name` から**ゾーン名を落として** `_3806....blog` の形で入れる。
  **Cloudflare は入力にゾーン名を自動で付ける。** FQDN をそのまま貼ると
  `_3806....blog.shutx.net.shutx.net` という名前のレコードになり、**検証は永久に通らない**
  （`PENDING_VALIDATION` のまま何時間でも待てる）
- **Target**: 手順 2 の `Value` を**末尾のドットごと**貼る
- **Proxy status**: **DNS only（grey cloud）**

> **このレコードは使い捨てではない。恒久的なレコードである。** 自動更新が同じレコードを
> もう一度読むので、**検証が通ったあとも消さないこと**（下の「検証用 CNAME を消さないこと」）。

### 4. 発行を待つ（人間が実行する）

```sh
aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT_ARN"
aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text
# => ISSUED
```

通らないときは手順 3 の Name を疑う。`dig +short _3806....blog.shutx.net CNAME` が
`_0cab....acm-validations.aws.` を返さなければ、ゾーン名が二重に付いている
（`NXDOMAIN` でも `dig +short` は黙って何も返さないので、空行は「レコードが無い」と読む）。

### 5. ARN の UUID だけをコードに入れる

`infra/lib/site-stack.ts` の `SITE_CERTIFICATE_ID` に、ARN の `.../certificate/` **より後ろだけ**を入れる。

```sh
echo "${CERT_ARN##*/}"
```

**アカウント ID は書かない。** ARN は `Stack.formatArn` が `AWS::Partition` / `AWS::AccountId` から
組み立てるので、コードに載るのはこの UUID と `'us-east-1'` だけになる。
`test/distribution-custom-domain.test.ts` が、テンプレート上の ARN にアカウント ID のリテラルが
無いことと、`site-stack.ts` のソースに `:<12 桁>:` が無いことの**両方**を見ている。

### 6. テストと `cdk diff`

```sh
npm run -w infra test
AWS_PROFILE=blog npx -w infra cdk diff BlogSiteStack
```

期待する差分は **3 リソースの in-place 更新だけ**である。

| リソース | 差分 |
| --- | --- |
| `MediaBucketE52FC6E4` | `CorsConfiguration.CorsRules[0].AllowedOrigins` に 1 本追加 |
| `AdminAuthUserPoolAdminClient7A4B432D` | `CallbackURLs` / `LogoutURLs` に 1 本ずつ追加 |
| `SiteDistribution3FF9535D` | `DistributionConfig` に `Aliases` と `ViewerCertificate` が増える |

**新規 0 / 置換 0 / 削除 0。** alias と証明書は `DistributionConfig` 直下にしか描画されず
オリジンにもビヘイビアにも触らないので、**OAC の論理 ID 集合もビヘイビア 3 件も動かない。**
`[+]` や `[-]` のリソースが出たら止めること。出力は**アカウント ID をマスクして**
PR 本文に貼る（AGENTS.md）。

### 7. デプロイ（**人間が承認して実行する**）

```sh
npx -w infra cdk deploy BlogSiteStack
```

- alias は **CloudFront グローバルで一意**。他人が押さえていれば `CNAMEAlreadyExists` で落ちる
  （静かには壊れない）
- 証明書が us-east-1 に無い、または `ISSUED` でなければ `InvalidViewerCertificate` で落ちる
- **`*.cloudfront.net` は alias ではないので消えない。** 退路として残る
  （`CLOUDFRONT_ORIGIN` の JSDoc）

### 8. 受け入れ確認

そのまま貼れる形にしてある（`$CERT_ARN` は手順 1 のもの）。

```sh
# (1) 新しいホスト名で 200 が返る
curl -sSI https://blog.shutx.net/ | head -1
# => HTTP/2 200

# (2) 証明書が入れ替わっている（既定の CN=*.cloudfront.net ではない）
openssl s_client -connect blog.shutx.net:443 -servername blog.shutx.net </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
# => subject=CN = blog.shutx.net

# (3) /api/* も新しいホストで通る
curl -sS https://blog.shutx.net/api/health
# => {"status":"ok","authMode":"cognito"}

# (4) **退路が残っている。** alias を足しても既定ドメインは無効化されない
curl -sSI https://d8gsxbwzr6ft8.cloudfront.net/ | head -1
# => HTTP/2 200

# (5) **自動更新が有効になったか**
aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query 'Certificate.{E:RenewalEligibility,U:InUseBy}'
# => { "E": "ELIGIBLE", "U": ["arn:aws:cloudfront::<アカウント ID>:distribution/<ID>"] }
```

`https://blog.shutx.net/admin/` でログインできることも見る（`CallbackURLs` に載っているので
admin 側の `resolveRedirectUri(location.origin)` がそのまま通る）。

**(5) を省かないこと。** `RenewalEligibility` が `INELIGIBLE` のままでも、サイトも admin も
`/api/*` も何も問題なく動く。手順 7 より前は `INELIGIBLE` が正しい（どこにも使われていない
証明書だから）ので、**ディストリビューションに付いて `ELIGIBLE` に変わったことを見る以外に
確かめる方法が無い。「自動更新が最初から入っていなかった」を、有効期限の日ではなく
いま捕まえられる唯一の確認である。**

### 9. 正のオリジンの切替（**別 PR・不可逆**）

ここまでは**可逆**である（`SITE_ORIGINS` から 1 本外して deploy し直せば戻る）。
`SITE_ORIGIN` と `.github/workflows/deploy.yml` の `SITE_URL` を `https://blog.shutx.net` に
倒すのは**別の作業**で、RSS の `<guid isPermaLink="true">` が全記事で変わる
＝**購読者への全記事再配信**になり取り消せない（AGENTS.md）。
`test/site-origins.test.ts` が両者の一致を固定しているので、**片方だけ倒した半端な状態には
できない**（`infra/docs/cdk-structure.md` の「`SITE_ORIGIN` 定数」）。

**apex `shutx.net` は触らない。** 実測で別のものが載っており（上の表）、このスタックの管理外である。
apex → `blog` のリダイレクトも作らない — それをやるには apex の DNS をこのディストリビューションに
向けることになり、いま apex に載っているものを壊す。

### 検証用 CNAME を消さないこと（**自動更新がそれを読む**）

手順 3 で入れた `_3806....blog.shutx.net` の CNAME は**恒久的なレコードである。**
ACM は有効期限の約 60 日前に自動更新を試み、そのとき**同じ名前・同じ値のレコードをもう一度読む。**
名前も値も更新のたびに変わらない。

**ACME の `dns-01` とはここが構造的に違う。** certbot などは発行ごとに TXT のトークンが変わるので
DNS の API 資格情報を常駐させる必要があるが、ACM の DNS 検証は**レコードが置いたままなら
資格情報が要らない。** これが「触らなくても更新される」経路の正体であり、だからこそ
**レコードを消すと黙って壊れる。**

**壊れ方が最悪である。** 消しても証明書は `ISSUED` のままで、サイトも admin も `/api/*` も
**何か月も正常に動き続ける。失敗が見えるのは有効期限が来た瞬間**で、そのとき全ホストが
TLS ハンドシェイクで落ちる。前兆を見せるのは手順 8 の (5) と、`RenewalEligibility` /
`RenewalSummary` の定期確認だけである。

#### 具体的に消えうる経路（実在する）

`github.com/shutx-net/claudeflare-aws-acm-federator`（**このリポジトリと同じ持ち主の
GitHub リポジトリ**。他人のものではないので、いつ動き出してもおかしくない）に日次の同期があり、その `cleanupStaleCnames()` は **`*.acm-validations.aws` を指す Cloudflare の
CNAME のうち、対応する ACM 証明書が見つからないものを削除する。** ところが `new ACMClient({})` に
リージョンが渡されていないため、**Lambda 自身のリージョン（`ap-northeast-1`）しか見ない。**
この証明書は **us-east-1** にあるので「対応する証明書が無い」と判定される。
**いまの実装のままデプロイすると、このレコードを消す。**

### 証明書の寿命は短くなっていく（だから手を入れない経路が要る）

この証明書の有効期間は **198 日**で、以前の 13 か月ではない。CA/Browser Forum の **SC-081** が
TLS 証明書の最長有効期間を段階的に縮めているためである（**2026-03 から 200 日 /
2027-03 から 100 日 / 2029-03 から 47 日**）。更新の回数はこれから年に数回まで増えるので、
**手作業の更新を前提にした運用は早いうちに破綻する** — 上の「検証用 CNAME を消さない」は
時間とともに重くなる規律である。

### Cloudflare のプロキシを ON にしない（`blog` も grey cloud のまま）

一般論ではなく、**この構成に固有の理由**が 4 つある。

1. **二重 CDN になって `create-invalidation` が効かなくなる。** デプロイの最後に CloudFront の
   invalidation を打っているが、閲覧者が当たるのは手前の Cloudflare のキャッシュになる。
   AGENTS.md が記録している「**更新したのに反映されない**」事故（実際に踏んだ）と同型である
2. **Cloudflare の SSL を "Flexible" にすると無限リダイレクトになる。** 既定ビヘイビアは
   `REDIRECT_TO_HTTPS` なので、Cloudflare が平文でオリジンに行くと CloudFront が 301 を返し、
   Cloudflare はそれを HTTPS の応答として閲覧者に返し、閲覧者はまた同じ URL に来る
3. **`/api/*` が壊れる。** あれは Lambda Function URL を OAC + SigV4 で叩くビヘイビアである。
   Cloudflare の WAF / Bot Fight Mode は admin の XHR をチャレンジするので、`fetch` には
   JSON ではなく HTML が返る
4. **費用の利点が無い。** CloudFront には 1TB/月の永年無料枠があり（AGENTS.md がそれを理由に
   Amplify Hosting を採っていない）、前段を足しても削る対象が無い

**カスタムドメインに付随して閉じた宿題**（結果つきで残してある）:

- **TLS 最低バージョン。** カスタム証明書が付いたので
  `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021` を**明示した。**
  既定の `*.cloudfront.net` 証明書のままだと `ViewerCertificate` ごとテンプレートに描画されず、
  この指定は**書いても効かなかった**（だから宿題として残っていた）。`cdk.json` の
  `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021: true` で地ならしは済んでいたが、
  **あのフラグを外した日に黙って `TLSv1.2_2019` へ落ちる**ので値そのものも明示し、
  `test/distribution-custom-domain.test.ts` が `TLSv1.2_2021` を直接見ている
- **カスタムドメインと ACM。** CloudFront 側は完了（alias / 証明書 / TLS ポリシー）。
  **Cognito の Managed Login は意図的に `<prefix>.auth.<region>.amazoncognito.com` のままにする。**
  カスタムドメインにするには別の ACM 証明書と DNS レコードが増えるのに対し、得られるのは
  **著者 1 人がログインのときだけ見る URL の見た目**である。`lib/admin-auth.ts` の
  「入れていないもの（意図的）」にも同じことが書いてある
- **`env` の明示は要らなかった。** 証明書を帯域外で作って ARN で参照する形にしたので、
  カスタムドメインを入れても env は不要だった。スタックは env-agnostic のままで、
  `test/site-stack.test.ts` がそれを固定し続ける
  （`infra/docs/cdk-structure.md` の「cdk_best_practices との既知の乖離」）
