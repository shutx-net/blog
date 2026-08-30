import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { resolveSiteUrl } from "./src/site-url.ts";

// Astro 7 defaults to the Satteri (Rust) processor. This project pins the
// remark/rehype pipeline instead so the admin preview and production render
// Markdown identically -- see AGENTS.md, non-negotiable decision 1.
// test/unit/markdown.test.ts asserts this at the config level; deleting the
// `processor` line below is not detectable from the generated HTML.
export default defineConfig({
  // The absolute origin canonical links, rss.xml, sitemap-*.xml and robots.txt
  // are built from. Resolved from SITE_URL by a pure function so it can be unit
  // tested and injected at deploy time -- the production domain is not decided
  // yet. Removing this line does NOT fail loudly in both directions: RSS fails
  // the build, but sitemap only logs a warning and emits nothing at exit code 0.
  site: resolveSiteUrl(process.env),
  // No options on purpose. changefreq, priority and lastmod would all be
  // invented values, and a filter would only duplicate what the routes already
  // decide. The defaults emit sitemap-index.xml plus sitemap-0.xml and drop the
  // status pages (404, 500).
  integrations: [sitemap()],
  markdown: {
    processor: unified(),
  },
});
