import { defineConfig } from 'vitest/config';

// site/vitest.config.ts と同じ構造。build プロジェクトは dist/ を読むので、
// 先に npm run -w api build が要る（package.json の pretest が走らせる）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts', 'test/contract/**/*.test.ts'],
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
