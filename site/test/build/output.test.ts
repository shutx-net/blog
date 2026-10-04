import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSTS_PER_PAGE } from "../../src/lib/posts.ts";

// Reads dist/, built once by test/setup/build-site.ts (globalSetup).
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
  // The contract of a listing entry. A title on its own is not enough to pick a
  // post out of a list.
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

  it("offers a way back to the listing from a post page", () => {
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

describe("post page table of contents", () => {
  const TOC_OPEN = '<nav class="post__toc" aria-label="目次">';

  /**
   * The contents bar of a post page, opening and closing tag included.
   *
   * **Fails rather than returning "" when either tag is missing.** A slice taken
   * from an indexOf of -1 is still a perfectly good string, and every
   * `not.toContain` below would then run against an empty haystack and report
   * success. Same rule as sliceElement in fixed-pages.test.ts and stripPrefix in
   * admin/test/parity/published-html.test.ts: never answer a miss with a value that
   * happens to satisfy the caller.
   *
   * The first `</nav>` after the opening tag is the right one. The bar nests no
   * second landmark inside itself, and the exact match below is what keeps it so.
   */
  const tocHtml = (html: string): string => {
    const open = html.indexOf(TOC_OPEN);
    expect(open, "the contents <nav> is missing").toBeGreaterThan(-1);

    const close = html.indexOf("</nav>", open);
    expect(close, "the contents </nav> is missing").toBeGreaterThan(open);

    return html.slice(open, close + "</nav>".length);
  };

  /** The headings of the rendered body. The post title's own <h1> carries no id. */
  const bodyHeadings = (html: string): string[] => html.match(/<h[1-6] id="/g) ?? [];

  // The whole bar as one string, which pins the nesting, the anchors and the labels
  // at once: the h3 inside its h2's <li>, every href the heading's own slug, every
  // label the heading's own text. The expected value is read off the five headings
  // in test/fixtures/posts/2026/08/01/090000.md and the list semantics a contents
  // has -- neither src/lib/toc.ts nor src/components/PostToc.astro is imported here,
  // because a test that asks the implementation what to expect asserts nothing.
  //
  // One line is the right shape to expect: astro's compressHTML (the default) drops
  // the whitespace-only text nodes between the elements of a .astro template, so the
  // multi-line markup collapses (measured: no newline and no `>\s+<` in the slice).
  it("nests the h3 inside the h2's item and links both by slug", () => {
    expect(tocHtml(readDist("posts/2026/08/01/090000/index.html"))).toBe(
      '<nav class="post__toc" aria-label="目次"><p class="post__toc-title">目次</p><ul>' +
        '<li><a href="#heading-two">Heading two</a>' +
        '<ul><li><a href="#入れ子の見出し">入れ子の見出し</a></li></ul></li>' +
        '<li><a href="#日本語の見出し">日本語の見出し</a></li>' +
        "</ul></nav>",
    );
  });

  // **The bar is a sibling of <article>, not a child** -- the same seal the
  // furniture suite above is written against. A contents inside that element, or an
  // attribute on the tag list naming it, breaks
  // admin/test/parity/published-html.test.ts rather than the layout.
  //
  // Ahead of <article> and not after it, because an index read after the thing it
  // indexes has nothing left to index. That is the reading order and the tab order
  // both. The date comes first of the three, which the furniture suite above already
  // relies on.
  it("puts the table of contents outside <article>, ahead of it", () => {
    const html = readDist("posts/2026/08/01/090000/index.html");
    const at = (needle: string): number => {
      const index = html.indexOf(needle);
      // A missing string would score -1 and satisfy every < below for the wrong
      // reason -- the same guard the listing's ordering assertions carry.
      expect(index, `${needle} is missing from the post page`).toBeGreaterThan(-1);
      return index;
    };

    expect(at("<time")).toBeLessThan(at(TOC_OPEN));
    expect(at(TOC_OPEN)).toBeLessThan(at("<article>"));
  });

  // The depths the contents leaves out, asserted from both sides. The first half --
  // the heading really is in the body -- is what stops the second from passing
  // because the fixture quietly lost it: a `not.toContain` over material that is not
  // there is green and means nothing.
  //
  // Why these two depths and no others: rule 1 of src/lib/toc.ts, pinned by
  // test/unit/toc.test.ts's "takes only h2 and h3". depth 1 is not hypothetical --
  // the published post at /posts/2026/09/27/142621/ carries a body h1.
  it.each([
    { depth: 1, slug: "body-heading-one" },
    { depth: 4, slug: "depth-four" },
  ])(
    "renders the depth-$depth heading in the body and keeps it out of the contents",
    ({ depth, slug }) => {
      const html = readDist("posts/2026/08/01/090000/index.html");

      expect(html).toContain(`<h${depth} id="${slug}">`);
      expect(tocHtml(html)).not.toContain(`href="#${slug}"`);
    },
  );

  // The floor, from the side where nothing is rendered. `post__toc` is the spelling
  // the exact match above shares, so renaming the class turns that assertion red
  // instead of handing these two a free pass.
  //
  // The heading count comes first in both, for the same reason as above: "no
  // contents here" is also true of a page that failed to render its body at all.
  it("omits the contents from a post with a single heading", () => {
    const html = readDist("posts/2026/08/02/090000/index.html");

    expect(bodyHeadings(html)).toHaveLength(1);
    expect(html).not.toContain("post__toc");
  });

  it("omits the contents from a post with no headings", () => {
    const html = readDist("posts/2026/07/31/090000/index.html");

    // The page was generated at all, and its body carries nothing to index.
    expect(html).toContain("<article>");
    expect(bodyHeadings(html)).toEqual([]);
    expect(html).not.toContain("post__toc");
  });

  // **The bar belongs to the post route alone.** PostToc is imported by
  // src/pages/posts/[...slug].astro and by nothing else; moving it into Layout.astro
  // would put it on every page of the site at once, which is what these rows notice.
  //
  // about/ and privacy/ are the two that make the claim mean something. They are
  // rendered from Markdown, wrapped in <article>, and carry <h2> sections of their
  // own -- exactly the material a contents is built from -- and still get none. A
  // profile page is read, not navigated by section.
  it.each(["about/index.html", "privacy/index.html"])(
    "carries no table of contents on %s, which has an <article> with h2 sections",
    (file) => {
      const html = readDist(file);

      expect(html).toContain("<article>");
      expect(html).toMatch(/<h2[ >]/);
      expect(html).not.toContain("post__toc");
    },
  );

  // The listing, a tag page and the tag index render no post body, so here the claim
  // is only that nothing leaked into the chrome every page shares. readDist throws
  // on a missing file, so none of these can pass by not being built.
  it.each(["index.html", "tags/astro/index.html", "tags/index.html"])(
    "carries no table of contents on %s",
    (file) => {
      expect(readDist(file)).not.toContain("post__toc");
    },
  );

  // The slicer's own guard, checked the way published-html.test.ts checks its strip
  // helpers rather than left to a comment. Without it every `not.toContain` over
  // tocHtml(...) above could be satisfied by an empty string.
  it("fails instead of slicing nothing when the nav is absent", () => {
    expect(() => tocHtml("<main>no contents here</main>")).toThrow();
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

// **What CloudFront's `immutable` rests on.** `/_astro/*` is served with
// `Cache-Control: public, max-age=31536000, immutable`
// (ASTRO_ASSETS_CACHE_CONTROL in infra/lib/response-headers.ts), and that is true of
// exactly one kind of URL: one that never comes back with different bytes. vite makes
// it so by putting the content hash in the filename -- edit the stylesheet and the
// next build emits a *different* URL, which the HTML (`no-cache`) is forced to
// revalidate and therefore picks up.
//
// Lose the hash and the declaration becomes a lie that nothing reports. The CDN keeps
// answering with a year either way; the infra tests see a path pattern and a header
// value, both still correct. The day it surfaces is the day someone works out that
// visitors have been looking at a stale stylesheet for weeks.
//
// The complementary guards are on the config: site/test/unit/stylesheets.test.ts pins
// build.assets / build.assetsPrefix / inlineStylesheets as values, and
// infra/test/distribution-assets-behavior.test.ts scans this config as text from the
// CDN's side. Neither looks at a real filename, which is the one thing here that does.
describe("/_astro/ assets carry a content hash", () => {
  const ASSETS_DIR = "_astro";

  // `<name>.<hash>.<ext>` -- the hash being vite's base64url digest, measured as
  // Layout.3W-5Im-W.css. Eight characters is vite's default length; `{8,}` leaves
  // room for a longer one while still refusing a bare `Layout.css`. The character
  // class is deliberately narrow: a dot in the hash would also break
  // infra/functions/rewrite-uri.js, which decides "static file" by looking for a dot
  // after the last slash.
  const HASHED = /\.[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

  const assetNames = (): string[] => readdirSync(join(distDir, ASSETS_DIR));

  /** Every file under dist/, as a path relative to dist/. */
  const distFiles = (dir = ""): string[] =>
    readdirSync(join(distDir, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? distFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    );

  it("emits at least one asset", () => {
    // "every name carries a hash" is also true of no names at all -- and an empty
    // dist/_astro/ is the exact shape `inlineStylesheets: "auto"` produces once the
    // built stylesheet drops below vite's 4096 B assetsInlineLimit (measured at
    // 3643 B: inline <style> in 13/13 pages, zero <link>, empty dist/_astro/).
    expect(assetNames().length).toBeGreaterThan(0);
  });

  it("names every asset <name>.<hash>.<ext>", () => {
    for (const name of assetNames()) {
      expect(name, `${name} carries no content hash`).toMatch(HASHED);
    }
  });

  it("emits exactly one stylesheet", () => {
    // CSS has one entry point: the global.css that Layout.astro imports. Scoped
    // <style> blocks are zero across the site, so a second file here means a new
    // entry point or a new scoped block -- and the question to ask then is whether
    // what used to be shared still is.
    expect(assetNames().filter((name) => name.endsWith(".css"))).toHaveLength(1);
  });

  it("keeps every content-hashed file inside _astro/", () => {
    // `_astro` is astro's `build.assets` default and the CloudFront behavior is
    // written against that literal (`/_astro/*`). Renaming it would move the assets
    // out from under the immutable header while everything kept building and
    // rendering, which is why this walks the whole tree rather than _astro alone.
    const hashed = distFiles().filter((file) => HASHED.test(file));

    expect(hashed.length, "no content-hashed file anywhere in dist/").toBeGreaterThan(0);
    for (const file of hashed) {
      expect(file.startsWith(`${ASSETS_DIR}/`), `${file} sits outside ${ASSETS_DIR}/`).toBe(true);
    }
  });

  it("recognises a hashed name and refuses an unhashed one", () => {
    // The detection rule itself, checked rather than assumed: a regex that matched
    // nothing would hand the assertion above an empty list and a free pass, and the
    // `toBeGreaterThan(0)` guard only catches that once nothing matches at all.
    expect(HASHED.test("Layout.3W-5Im-W.css")).toBe(true);
    expect(HASHED.test("Layout.css"), "a name with no hash segment").toBe(false);
    expect(HASHED.test("Layout.3W-5Im.css"), "a hash segment of only six characters").toBe(false);
    expect(HASHED.test("index.html")).toBe(false);
  });
});
