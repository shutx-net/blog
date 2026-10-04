# 複数リソースに対するアサーションの書き方

第 2 バケットの追加で、既存のアサーションのうち 4 件が「**落ちないまま静かに弱くなった**」。
`hasResource` / `hasResourceProperties` / `Array.prototype.find` はいずれも
「**1 件でも** 一致すれば通る」ため、リソースが 1 個から 2 個になった瞬間に
「全部が満たす」から「どれか 1 個が満たす」へ退化する。
`Template.allResourcesProperties` が該当 0 件で通る罠（これも実際に踏んだ）の **兄弟** で、
向きが逆であり、**赤くならないぶん見つけにくい**。

実測で確認した退化の例（いずれも締め直し前は緑のままだった）。

| 改変 | 締め直し前 | 締め直し後 |
| --- | --- | --- |
| `SiteBucket` を `RemovalPolicy.DESTROY` にする | `site-bucket.test.ts` 8/8 緑 | 赤 |
| `SiteBucket` から `encryption` を外す | `site-bucket.test.ts` 8/8 緑 | 赤 |
| `MediaBucket` から `enforceSSL` を外す | `site-bucket.test.ts` 8/8 緑 | 赤 |
| メディアオリジンを OAC 無しで結線する | `AWS:SourceArn` のアサーションが緑 | 赤 |

以後、リソースが複数になりうる型に対しては次の 4 つの型のいずれかで書くこと。

1. リソース横断の不変条件 → `template.allResourcesProperties(type, {...})`。
   ただし **直前に必ず件数の非空ガードを置く**
2. `DeletionPolicy` / `UpdateReplacePolicy` のように Properties の外にあるものは
   `allResourcesProperties` では書けないので、`findResources(type)` の戻り値を全件ループする。
   件数アサーションを先に置く
3. 特定リソース固有の主張（配信用だけバージョニング無効、等）は **論理 ID で名指し** して
   `findResources(type)[LOGICAL_ID]` を取り、存在を確かめてから中身を見る。名指しが非空ガードを兼ねる
4. `Array.prototype.find` は filter + 件数アサーション + 全件ループに置き換える

`site-bucket.test.ts`（配信用を名指し）と `media-bucket.test.ts`（全バケット走査）は
一見重複しているが、**重複させておくのが正しい**。片方が将来消えたり書き換えられたりしても、
もう片方に保証が残る。

**なお `removalPolicy: RemovalPolicy.RETAIN` の行を消すのは改変にならない。**
`s3.Bucket` の `removalPolicy` の既定が `RETAIN` なので、行を消してもテンプレートは 1 バイトも
変わらない（実測で確認）。ミューテーションテストを書くときは `DESTROY` を明示すること。
