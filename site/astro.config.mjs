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
  // No `build.inlineStylesheets` on purpose: the default "auto" inlines a
  // stylesheet only while it stays under vite's 4KB assetsInlineLimit, and the
  // /_astro/Layout.*.css this build emits is 6.0KB, so it always stays external
  // (measured: inline <style> 0/13, one <link>). The limit is compared against
  // the built file, not against global.css -- which is 15KB of source, most of
  // the difference being comments that minification drops.
  //
  // It was pinned to "always" for one release, when designing the post page
  // pushed global.css past the threshold and the stylesheet silently went
  // external -- taking the last inline <style> out of dist/ and tripping the
  // assertion in admin/test/build/output.test.ts. Pinning kept the CSP out of a
  // restyle. Dropping 'unsafe-inline' from style-src is the reason the pin is
  // gone now, and both moved in the same commit.
  //
  // Same-origin CSS is covered by style-src 'self', so nothing here may put a
  // <style> block back: the CSP would block it and the page would lose its
  // styling. That direction is now watched by output.test.ts, which requires
  // zero inline <style> rather than at least one.
  markdown: {
    processor: unified(),
  },
});
