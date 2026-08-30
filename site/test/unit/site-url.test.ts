import { describe, expect, it } from "vitest";

import config from "../../astro.config.mjs";
import { PLACEHOLDER_SITE_URL, resolveSiteUrl } from "../../src/site-url.ts";

// Everything that needs an absolute URL -- canonical links, rss.xml, sitemap-*.xml
// and robots.txt -- reads astro's `site`. Resolving it in one pure function keeps
// that decision testable without touching process.env: resolveSiteUrl takes the
// environment as an argument precisely so this file (and the build-layer tests)
// can ask for the same answer astro.config.mjs got.

describe("resolveSiteUrl", () => {
  it("falls back to the placeholder when SITE_URL is unset", () => {
    expect(resolveSiteUrl({})).toBe(PLACEHOLDER_SITE_URL);
  });

  it("falls back to the placeholder when SITE_URL is blank", () => {
    expect(resolveSiteUrl({ SITE_URL: "   " })).toBe(PLACEHOLDER_SITE_URL);
  });

  // The production domain is not decided yet, so some build somewhere will ship
  // the fallback. `.invalid` is reserved by RFC 2606 and can never resolve, which
  // makes that mistake visibly broken instead of plausibly wrong. A real domain
  // here would be worse than no domain: RSS <guid isPermaLink="true"> values are
  // permanent subscriber-side identities, so publishing one under the wrong host
  // and moving later re-delivers every post as new, irreversibly.
  it("uses an unresolvable .invalid host as the placeholder", () => {
    expect(new URL(PLACEHOLDER_SITE_URL).hostname.endsWith(".invalid")).toBe(true);
  });

  it("normalises a valid SITE_URL to an origin with a trailing slash", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://blog.example.com" })).toBe(
      "https://blog.example.com/",
    );
  });

  it("drops any path, query or fragment from SITE_URL", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://blog.example.com/sub/?a=1#b" })).toBe(
      "https://blog.example.com/",
    );
  });

  // A typo must not pass silently. Note the asymmetry this guards: an *unset*
  // SITE_URL is fine (the placeholder is unmistakable), but a malformed one would
  // otherwise bake a broken host into the feed and every canonical link.
  it("throws when SITE_URL is not an absolute URL", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "notaurl" })).toThrow(/absolute URL/);
  });

  // CloudFront serves over HTTPS, so an http canonical or feed guid is always wrong.
  it("throws when SITE_URL is not https", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "http://blog.example.com" })).toThrow(/https/);
  });
});

describe("astro config", () => {
  // Pins the wiring, not just the function: without `site` astro.config.mjs would
  // leave config.site undefined, which makes @astrojs/rss fail the build loudly but
  // makes @astrojs/sitemap skip itself silently at exit code 0.
  it("sets site from resolveSiteUrl", () => {
    expect(config.site).toBe(resolveSiteUrl(process.env));
  });

  // Catches a de-registered integration in the ~1s unit loop rather than only in
  // the build layer. Worth pinning here because losing the sitemap integration is
  // silent: it warns and emits nothing, at exit code 0.
  it("registers the sitemap integration", () => {
    const names = (config.integrations ?? []).flat().map((integration) => integration.name);

    expect(names).toContain("@astrojs/sitemap");
  });

  it("resolves to the placeholder when the test run has no SITE_URL", () => {
    // The precondition is asserted rather than skipped on: if a SITE_URL ever
    // leaks into a test run this fails naming the cause, instead of quietly
    // turning into a vacuous assertion.
    expect(process.env.SITE_URL ?? "").toBe("");
    expect(config.site).toBe(PLACEHOLDER_SITE_URL);
  });
});
