import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSTS_PER_PAGE } from "../../src/lib/posts.ts";

// dist/ is produced once by test/setup/build-site.ts (globalSetup). These tests
// only read it -- they never trigger a build of their own.
const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));

const readDist = (relativePath: string): string =>
  readFileSync(join(distDir, relativePath), "utf8");

describe("listing page", () => {
  it("is generated at dist/index.html", () => {
    expect(readDist("index.html")).toContain("<html");
  });

  it("links to every published post", () => {
    const html = readDist("index.html");

    expect(html).toContain('href="/posts/2026/08/01/090000/"');
    expect(html).toContain('href="/posts/2026/08/02/090000/"');
  });
});

describe("listing entries", () => {
  // The listing used to print nothing but the title, which is not enough to pick
  // a post out of a list. These four assertions are the contract of an entry.
  const listing = (): string => readDist("index.html");

  it("prints the published date as a machine-readable <time>", () => {
    // The fixture carries `pubDate: 2026-08-02`, which parses as UTC midnight.
    expect(listing()).toContain('<time datetime="2026-08-02T00:00:00.000Z">');
    expect(listing()).toContain("2026年8月2日");
  });

  // description is required by postSchema, so a listing that omits it wastes a
  // field every post is forced to fill in.
  it("prints the description", () => {
    expect(listing()).toContain("A second published post, newer than the first.");
  });

  it("links the tags of each entry", () => {
    const html = listing();

    expect(html).toContain('href="/tags/astro/"');
    expect(html).toContain('href="/tags/nix/"');
  });

  // One date per entry, not one for the page. Counted rather than matched with a
  // nested-tag regex: the tag chips are a <ul><li> inside each entry, so any
  // non-greedy /<li>.*?<\/li>/ closes on a chip and slices the entry in half.
  it("prints one date per entry on the page", () => {
    const dates = listing().match(/<time datetime="/g) ?? [];

    expect(dates).toHaveLength(POSTS_PER_PAGE);
  });

  // ...and each date belongs to the entry it precedes. Interleaving is what proves
  // that: a single page-level date, or dates collected into one block, satisfies
  // "one per entry" but not this.
  it("pairs each date with the title that follows it", () => {
    const html = listing();
    const at = (needle: string): number => {
      const index = html.indexOf(needle);
      // A missing string would score -1 and satisfy every < below for the wrong
      // reason.
      expect(index, `${needle} is missing from the listing`).toBeGreaterThan(-1);
      return index;
    };

    expect(at("2026年8月2日")).toBeLessThan(at("Second post"));
    expect(at("Second post")).toBeLessThan(at("2026年8月1日"));
    expect(at("2026年8月1日")).toBeLessThan(at("Hello world"));
  });
});

describe("post pages", () => {
  // astro's build.format defaults to "directory", so each post lands at
  // /posts/<id>/index.html rather than /posts/<id>.html. The id is the date path
  // the slug already is, so the directory is four levels deep.
  it.each(["2026/08/01/090000", "2026/08/02/090000"])("generates dist/posts/%s/index.html", (id) => {
    expect(existsSync(join(distDir, "posts", id, "index.html"))).toBe(true);
  });

  // This asserts the Markdown body is rendered into the page at all -- it is NOT
  // evidence that the unified processor is in use. Satteri emits identical HTML
  // here; only test/unit/markdown.test.ts can tell the two processors apart.
  it("renders the markdown body into the page", () => {
    const html = readDist("posts/2026/08/01/090000/index.html");

    expect(html).toContain('<h2 id="heading-two">Heading two</h2>');
    expect(html).toContain("<del>struck</del>");
  });
});

describe("post page furniture", () => {
  // The date, the back link and the site chrome all live OUTSIDE <article>,
  // because admin/test/parity/published-html.test.ts byte-compares the inner HTML
  // of that element against the admin preview. These assertions pin the parts a
  // restyle is allowed to move; the parity suite pins the part it is not.
  it("prints the published date as a machine-readable <time>", () => {
    const html = readDist("posts/2026/08/01/090000/index.html");

    // The fixture carries `pubDate: 2026-08-01`, which parses as UTC midnight --
    // and is what its slug is derived from.
    expect(html).toContain('<time datetime="2026-08-01T00:00:00.000Z">');
    expect(html).toContain("2026年8月1日");
  });

  it("keeps the date outside <article>", () => {
    const html = readDist("posts/2026/08/01/090000/index.html");
    const time = html.indexOf("<time");
    const article = html.indexOf("<article>");

    expect(time).toBeGreaterThan(-1);
    expect(article).toBeGreaterThan(-1);
    expect(time).toBeLessThan(article);
  });

  it("offers a way back to the listing", () => {
    expect(readDist("posts/2026/08/01/090000/index.html")).toContain(
      '<nav class="post__back"><a href="/">',
    );
  });

  // The tag list has to stay the last child of <article> and carry no class:
  // global.css selects it structurally, and the parity suite strips it off the
  // end by exact string. Wrapping or classing it breaks both at once.
  it("ends the article with a bare tag list", () => {
    expect(readDist("posts/2026/08/01/090000/index.html")).toContain(
      '<ul><li><a href="/tags/astro/">astro</a></li></ul></article>',
    );
  });
});

describe("drafts", () => {
  // The filter has to sit in getStaticPaths, not just in the listing: a page that
  // is merely unlinked still gets published to S3 and is reachable by URL.
  it("generates no page for a draft post", () => {
    expect(existsSync(join(distDir, "posts", "2026/08/03/090000", "index.html"))).toBe(false);
  });

  it("keeps drafts out of the listing", () => {
    expect(readDist("index.html")).not.toContain("Draft post");
  });
});

describe("listing order", () => {
  it("lists posts newest first", () => {
    const html = readDist("index.html");
    const newer = html.indexOf("Second post"); // 2026-08-02
    const older = html.indexOf("Hello world"); // 2026-08-01

    // Guard both lookups: without this, a missing title would score -1 and the
    // ordering assertion below would pass for the wrong reason.
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
  });
});
