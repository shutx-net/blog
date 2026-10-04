# AWS の運用

### 認証情報

**このリポジトリは public。アクセスキーを絶対に置かないこと。** GitHub Actions は OIDC で
ロールを assume するので、リポジトリ側に AWS の秘密は存在しない。

手元からデプロイするときだけ、ホスト側のプロファイルを使う。

```sh
aws configure sso --profile blog
export AWS_PROFILE=blog
aws sts get-caller-identity      # 疎通確認
```

`AWS_PROFILE` を毎回打ちたくないなら、`.envrc` ではなく **`.envrc.local`**（gitignore 済み）に
書いて `source_env_if_exists .envrc.local` で読む。`.envrc` はコミットされる。

### CDK ブートストラップ

アカウント × リージョンごとに一度だけ必要。

```sh
npx -w infra cdk bootstrap aws://<account-id>/ap-northeast-1
```

### Cognito（管理画面のログイン）

単一著者用のユーザプールを `BlogSiteStack` の中に持っている。
**ユーザは CDK では作らない**（このリポジトリは public なので、個人のメールアドレスも
ユーザ名以外の情報もテンプレートに書かない）。GitHub App の秘密鍵と同じく帯域外で行う。

#### 値の取り方

物理名はハードコードしていないので、CfnOutput から拾う。**Construct の中で作った Output は
論理 ID にハッシュが付く**ので `ends_with` で引く。

```sh
POOL_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolId')].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminUserPoolClientId')].OutputValue" --output text)
LOGIN=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey,'AdminLoginDomain')].OutputValue" --output text)
```

#### ユーザを作る（初回だけ）

```sh
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
  --username shutx --message-action SUPPRESS

aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
  --username shutx --password '<16 文字以上・大小英字と数字と記号>' --permanent
```

**`--username` は `infra/lib/site-stack.ts` の `ADMIN_USERNAME` と完全一致でなければならない。**
プールは `UsernameConfiguration.CaseSensitive: true` なので大文字小文字も区別する。
一致しないトークンは API が **401 `{"error":"not_authorized"}`** で弾く。

`--message-action SUPPRESS` はメールを送らせないため。`selfSignUpEnabled: false` なので
このコマンド以外にユーザが増える経路は無い。

MFA（TOTP）は任意で、Managed Login から後で登録できる。

#### ID トークンを取る

```
$LOGIN/login?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=https://<distribution-domain>/admin/
```

をブラウザで開いてログインし、リダイレクト先の `?code=` を `/oauth2/token` で交換する
（authorization code grant。**implicit は無効にしてある**。client secret は無い public client）。

```sh
curl -s -X POST "$LOGIN/oauth2/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code -d "client_id=$CLIENT_ID" \
  -d "code=$CODE" -d "redirect_uri=https://<distribution-domain>/admin/" | jq -r .id_token
```

#### 管理画面からログインする

`/admin/` を開いて「ログイン」を押すだけ。**起動しただけでは何も起きない**
（自動リダイレクトはしない）。実装の詳細は `admin/src/auth/` と
`admin/src/auth/THREAT-MODEL.md` にある。

    ブラウザ -> /oauth2/authorize (PKCE S256 + state) -> Managed Login
            -> /admin/?code=... -> /oauth2/token で交換 -> sessionStorage

**トークンは `sessionStorage` に置く。** タブを閉じれば消えるので、ブラウザを
再起動するたびに再ログインが要る。**これは意図した trade-off** であり、
理由は `admin/src/auth/THREAT-MODEL.md` にある（24 時間有効な refresh トークンを
ディスクに残さないことを優先している）。変えたくなったらまずそれを読むこと。

設定のドリフト（コンソールから誰かがクライアント設定を変えた等）は smoke で検出できる。

```sh
npm run -w admin auth-smoke
```

**AWS 認証情報が無いときは `describe-user-pool-client` の 1 件だけ skip して残りを走らせる**
（skip したことは必ず出力される）。認証情報を使うときは `aws sso login --profile blog` を先に。

#### ブラウザでしか確かめられないこと（**必ず人間が 1 度やること**）

このリポジトリの flake にブラウザは無く、jsdom では以下が原理的に検証できない。
**テストが全部緑でもここが壊れている可能性がある。**

1. **`location.assign()` による実リダイレクト。** jsdom は
   「Not implemented: navigation to another Document」を出して**何もしない**
   （例外も投げず URL も変わらない）。テストは注入した関数で URL 文字列だけを見ている。
2. **`crypto.subtle` の secure context 要件。** 本番は https、開発は `http://localhost` で
   どちらも secure context に入るはずだが、ブラウザでしか確かめられない。
3. **`sessionStorage` がタブの寿命に紐づき、Cognito への全画面遷移と復帰を越えて保持されること。**
   **PKCE の verifier と下書きの両方がこの性質に依存している。**
4. **タブ間の `storage` イベント。** jsdom では発火 0 件（実測）。タブ間同期は scope 外。
5. **Managed Login（`ManagedLoginVersion: 2`）の実画面。** `ManagedLoginBranding` が
   未作成で、`/login` の直叩きは 403 とともに既定の HTML を返す（実測）。
   通常の経路（`/oauth2/authorize` から 302）でどう見えるかは未確認。
6. **CSP が実際にスクリプトを止めること。** 実測で **jsdom は CSP を一切強制しない**
   （`script-src-attr 'none'` を与えても `<div onclick>` は発火する）。
   **「CSP が onerror を止めた」という緑のテストは書けない。**

##### 手順（ユーザを作ったあとに 1 度だけ）

1. `/admin/` を開く。**自動で Cognito に飛ばないこと。**
2. 何か入力する。
3. 「ログイン」を押す -> Cognito の画面に飛ぶ。
4. 戻ってきて **入力が残っていること**（= 上の 3 の確認）。
5. アドレスバーに `?code=` が残っていないこと。
6. 投稿できること。
7. サインアウト -> 再訪で未認証になること。**下書きは消えていないこと。**
8. devtools のコンソールに **CSP 違反が 1 件も出ていないこと**。
9. コードフェンス入りの記事で **シンタックスハイライトに色が付くこと**
   （付かなければ CSP が `'wasm-unsafe-eval'` を落として wasm を止めている）。
10. **画像アップロードが通ること**（`connect-src` にメディアバケットが入っているか）。

#### ローカル開発ではログインできない

`CallbackURLs` は `https://<distribution-domain>/admin/` の 1 本だけで、
`http://localhost:5173/admin/` は入っていない。実測で不一致は `redirect_mismatch` になり、
Cognito 自身の `/error` に飛ぶ（**攻撃者の URL には飛ばない**）。

`npm run -w admin dev` でエディタとプレビューは動くが、**ログインと投稿は試せない。**
`redirect_uri` はオリジンから導出しているので、infra 側で `callbackUrls` に
`http://localhost:5173/admin/` を足せば admin は無変更で通る。**ただし public client の
callback に localhost を足すことは、開発者の端末で動く任意のアプリが `code` を
受け取れることを意味する**ので、足すかどうかは意識的に決めること。

#### API に付けるヘッダ

```
x-blog-authorization: Bearer <ID token>
```

**`Authorization` ではない。** CloudFront の OAC が `SigningBehavior: always` で
viewer の `Authorization` を上書きするため（理由と実測は `infra/docs/api-auth.md` の
「閲覧者の `Authorization` ヘッダは CloudFront に上書きされる」）。
**access トークンではなく ID トークンを送ること**（API は `token_use: 'id'` を要求する）。

ボディがある POST / PUT には **`x-amz-content-sha256: <ボディの SHA-256 を小文字 hex で>`**
も必須。付け忘れると 403 になり、CloudFront の `CustomErrorResponses` で
**404 の HTML に化ける**（認証の失敗と紛らわしいので注意）。

### `AUTH_MODE` の運用（切り戻し手順）

`AUTH_MODE` は Lambda の環境変数で、**CDK が唯一の変更経路**である
（コンソールで直接書き換えると次の deploy で戻る）。許容値は `deny-all` と `cognito` の
**2 つだけ**で、それ以外・空文字・未設定はすべて **コールドスタートで例外**になり、
Lambda の初期化が落ちて CloudFront には 502 が返る。
**「打ち間違いが黙って全許可になる」経路は存在しない。**

いま何で動いているかは無認証で確認できる。

```sh
curl -s https://<distribution-domain>/api/health
# {"status":"ok","authMode":"cognito"}
```

Cognito 側で問題が起きたときの切り戻しは、`infra/lib/site-stack.ts` の `PostingApi` の
`auth` を戻して deploy し直すだけ。

```ts
auth: { mode: 'deny-all' },
```

- **Cognito のリソースは消えない**（`deletionProtection: true` / `RemovalPolicy.RETAIN`）
- **`deny-all` は `COGNITO_*` を 1 つも読まない**ので、
  **壊れた Cognito 設定を抱えたまま安全側に倒せる**
- 戻すと認証が必要な 3 経路はすべて `503 {"error":"auth_not_configured"}` になる

### GitHub App の秘密鍵

Secrets Manager に置く。**CDK には値を書かない** — CloudFormation テンプレートに平文が残るため、
空のシークレットを CDK で作り、値だけを CLI で流し込む。

**シークレットの物理名は CDK が付けない**（物理名をハードコードしない方針）。名前は
`BlogSiteStack` の CfnOutput `GitHubAppSecretName` から取る。

```sh
SECRET_ID=$(aws cloudformation describe-stacks --stack-name BlogSiteStack \
  --query "Stacks[0].Outputs[?ends_with(OutputKey, 'GitHubAppSecretName')].OutputValue" \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --secret-binary fileb://blog-app.private-key.pem
```

`--secret-binary` を使うので、API からは `SecretBinary`（`Uint8Array`）として返る。
`api/src/secret.ts` は **`SecretBinary` を先に見る**（コンソールから貼った場合の
`SecretString` にもフォールバックする）。

PEM ファイルはこのリポジトリの中に置かないこと（`.gitignore` はしているが、そもそも持ち込まない）。

鍵を入れ替えるときは、GitHub App は秘密鍵を複数同時に有効化できるので無停止でいける。

1. GitHub の App 設定で新しい鍵を生成（**API では作れない。Web UI のみ**）

2. `AWSPENDING` として投入する。

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id "$SECRET_ID" \
     --secret-binary fileb://blog-app.private-key.new.pem \
     --version-stages AWSPENDING
   ```

3. **昇格する前に、その鍵で本当に installation token が取れるかを確かめる。**
   API に検証用の経路がある。`?versionStage=AWSPENDING` を付けると
   `AWSPENDING` の鍵だけを読んで（`AWSCURRENT` のキャッシュを使わずに）試す。

   ```sh
   curl -s "https://<distribution-domain>/api/health/github-app?versionStage=AWSPENDING"
   # {"status":"ok","canMintInstallationToken":true,"versionStage":"AWSPENDING"}
   ```

   **この経路は秘密鍵も installation token も返さない。** 返るのは真偽値だけ。
   `canMintInstallationToken` が `false` なら **昇格してはいけない** — 手順 2 に戻る。

   > **この経路は認証必須なので、Cognito の ID トークンを付ける必要がある。**
   > 取り方は上の「Cognito（管理画面のログイン）」を参照。
   > `AUTH_MODE` を `deny-all` に戻している間はトークンの有無によらず 503 が返るので、
   > その場合は Lambda をコンソールから直接テスト実行して同じ判定ができる。
   >
   > ```sh
   > curl -s -H "x-blog-authorization: Bearer $ID_TOKEN" \
   >   "https://<distribution-domain>/api/health/github-app?versionStage=AWSPENDING"
   > ```

4. `AWSCURRENT` に昇格する。`--remove-from-version-id` には現在の
   `AWSCURRENT` のバージョン ID を渡す。

   ```sh
   CURRENT_ID=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
     --query "VersionIdsToStages | to_entries(@)[?contains(value, 'AWSCURRENT')] | [0].key" --output text)
   PENDING_ID=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
     --query "VersionIdsToStages | to_entries(@)[?contains(value, 'AWSPENDING')] | [0].key" --output text)
   aws secretsmanager update-secret-version-stage \
     --secret-id "$SECRET_ID" --version-stage AWSCURRENT \
     --move-to-version-id "$PENDING_ID" --remove-from-version-id "$CURRENT_ID"
   ```

5. 昇格後にもう一度確認する（今度は `versionStage` を付けずに）。

   ```sh
   curl -s "https://<distribution-domain>/api/health/github-app"
   ```

   **Lambda の実行環境は鍵をキャッシュしている。** 昇格直後は古い鍵を掴んだままの
   実行環境が残りうるので、確実に切り替えたいなら Lambda の設定を 1 つ更新して
   実行環境を作り直すこと（環境変数の値を変える等）。

6. GitHub 側で古い鍵を削除

### CSP の `style-src`（issue #34 の結論）

配信している値は `style-src 'self'` と `style-src-attr 'unsafe-inline'` の 2 本立て。
組み立ては `infra/lib/response-headers.ts` の `buildCsp` ただ 1 つで、**論証は
`infra/docs/security-headers.md`**。運用上知っておくことは 2 つ。

- **`style-src-attr` から `'unsafe-inline'` を外すとコードフェンスの色が飛ぶ。** shiki は
  トークンごとに `style="color:#..."` **属性**を吐く（実測: コードフェンス 2 本の記事 1 件で
  `style=` 属性 **29 個**、`<style>` ブロック 0 個）
- **本番の記事にコードフェンスが無い間は無症状で通る。** `style=` 属性が 0 個なので、
  壊れていても既存ページでは分からない。**色が飛ぶのは記事を書いた日になる**

#### shiki を class 出力にする案を採らなかった理由

`@shikijs/transformers` の `transformerStyleToClass` を使えば属性そのものを無くせる。採らない。

- **未インストールで新規依存になる**（`node_modules/@shikijs` には core / engine-* / langs /
  primitive / themes / types / vscode-textmate しか無い）
- **markdown の出力が変わるので `admin/test/parity/published-html.test.ts` のバイト一致が壊れる**
- `themes` / `defaultColor: false` は CSS 変数を**属性の中に**吐くので、属性は消えない

#### ブラウザでの確認が必須

**CSP 違反はブラウザのコンソールにしか出ない。** `curl` はヘッダしか見ないので、スタイルが
飛んでいてもステータス 200 で通る。過去に `script-src-attr 'none'` の確認で同じ形を踏んでいる。

`cdk deploy` の後に DevTools の Console を開いたまま `/`・記事ページ・`/admin/` を見て、
**CSP 違反が 1 件も出ない**ことと見た目が崩れていないことを確かめること。
