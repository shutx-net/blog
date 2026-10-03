# oxlint

```sh
npm run lint          # = oxlint --deny-warnings
```

設定は `.oxlintrc.json`（**jsonc なのでコメントが書ける**。例外を許すときは理由を残すこと）。

### 採用の根拠（実測）

```
oxlint 1.85.0 / MIT / 2026-09-21 公開（週次、212 リリース）
archived=false / pushed_at=2026-09-27 / stars 22897 / deprecated なし
runtime 依存ゼロ / hasInstallScript=false（postinstall を持たない）
npm の maintainer は 1 人（boshen）
```

**最後の 1 行は AGENTS.md の「採用するが注意が要る条件」に該当する**ので理由を書く。
GitHub は `oxc-project` org で活発に動いており放棄プロジェクトではないこと、
**devDependency なので Lambda のバンドルには入らない**こと、postinstall を持たないことが
緩和材料。ESLint と違って推移依存がゼロなのは、この repo の
「同じ用途なら依存の少ない候補を優先する」に直接合致する。

**`flake.nix` には入れない。** `DEVELOPERS.md` の「意図的に入れていないもの」の `aws-cdk` と同じ理由で、
バージョンの真実の所在を `package.json` 1 箇所に保つため。

### 運用上の罠が 2 つある

**1. `--deny-warnings` が無いと素通りする。** 違反を 1 件仕込んだ状態の実測:

```
oxlint                  → exit 0   （素通りする）
oxlint --deny-warnings  → exit 1
npm run lint            → exit 1
```

`categories.correctness` は `warn` なので、これが無いと **CI が緑のまま通る**。
`api/test/unit/toolchain.test.ts` が `scripts.lint` にこのフラグが含まれることを固定している。

**2. 走査対象が静かに縮む。** `ignorePatterns` で一部を外しても exit 0 のままになる:

```
ignore なし                    → number_of_files=174
ignore admin/** infra/**       → number_of_files=73   （exit 0 のまま）
```

`api/test/unit/oxlint-coverage.test.ts` が床 150 を置いている。**「0 より大きい」では不十分**で、
ワークスペースを 1 つ落としたときの残存数（api 125 / admin 105 / infra 143 / **site 149**）の
最小を割る値でなければ意味がない。

なお「対象が 1 件も無い」（`No files found to lint`）は **exit 1** になるので、そこは安全。
**ルール名の typo も無言では通らない** — 設定ファイル経由なら
`Rule 'xxx' not found in plugin 'eslint'` で exit 1 になる
（ただし **CLI の `-D` フラグは検証しない**。`npm run lint` は設定ファイル経由なので問題ない）。

### oxlint で検査できないもの

**次に「これも oxlint で」と考えた人が同じ調査を繰り返さないための一覧。**

| 規約 | なぜ無理か | 実際の担当 |
| --- | --- | --- |
| インデント 2 スペース | **`indent` ルールが存在しない**（`Rule 'indent' not found in plugin 'eslint'`）。oxlint はフォーマッタではない | 誰も検査していない |
| 呼び出し形式の検査全般 | **`no-restricted-syntax` が存在しない**（同上）。AST パターンで縛れない | — |
| `package.json` のバージョン完全固定 | oxlint は `package.json` を読まない | 各 `toolchain.test.ts` |
| ワークフローの YAML と run スクリプト | JS/TS ではない | `infra/test/workflow-*.test.ts` |
| CloudFormation の合成結果 | 同上 | `infra/test/` |
| ビルド成果物の中身 | 同上 | `api/test/build/bundle.test.ts` |
| `media/limits.ts` の「import 文がゼロ」 | 相対 import は正当なので `patterns` で禁じられない | `api/test/unit/media-limits.test.ts` |
| admin が素の `fetch` を使わない | `no-restricted-globals` は**型位置の `typeof fetch` も違反として数える**。注入 seam として `fetchImpl?: typeof fetch` を使う 7 ファイルを除外すると実質 off になる。さらに `globalThis.fetch` / `window.fetch` / `new Request` / `sendBeacon` はメンバ参照で拾えず、**6 形のうち 2 形だけ**。実測で素の `fetch(` を足しても exit 0 | `admin/test/unit/no-raw-fetch.test.ts`（oxlint 側は `XMLHttpRequest` だけに絞ってある） |

### oxlint と既存テストは補完関係で、どちらも外せない

`os.tmpdir()` の 7 つの書き方を両方に通した実測表は `.oxlintrc.json` のコメント
（`**/test/**/*.ts` の override）にある。**どちらも相手の上位集合ではない** — 別名 import は
oxlint だけが、動的 import と `node:` 接頭辞なしは `scratch-isolation.test.ts` の
テキスト走査だけが捕まえる。oxlint を入れても既存の検査テストは 1 つも消せなかった。
しかも監視の主体である `github-token.test.ts` が実際に使っているのは動的 import の形で、
**oxlint からは見えない側**にある。

逆に `api/src/posts/**` は**これまで規約がコメントにしか無く無防備だった**。
そこは oxlint が新しく塞いだ範囲。
