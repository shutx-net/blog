# TypeScript 7

### TypeScript 7 — `tsc` の実体はネイティブバイナリ

`typescript` は Go 実装に移行した。npm の `typescript` パッケージは **node のシムでしかなく**、
コンパイラの実体は `@typescript/typescript-<os>-<arch>`（このマシンでは
`@typescript/typescript-linux-x64`、約 28MB）という **別パッケージ**にある。
`typescript` はそれを 20 プラットフォーム分 `optionalDependencies` に並べ、
npm が `os` / `cpu` に一致する 1 つだけを入れる。

実務上の帰結が 3 つある。

- **`npm ci --omit=optional` を使わないこと。** コンパイラ本体が入らず、`tsc` は
  `Error: Unable to resolve @typescript/typescript-linux-x64.` を投げて**起動すらしない**。
  黙って成功はしないので CI は赤くなるが、原因が分かりにくい。
  `.github/workflows/*.yml` は素の `npm ci` を使っている（そのままにすること）
- **WSL から Windows 版の npm を使わないこと。** 5.x の `tsc` は純 JS だったのでどの npm で
  入れても動いたが、7.x は os/cpu でバイナリを選ぶ。Windows の npm で入れると
  `@typescript/typescript-win32-x64` が Linux のツリーに入り、`node_modules/.bin/tsc` が
  実行不能になる。**`which npm` が `/nix/store/...` を指していることを確認する**
  （すべての作業を `nix develop` 経由にするという既存の規律がそのまま対策になっている）
- **エディタの設定は `tsserver` 前提だと効かない。** 7.x は bin から `tsserver` を落とし、
  `tsc --lsp`（標準 LSP）に統合した。CI とビルドには無関係だが、
  古い tsserver プロトコルを前提にしたエディタ設定は動かない

`api/test/unit/toolchain.test.ts` が **実際に走る `tsc --version`** を package.json のピンと
突き合わせている。上の 2 つ（`--omit=optional` と WSL の npm）はこのテストで赤くなる
（ピン文字列を読むだけのアサーションでは検出できない事故なので、実行結果と突き合わせている）。
3 つめのエディタ設定は CI にもテストにも現れない。

### **テストが全部緑でも、型が正しいことにはならない**

**Vitest は esbuild で型を剥がして実行する。テストの実行に `tsc` は一切関与しない。**

`typescript` を 5.9.3 から 7.0.2 に上げた瞬間、**1988 件のうち 1987 件はそのまま通り、
赤くなったのは「ピン文字列を読んでいるテスト」1 件だけ**だった。

**型を見ているのは `tsc --noEmit` の 4 本だけ。**

```sh
npm run -w api typecheck && npm run -w infra typecheck \
  && npm run -w admin typecheck && npm run -w site typecheck
```

`.github/workflows/ci.yml` は 4 ジョブすべてでこれを
**test とは別のステップ**として回している。**テストジョブに畳み込まないこと。**
畳み込むと「型検査が走らなかったのに緑」という経路ができる。

そのうち `api` / `infra` / `admin` の 3 本は、本当に型を見ていることを変異で確かめてある
（`erasableSyntaxOnly` を破ると TS1294、`skipLibCheck` を api から外すと 124 件）。
詳細は各 `toolchain.test.ts` のコメント。

### `site` の typecheck だけ `astro sync` が前に付く

```
"typecheck": "astro sync && tsc --noEmit"
```

他 3 つは `tsc --noEmit` だけなので**文字列が揃わない。揃えようとして `astro sync` を
外さないこと。** `site/.astro/types.d.ts` は `.gitignore` 済みで、**無い状態で `tsc` を
走らせると `astro:content` が解決できず、テストではなく `site/src/pages/rss.xml.ts` に
エラーが出る。** CI は `npm ci` しかしないので、**これは CI でだけ落ちる形**になる
（手元では前のビルドが残した `.astro/` に助けられて気づけない）。
記事が 0 本でも `astro sync` は成功するので、CI の条件でも通る。

`astro check`（`.astro` ファイル自体の型検査）は**これとは別物**で、まだ入れていない。
ここで走るのは `.ts` の検査だけ。

この穴が開いていた間、`site/test/` に `possibly undefined` 系のエラーが溜まっていた
（issue #36）。**`tsc` を走らせる手順を増やすときは `infra/test/workflow-ci.test.ts` の
`TYPECHECKED` にも足すこと** — ci.yml からステップが消えても、他のどのテストも赤くならない。
