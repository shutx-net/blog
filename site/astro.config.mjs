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
  // `"never"` is a declaration, not an optimisation. This site is served under
  // `style-src 'self'` (infra/lib/response-headers.ts), so an inline <style>
  // block is refused outright and the page carrying it loses its styling with
  // nothing else going red -- while under the default "auto" whether astro
  // inlines is decided by the *size* of the built stylesheet against vite's
  // 4096 B assetsInlineLimit (astro's own shouldInlineAsset: a strict
  // `Buffer.byteLength(source) < limit` on the built file, not on global.css,
  // and `"never"` short-circuits it before it is ever asked). A CSP invariant
  // must not hang on a byte count that the next restyle moves, in either
  // direction. So it is stated instead of inferred.
  //
  // Measured 2026-10-03: the emitted /_astro/Layout.*.css is 6741 B, leaving
  // 6741 - 4096 = 2645 B of headroom under the threshold that used to be the
  // only thing keeping the stylesheet external. global.css is 25344 B of source,
  // but that number never reaches the comparison: 16906 B of it are comments and
  // 8438 B are rules, and those minify to the 6741 B above.
  //
  // The failure mode is not hypothetical. Rebuilt with the stylesheet cut to
  // 3643 B and no `build` block at all, "auto" put an inline <style> into 13/13
  // HTML files, emitted zero <link rel="stylesheet"> and left dist/_astro/ empty
  // -- in production that is every page blocked by style-src 'self' at once.
  // With `"never"` the same 3643 B stylesheet stayed external
  // (/_astro/Layout.DSUcKf8k.css, inline <style> 0/13, <link> 13/13).
  //
  // At today's size the setting changes no output at all: dist/ is byte-identical
  // with and without it (`diff -r` against a build of the previous config). It
  // buys the invariant, not bytes.
  //
  // `"always"` must not come back. It was pinned there for one release -- when
  // designing the post page pushed the stylesheet past the threshold and it
  // silently went external, taking the last inline <style> out of dist/ -- and
  // it is what `style-src 'unsafe-inline'` existed for; dropping that directive
  // and dropping the pin moved in the same commit. The guard on dist/ is
  // admin/test/build/output.test.ts (it scans ../../../site/dist and requires
  // *zero* inline <style>, the reverse of what it once asserted);
  // site/test/build/output.test.ts makes no claim about <style>. The value on
  // this line is pinned by test/unit/stylesheets.test.ts, which also pins
  // build.assets and build.assetsPrefix as unset: CloudFront's immutable
  // /_astro/* behavior is written against astro's default asset directory.
  build: {
    inlineStylesheets: "never",
  },
  markdown: {
    processor: unified(),
  },
});
