import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Reads dist/, built once by test/setup/build-site.ts (globalSetup).
const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));

const readDist = (relativePath: string): string =>
  readFileSync(join(distDir, relativePath), "utf8");

// The fixed pages, by the only two facts about them that are structural.
//
// **The prose is deliberately absent from this table.** Both pages currently ship
// a placeholder that says outright that it is one, and replacing that text is the
// next thing that is supposed to happen to them. Pinning any of it would make the
// rewrite arrive as a failing build, which teaches whoever does it that the way
// past this file is to delete assertions from it -- so what is pinned here is
// structure, and only structure. The heading is not an exception to that: it is
// the page's identity rather than its content, it is the string Layout is handed
// as `title` and BaseHead re-emits as og:title, and changing it means this is a
// different page. There is no third field, on purpose.
const FIXED_PAGES = [
  { path: "about/", heading: "プロフィール" },
  { path: "privacy/", heading: "プライバシーポリシー" },
] as const;

describe("fixed pages", () => {
  // build.format is "directory", so about.astro is emitted as about/index.html --
  // which is also why every URL naming these pages carries a trailing slash.
  //
  // Nothing else in the repository would notice if one stopped being emitted. They
  // are not entries in the posts collection, so the corpus-derived floors in
  // pages.test.ts do not count them, and deploy.yml's three guards read
  // site/dist/posts alone. A page that quietly stopped building would deploy green.
  it.each(FIXED_PAGES)("emits an index.html for $path", ({ path }) => {
    expect(existsSync(join(distDir, path, "index.html"))).toBe(true);
  });

  it.each(FIXED_PAGES)("gives $path an <h1> naming the page", ({ path, heading }) => {
    expect(readDist(`${path}index.html`)).toContain(`<h1>${heading}</h1>`);
  });

  // **The <article> wrapper is load-bearing, and this is the only thing guarding
  // it.** Every prose rule in global.css -- `article > h1`, the ruled `article h2`,
  // the paragraph rhythm, lists, blockquotes, tables -- is selected from that
  // element. What is styled outside it is `main > h1` and `main > p` and nothing
  // else, because the listing, the 404 and the tag index never needed more. Unwrap
  // these pages and the h2 sections under the heading render as unstyled prose.
  //
  // That failure is purely visual, which is exactly why it needs an assertion: the
  // page still exists, still carries its canonical link and its og:url, still has
  // its heading, and no test in any workspace parses CSS. Nothing would go red.
  it.each(FIXED_PAGES)("wraps $path in an <article> so its prose is styled", ({ path }) => {
    expect(readDist(`${path}index.html`)).toContain("<article>");
  });

  // The body comes from src/content/pages/*.md, so this is what notices the page
  // shipping as a heading alone: a route that stopped rendering <Content /> still
  // emits its index.html, its <h1> and its <article>. Structure again, not prose --
  // any real text will have at least one section.
  it.each(FIXED_PAGES)("renders the Markdown body of $path", ({ path }) => {
    expect(readDist(`${path}index.html`)).toMatch(/<h2[ >]/);
  });

  // These pages are reached from the footer, the smallest link on the page, so a
  // reader who follows one lands somewhere with no obvious way on. The class is
  // pinned and not just the href: the back arrow is drawn by global.css's
  // `.post__back a:first-child::before`, so a differently-named wrapper still
  // links home but stops looking like the way home. Same string the post page and
  // the tag page are held to, in output.test.ts and pages.test.ts.
  it.each(FIXED_PAGES)("offers a way back to the listing from $path", ({ path }) => {
    expect(readDist(`${path}index.html`)).toContain('<nav class="post__back"><a href="/">');
  });
});

describe("site chrome links", () => {
  /**
   * The one `<tag ...>` ... `</tag>` pair in dist/index.html, opening tag included.
   *
   * **Fails rather than returning "" when either tag is missing.** A slice taken
   * from an indexOf of -1 is still a perfectly good string, and every assertion
   * below would then run against an empty haystack and report success. That is the
   * accident admin/test/parity/published-html.test.ts keeps out with stripPrefix,
   * written down there as: do not return the original string on no match.
   */
  const sliceElement = (html: string, tag: string): string => {
    const open = html.indexOf(`<${tag}`);
    const close = html.indexOf(`</${tag}>`);

    expect(open, `<${tag}> is missing from dist/index.html`).toBeGreaterThan(-1);
    expect(close, `</${tag}> is missing from dist/index.html`).toBeGreaterThan(open);

    return html.slice(open, close);
  };

  /**
   * Every root-relative href in the header and the footer of the listing page.
   *
   * Read out of dist/ rather than listed, so a link added to Layout.astro later is
   * covered by "resolves every one of them" below without anyone remembering to
   * come back here. The header and the footer are the two parts of Layout that
   * appear on every page of the site, which is what makes them worth singling out.
   *
   * Only `href="/..."` is collected -- `#main` is the skip link and answers a
   * different question, and there is nothing external in the chrome yet. One added
   * would fall out of the set assertion below rather than be silently ignored.
   */
  const chromeLinks = (): string[] => {
    const html = readDist("index.html");
    const chrome = sliceElement(html, "header") + sliceElement(html, "footer");

    return [...chrome.matchAll(/href="(\/[^"]*)"/g)].map(([, href]) => href).sort();
  };

  // A literal, while Layout.astro writes its three footer hrefs as literals too --
  // and that duplication is the design. The two sides have to be derived
  // independently or the comparison proves nothing: a shared list of fixed pages
  // in src/lib, read by the layout and by this file, would move both sides in the
  // same commit and stay green. That is the principle at the top of
  // admin/test/support/site-renderer.ts. The agreement between the layout and this
  // literal is confirmed through dist/, which neither side can edit.
  const EXPECTED_CHROME_LINKS = ["/", "/about/", "/privacy/", "/rss.xml"];

  it("links exactly /, /about/, /privacy/ and /rss.xml", () => {
    // Both sides sorted, because the claim is about the set and not the order.
    expect(chromeLinks()).toEqual([...EXPECTED_CHROME_LINKS].sort());
  });

  /**
   * The file CloudFront would serve for `href`, as a path under dist/.
   *
   * The first of the two rules in infra/functions/rewrite-uri.js: a URI ending in
   * `/` gets `index.html` appended. Its second rule -- append `/index.html` when
   * the last segment carries no dot -- is deliberately not reimplemented here. The
   * set assertion above holds the chrome to trailing slashes, which is the spelling
   * the canonical link and the sitemap's <loc> already use, so a slashless
   * `/about` has to be a miss rather than a pass: it does resolve in production,
   * and that is the problem -- it is a second URL naming one page.
   */
  const distPathFor = (href: string): string => {
    const relative = href.slice(1);

    return relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
  };

  /**
   * Whether `href` lands on a file CloudFront could actually serve.
   *
   * **statSync().isFile(), not existsSync().** Measured: existsSync("dist/about")
   * is true, because about/ is a directory -- so on existsSync alone a footer href
   * of `/about` resolves to the directory and passes, which is precisely the
   * second-spelling case distPathFor is written to reject. throwIfNoEntry: false
   * because a missing path is the answer here, not an exception.
   */
  const resolvesToFile = (href: string): boolean =>
    statSync(join(distDir, distPathFor(href)), { throwIfNoEntry: false })?.isFile() ?? false;

  // **The only assertion anywhere that the chrome's links go somewhere.** The
  // footer comes from Layout.astro, so it is on every page of the site: one href
  // naming a path the build does not emit is not a broken link, it is a route to a
  // 404 from every page at once. In production it reads worse than a typo -- S3
  // behind OAC answers 403 for a missing key and CloudFront maps that onto
  // 404.html, so a dead footer link surfaces as what looks like an outage.
  //
  // Nothing upstream of this catches it: the hrefs are literals in a template,
  // astro does not resolve internal links, and deploy.yml's guards compare post
  // slugs. `/` and `/rss.xml` between them exercise both branches of distPathFor,
  // so it cannot be a no-op that happens to work for directories.
  it("resolves every one of them to a file in dist", () => {
    const links = chromeLinks();

    // Guards the filter below from being vacuously true. sliceElement already fails
    // on a missing <header> or <footer>; what is left is a chrome that is present
    // but holds no links at all, where filter() returns [] and reports success.
    // "links exactly the paths..." above is the stronger companion to this floor.
    expect(links.length).toBeGreaterThan(0);

    const dead = links.filter((href) => !resolvesToFile(href));

    // Named rather than counted, so a failure says which link died.
    expect(dead).toEqual([]);
  });

  // The pager set the precedent with aria-label="ページ送り", and this nav needs a
  // label more than the pager does: it is on every page, so on a post page it is
  // one of three <nav> landmarks, and an unlabelled one is offered to a screen
  // reader as a bare "navigation" in the list it builds of them.
  it("gives the footer nav an aria-label", () => {
    expect(sliceElement(readDist("index.html"), "footer")).toContain('aria-label="サイト情報"');
  });
});
