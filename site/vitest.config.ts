import { defineConfig } from "vitest/config";

// Plain defineConfig, not astro's getViteConfig: nothing here resolves astro's
// virtual modules (`astro:content` and friends), so paying for astro's config
// resolution would only make the run slower and failures harder to read.
export default defineConfig({
  test: {
    projects: [
      // Inner loop. Never starts astro; runs in well under a second.
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      // Covers what the unit layer structurally cannot: the glob loader,
      // routing, getStaticPaths and render(). globalSetup builds the site once
      // for the whole project rather than once per test file.
      {
        test: {
          name: "build",
          include: ["test/build/**/*.test.ts"],
          globalSetup: ["test/setup/build-site.ts"],
          testTimeout: 60000,
        },
      },
    ],
  },
});
