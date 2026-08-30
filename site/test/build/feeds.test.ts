import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveSiteUrl } from "../../src/site-url.ts";

// The machine-readable outputs -- rss.xml, sitemap-*.xml, robots.txt -- all of
// which are built from astro's `site`. dist/ is produced once by
// test/setup/build-site.ts (globalSetup); nothing here triggers a build.
const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));

const readDist = (relativePath: string): string =>
  readFileSync(join(distDir, relativePath), "utf8");

// Resolved exactly as astro.config.mjs resolves it, so these assertions hold with
// or without SITE_URL set for the run.
const site = resolveSiteUrl(process.env);

describe("rss.xml", () => {
  it("is generated at dist/rss.xml", () => {
    expect(existsSync(join(distDir, "rss.xml"))).toBe(true);
  });

  it("points the channel at the configured site", () => {
    expect(readDist("rss.xml")).toContain(`<link>${site}</link>`);
  });

  it.each(["posts/second-post/", "posts/hello-world/"])(
    "gives %s an absolute item link",
    (path) => {
      expect(readDist("rss.xml")).toContain(`<link>${site}${path}</link>`);
    },
  );

  // getCollection() hands entries back in filename order, so leaving out
  // byPubDateDesc yields an oldest-first feed -- and nothing else would notice.
  it("orders items newest first", () => {
    const xml = readDist("rss.xml");
    const newer = xml.indexOf("Second post"); // 2026-08-02
    const older = xml.indexOf("Hello world"); // 2026-08-01

    // Guard both lookups: a missing title would score -1 and satisfy the ordering
    // assertion below for entirely the wrong reason.
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
  });

  it("is advertised for autodiscovery from the listing page", () => {
    expect(readDist("index.html")).toContain(
      `<link rel="alternate" type="application/rss+xml"`,
    );
  });
});

describe("sitemap", () => {
  // Asserted on the files, never on the build log. Without `site`, @astrojs/sitemap
  // logs "The Sitemap integration requires the `site` astro.config option.
  // Skipping." and emits nothing at exit code 0 -- and test/setup/build-site.ts
  // builds at logLevel "error", so that warning never reaches the test output.
  // Lowering the log level to make it visible would be the wrong fix: it would
  // trade a file assertion for a brittle one on a log string.
  it.each(["sitemap-index.xml", "sitemap-0.xml"])("generates dist/%s", (file) => {
    expect(existsSync(join(distDir, file))).toBe(true);
  });

  // Guards against the file existing but being empty, which the assertions above
  // cannot distinguish. One post, one tag page, one paginated page.
  it.each(["posts/second-post/", "tags/astro/", "2/"])("lists %s", (path) => {
    expect(readDist("sitemap-0.xml")).toContain(`<loc>${site}${path}</loc>`);
  });

  // @astrojs/sitemap drops the status pages (its STATUS_CODE_PAGES set). This
  // phase depends on that, so the dependency is written down here.
  it("omits the 404 page", () => {
    const xml = readDist("sitemap-0.xml");

    expect(xml).not.toContain(`${site}404/`);
    expect(xml).not.toContain(`${site}404.html`);
  });

  it("indexes the generated sitemap", () => {
    expect(readDist("sitemap-index.xml")).toContain(`<loc>${site}sitemap-0.xml</loc>`);
  });
});

describe("robots.txt", () => {
  it("is generated at dist/robots.txt", () => {
    expect(existsSync(join(distDir, "robots.txt"))).toBe(true);
  });

  it("allows crawlers", () => {
    expect(readDist("robots.txt")).toContain("User-agent: *");
  });

  // The reason robots.txt is an endpoint rather than a file in public/: the
  // Sitemap directive needs an absolute URL, and the origin is only known at build
  // time. A static file would bake one host into the repository permanently.
  it("points at the sitemap with an absolute URL", () => {
    expect(readDist("robots.txt")).toContain(`Sitemap: ${site}sitemap-index.xml`);
  });
});
