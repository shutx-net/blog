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
  // The default is "auto", which inlines a stylesheet only while it stays under
  // vite's 4KB assetsInlineLimit. global.css crossed that line when the site was
  // actually designed, and silently became an external <link> -- which took the
  // last inline <style> out of dist/ and tripped the assertion in
  // admin/test/build/output.test.ts that exists to notice exactly that.
  //
  // Pinned rather than left to drift back and forth across a byte threshold. It
  // also stands on its own for a site this size: ~1.5KB gzipped per page, no
  // render-blocking request, and the HTML is re-fetched on every deploy anyway
  // so there is little cross-page caching to lose.
  //
  // NOTE: with no inline <style> the CSP could drop 'unsafe-inline' from
  // style-src. That is a real tightening worth doing, but it has to change
  // infra/lib/response-headers.ts and the assertion above in the same commit --
  // not be a side effect of a restyle.
  build: {
    inlineStylesheets: "always",
  },
  markdown: {
    processor: unified(),
  },
});
