import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // テストファイルが並列に CDK の App を組み立てて合成するため、既定の 5 秒では
    // 負荷次第で落ちる（実測: site-stack.test.ts の合成が 5822ms で timeout）。
    // 内容の問題ではなく実行環境の問題なので、アサーションを弱めず上限を上げる。
    testTimeout: 30_000,
  },
});
