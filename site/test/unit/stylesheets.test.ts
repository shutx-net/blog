import { describe, expect, it } from "vitest";

import config from "../../astro.config.mjs";
import { defined } from "../support/defined.ts";

// Pins how stylesheets are delivered, at the config level, because that is the only
// level where it is stated. The complementary guard -- admin/test/build/output.test.ts,
// which scans site/dist and requires *zero* inline <style> -- cannot see this
// declaration go missing. Under the default "auto" that scan stays green until the
// built stylesheet actually drops below vite's 4096 B assetsInlineLimit, which is
// 2645 B away (measured: /_astro/Layout.*.css is 6741 B). It sees the consequence, a
// restyle later, and the consequence is every page in dist/ unstyled at once.
describe("stylesheet build configuration", () => {
  it('declares build.inlineStylesheets as "never"', () => {
    // `defined()` rather than optional chaining so deleting the whole `build` block
    // fails by naming what is gone instead of reporting `undefined !== "never"`.
    const build = defined(config.build, "config.build");

    // "auto" (or no value) makes the decision depend on size again, and the page is
    // served under `style-src 'self'`, which refuses an inline <style> outright.
    // Measured with the built stylesheet cut to 3643 B: "auto" gave inline <style>
    // 13/13 HTML files, zero <link rel="stylesheet">, and an empty dist/_astro/.
    // "always" is worse still -- it is what 'unsafe-inline' used to be granted for.
    expect(build.inlineStylesheets).toBe("never");
  });

  // The next two assert an *absence*, which an absent `build` block satisfies, so
  // they read through `?.` rather than `defined()`. Deleting the block is the first
  // assertion's business alone -- measured: with the block removed, `defined()` in
  // all three made all three red with "config.build is not defined", which buries
  // the one decision that actually broke under two that did not.
  it("leaves build.assets at astro's default (_astro)", () => {
    // Unset means `_astro` (astro/dist/core/config/schemas/defaults.js). CloudFront
    // serves `/_astro/*` with `immutable` on the strength of that default, which is
    // true only because the filenames under it carry vite's content hash. Renaming
    // the directory here moves every asset out from under that behavior, and they
    // fall back to the site's `no-cache` with nothing going red.
    expect(config.build?.assets).toBeUndefined();
  });

  it("leaves build.assetsPrefix unset (assets stay same-origin)", () => {
    // A prefix rewrites the references to another origin, which is exactly what
    // both `style-src 'self'` and the `/_astro/*` behavior are written against.
    expect(config.build?.assetsPrefix).toBeUndefined();
  });

  // The two assertions above are doubled by a text scan on the infra side, which
  // reads site/astro.config.mjs and pins the literal '/_astro/*' against it.
  // Neither subsumes the other: these read the value the module actually exports
  // (so a `build` block assembled or spread in still resolves), while the scan is
  // what ties the CDN's declaration to this config at all.
});
