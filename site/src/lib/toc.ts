// The table of contents model: which of a post's headings become entries, how they
// nest, and when a post has enough structure to be worth a contents bar at all.
//
// Zero imports, for the same reason lib/posts.ts refuses `astro:content`: plain vitest
// can load this file, so the four rules below are pinned by test/unit/toc.test.ts
// rather than by looking at a built page. Whatever renders the bar only walks what
// comes back -- no filtering, no counting and no depth arithmetic in a template, where
// nothing would test it.

/**
 * What the contents needs from a heading. Structural, so the MarkdownHeading values
 * `render(post)` hands back satisfy it unchanged and the tests can pass literals --
 * the same split lib/posts.ts uses for PostEntry.
 *
 * `text` is already plain text: astro strips the inline markup out of it (measured,
 * "### `code` and **bold** and [link](...)" yields text "code and bold and link"), so
 * an entry can print it as it is.
 */
export type TocHeading = { depth: number; slug: string; text: string };

/** One top-level entry of the contents, and the h3s that sit under it. */
export type TocSection = { heading: TocHeading; children: TocHeading[] };

/** `<h2>`: a section of the post, and a top-level entry. */
const SECTION_DEPTH = 2;

/** `<h3>`: nested under the h2 it follows. */
const SUBSECTION_DEPTH = 3;

/**
 * The floor, counted in headings rather than sections -- an h2 with a single h3 under
 * it is two headings and clears it.
 *
 * Deliberately NOT exported. A caller that imported it to decide whether to render
 * anything would be re-deriving the rule from the same constant, and a test that
 * imported it would be asserting the implementation against itself. Both ask
 * `buildToc(...).length > 0` instead.
 */
const MINIMUM_HEADINGS = 2;

/**
 * The headings of one post, as the contents bar should show them.
 *
 * 1. Only h2 and h3 become entries ("takes only h2 and h3"). A depth-1 heading in the
 *    body is a *second* h1 -- `<article>` already opens with the post title as its h1
 *    -- so it is the title's sibling, not one of its sections. From h4 down a heading
 *    is no longer a landmark a reader navigates by: global.css leaves `article h4` at
 *    the body font size, and in a bar a fraction of the body's width those headings
 *    wrap to three lines each.
 *
 * 2. A heading whose slug is empty is dropped ("drops an h2 whose slug is empty"). It
 *    happens: github-slugger strips punctuation-only text down to nothing, so
 *    `## ：：：` renders as `<h2 id="">` (measured). `href="#"` does not scroll to that
 *    heading, it jumps to the top of the document -- an entry that quietly lies is
 *    worse than a missing one.
 *
 * 3. An h3 nests under the h2 above it; one with no h2 above it becomes its own
 *    top-level entry ("promotes h3s with no h2 above them") rather than being dropped,
 *    which would leave the heading in the body and absent from the contents. Two such
 *    h3s in a row are siblings in the document, so they become two entries and the
 *    check below asks "is the open section an h2?" and not "is a section open?".
 *
 * 4. Below MINIMUM_HEADINGS entries the answer is `[]` ("returns nothing for a lone
 *    h2"). A one-entry contents is a link to the only section of the post, which the
 *    reader reaches by scrolling once; it spends a column of the viewport to say
 *    nothing.
 *
 * Neither the given array nor the heading objects are modified -- `render(post).headings`
 * is astro's own array, and anything else on the page reading it sees the same one. The
 * sections hold those heading objects by reference; only the arrays here are new.
 */
export const buildToc = (headings: readonly TocHeading[]): TocSection[] => {
  const entries = headings.filter(
    (heading) =>
      (heading.depth === SECTION_DEPTH || heading.depth === SUBSECTION_DEPTH) &&
      heading.slug !== "",
  );

  // Rules 1 and 2 run before the floor, so what gets counted is what would be shown.
  if (entries.length < MINIMUM_HEADINGS) return [];

  const sections: TocSection[] = [];
  for (const heading of entries) {
    // `at(-1)`, not `[length - 1]`: this tsconfig sets no noUncheckedIndexedAccess, so
    // the index form would be typed TocSection and rule 3's `else` would need a
    // non-null assertion on an element genuinely absent for the first heading.
    const open = sections.at(-1);

    if (heading.depth === SUBSECTION_DEPTH && open?.heading.depth === SECTION_DEPTH) {
      open.children.push(heading);
    } else {
      sections.push({ heading, children: [] });
    }
  }

  return sections;
};
