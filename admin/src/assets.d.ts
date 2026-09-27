/**
 * Vite が解決する CSS の副作用 import に型を与える。
 *
 * `src/main.ts` の 1 行目が `import './styles.css';` で、tsc は `.css` を知らないので
 * 宣言が無いと **TS 7 の型検査が落ちる**:
 *
 *     src/main.ts(1,8): error TS2882: Cannot find module or type declarations for
 *     side-effect import of './styles.css'.
 *
 * **原因は Go 移植ではなく既定値の変更。** `noUncheckedSideEffectImports` の既定が TS 6.0 で
 * false -> true になった（実測: 同じソースに 5.9.3 / 6.0.3 / 7.0.2 を当てて黙るのは 5.9.3
 * だけ）。したがってこの宣言は **5.9.3 では完全な no-op** で、ピンを上げる前に単独で入れられた。
 *
 * # 本体を空にしてある（**default export を書かないこと**）
 *
 * `node_modules/vite/client.d.ts` 自身が `declare module '*.css' {}` と宣言しており、
 * **vite 8 は `.css` の default export（string）を廃止した** — 中身が要るときは
 * `import css from './x.css?inline'`。ここで `const url: string; export default url;` と書くと
 * 型検査は通るのに実行時は undefined になる **嘘の型** を作る。副作用 import に要るのは
 * 「モジュールが存在する」という事実だけ。`test/unit/toolchain.test.ts` が vite 側の宣言と
 * 同じ形であることを見張っている。
 *
 * # ほかの直し方を採らなかった理由
 *
 * - **`types` に `vite/client` を足さない。** admin/tsconfig.json の `types` が `["node"]`
 *   ちょうどであることを `test/unit/toolchain.test.ts` が固定している（ルートの
 *   node_modules/@types を暗黙に全部拾わせないための規律）。緩めると別の保護が消え、
 *   `*.css` の宣言が 2 本になって衝突する。
 * - **`noUncheckedSideEffectImports: false` で黙らせない。** 綴りを間違えた副作用 import を
 *   まるごと見逃す。CSS 1 行のために検査を 1 つ捨てる取引は割に合わない。
 */
declare module '*.css' {}
