import { defineConfig } from 'vitest/config';

// site / api と同じ projects 構造。プロジェクトを分ける基準は「何に依存するか」。
//
//   unit     : 何にも依存しない純粋モジュール。内側のループ。
//   dom      : jsdom が要るもの（DOM 結線だけ）。
//   contract : site の実 postSchema と api の実バリデータを突き合わせるもの。
//   parity   : プレビューが site と一致することの証明。site/dist と実 processor を読む。
//   build    : admin/dist を読む。pretest が先にビルドする。
//
// **environment を明示している。** 既定（node）に頼ると、あとで dom を足した人が
// グローバル設定を書き換えて他プロジェクトを巻き込む形になりやすい。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['test/dom/**/*.test.ts'],
          // 実パイプラインを 1 件だけ使う DOM テストがある。shiki の wasm 読み込みを
          // 含むので既定の 5 秒では足りない。
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['test/contract/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'parity',
          environment: 'node',
          include: ['test/parity/**/*.test.ts'],
          // site/dist の全記事を実 processor で描き直す。shiki の初期化が入る。
          testTimeout: 60000,
        },
      },
      {
        test: {
          name: 'build',
          environment: 'node',
          include: ['test/build/**/*.test.ts'],
        },
      },
    ],
  },
});
