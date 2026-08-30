import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@astrojs/markdown-remark";
import { describe, expect, it } from "vitest";

import { POSTS_PER_PAGE } from "../../src/lib/posts.ts";
import { resolveSiteUrl } from "../../src/site-url.ts";

// dist/ is produced once by test/setup/build-site.ts (globalSetup). These tests
// only read it -- they never trigger a build of their own.
const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));

const readDist = (relativePath: string): string =>
  readFileSync(join(distDir, relativePath), "utf8");

// Resolved the same way astro.config.mjs resolves it, so these assertions hold
// whether or not SITE_URL is set for the run -- no environment fixture needed.
const site = resolveSiteUrl(process.env);

/** Every generated .html/.xml under dist/, as paths relative to dist/. */
const collectDistFiles = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    // Build intermediates, not shipped output.
    if (dirent.name === ".prerender") return [];

    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) return collectDistFiles(join(dir, dirent.name), relative);

    return /\.(?:html|xml)$/.test(dirent.name) ? [relative] : [];
  });

// Derived from the fixtures and POSTS_PER_PAGE rather than hard-coded, so that
// changing the page size or adding a post cannot leave these assertions quietly
// asserting the wrong shape.
const postsDir = fileURLToPath(new URL("../../src/content/posts/", import.meta.url));
const publishedCount = readdirSync(postsDir)
  .filter((name) => name.endsWith(".md"))
  .filter((name) => {
    const { frontmatter } = parseFrontmatter(readFileSync(join(postsDir, name), "utf8"));
    return frontmatter.draft !== true;
  }).length;
const expectedPages = Math.ceil(publishedCount / POSTS_PER_PAGE);

describe("404 page", () => {
  // Half of the OAC 403 problem: an S3 REST origin behind OAC answers 403, not
  // 404, for a missing key, so CloudFront needs a 404.html to map both onto. The
  // other half (errorResponses) lives in the CDK workspace.
  it("is generated at dist/404.html", () => {
    expect(existsSync(join(distDir, "404.html"))).toBe(true);
  });

  // build.format defaults to "directory", which would suggest dist/404/index.html.
  // Astro special-cases the status pages instead. This assertion is vacuously true
  // on its own -- it only means anything paired with the one above.
  it("is not emitted as a directory", () => {
    expect(existsSync(join(distDir, "404", "index.html"))).toBe(false);
  });

  it("asks robots not to index it", () => {
    expect(readDist("404.html")).toContain('<meta name="robots" content="noindex">');
  });

  // A 404 is returned for every URL that does not exist, so declaring one of them
  // canonical is meaningless. Writing BaseHead naively emits a canonical of
  // ".../404/", because Astro.url.pathname is "/404/" while building this page.
  it("emits no canonical link", () => {
    expect(readDist("404.html")).not.toContain('rel="canonical"');
  });

  it("goes through the shared layout", () => {
    const html = readDist("404.html");

    expect(html).toContain('<html lang="ja"');
    expect(html).toContain("<title>");
  });
});

describe("shared layout", () => {
  // Only BaseHead emits a canonical link, so its presence is the evidence that a
  // page actually went through the layout rather than carrying its own <html>.
  // The value is asserted too: a canonical that is not absolute is useless.
  it.each([
    ["index.html", ""],
    ["posts/hello-world/index.html", "posts/hello-world/"],
  ])("gives %s an absolute canonical link", (file, path) => {
    expect(readDist(file)).toContain(`<link rel="canonical" href="${site}${path}">`);
  });
});

describe("tag pages", () => {
  it.each(["astro", "nix"])("generates dist/tags/%s/index.html", (tag) => {
    expect(existsSync(join(distDir, "tags", tag, "index.html"))).toBe(true);
  });

  it("lists the published posts carrying the tag", () => {
    const html = readDist("tags/astro/index.html");

    expect(html).toContain("Hello world");
    expect(html).toContain("Second post");
  });

  // Vacuously true on its own, so it only means something beside the assertions
  // above that tag pages get generated at all. draft-post.md carries
  // tags: ["astro", "draft-only"] precisely so that a missing isPublished in
  // getStaticPaths leaves a trace right here.
  it("generates no page for a tag only a draft carries", () => {
    expect(existsSync(join(distDir, "tags", "draft-only", "index.html"))).toBe(false);
  });
});

describe("pagination", () => {
  // Guards every assertion below from being vacuously true: with a single page
  // there is no next/prev link and nothing is split. A failure here means "add
  // fixtures or lower POSTS_PER_PAGE", not "pagination is broken".
  it("has enough published posts to paginate", () => {
    expect(expectedPages).toBeGreaterThan(1);
  });

  it("generates every expected page", () => {
    expect(existsSync(join(distDir, "index.html"))).toBe(true);

    for (let page = 2; page <= expectedPages; page += 1) {
      expect(existsSync(join(distDir, String(page), "index.html"))).toBe(true);
    }
  });

  // Catches both over-slicing and a draft sneaking into the listing.
  it("generates no page past the last one", () => {
    expect(existsSync(join(distDir, String(expectedPages + 1), "index.html"))).toBe(
      false,
    );
  });

  // paginate() hands back "/2" with no trailing slash, while the file it emits is
  // /2/index.html and the sitemap's loc does carry one. withTrailingSlash is what
  // keeps the internal links and the sitemap naming the same URL.
  it("links forward with a trailing slash", () => {
    expect(readDist("index.html")).toContain('rel="next" href="/2/"');
  });

  // ...and back to "/" rather than "//".
  it("links back to the root without doubling the slash", () => {
    expect(readDist("2/index.html")).toContain('rel="prev" href="/"');
  });

  it("splits the posts across the pages", () => {
    expect(readDist("2/index.html")).toContain("Fourth post");
    expect(readDist("index.html")).not.toContain("Fourth post");
  });
});

describe("draft leakage", () => {
  const distFiles = collectDistFiles(distDir);

  it("has output to scan", () => {
    expect(distFiles).toContain("index.html");
    expect(distFiles.length).toBeGreaterThan(1);
  });

  // Written across files rather than per page on purpose. Centralising the draft
  // predicate in src/lib/posts.ts does not stop a page from forgetting to pass it,
  // and this is the only guard that also covers pages that do not exist yet -- it
  // fails naming the offending dist/ file, e.g. ["rss.xml"].
  it("leaves no trace of a draft in any generated file", () => {
    const leaking = distFiles.filter((file) => /Draft post|draft-only/.test(readDist(file)));

    expect(leaking).toEqual([]);
  });
});
