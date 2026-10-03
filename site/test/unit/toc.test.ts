import { describe, expect, it } from "vitest";

import type { TocHeading } from "../../src/lib/toc.ts";
import { buildToc } from "../../src/lib/toc.ts";

// src/lib/toc.ts keeps the depths and the floor module-private, so every expectation
// below is a literal. That is the point: importing the constant and asserting against
// it would compare the implementation with itself rather than with a decision.
//
// TocHeading is structural, so these literals are the same shape astro's
// MarkdownHeading has -- `{ depth, slug, text }` and nothing else.
const h = (depth: number, slug: string, text = slug): TocHeading => ({ depth, slug, text });

describe("buildToc", () => {
  it("makes one childless section per h2", () => {
    expect(buildToc([h(2, "first"), h(2, "second")])).toEqual([
      { heading: h(2, "first"), children: [] },
      { heading: h(2, "second"), children: [] },
    ]);
  });

  it("nests the h3s under the h2 above them, in document order", () => {
    expect(buildToc([h(2, "section"), h(3, "one"), h(3, "two")])).toEqual([
      { heading: h(2, "section"), children: [h(3, "one"), h(3, "two")] },
    ]);
  });

  it("closes the children of an h2 at the next h2", () => {
    expect(buildToc([h(2, "first"), h(3, "nested"), h(2, "second")])).toEqual([
      { heading: h(2, "first"), children: [h(3, "nested")] },
      { heading: h(2, "second"), children: [] },
    ]);
  });

  // h1 is the post title's own level (<article> already opens with one) and h4 is left
  // at the body font size, so neither is a landmark to navigate by. Padded with two real
  // entries so the result is non-empty: asserting absence against [] would also pass if
  // the depth filter vanished and the floor did all the work.
  it("takes only h2 and h3", () => {
    expect(
      buildToc([
        h(1, "second-title"),
        h(2, "section"),
        h(4, "aside"),
        h(3, "nested"),
        h(6, "deepest"),
      ]),
    ).toEqual([{ heading: h(2, "section"), children: [h(3, "nested")] }]);
  });

  // Dropping these would leave the heading in the body and out of the contents. Two in a
  // row are siblings in the document, so neither nests inside the other.
  it("promotes h3s with no h2 above them to their own sections", () => {
    expect(buildToc([h(3, "one"), h(3, "two")])).toEqual([
      { heading: h(3, "one"), children: [] },
      { heading: h(3, "two"), children: [] },
    ]);
  });

  it("gives the h3s after a promoted h3 to the h2 that opened in between", () => {
    expect(buildToc([h(3, "promoted"), h(2, "section"), h(3, "nested")])).toEqual([
      { heading: h(3, "promoted"), children: [] },
      { heading: h(2, "section"), children: [h(3, "nested")] },
    ]);
  });

  it("returns nothing for a post with no headings at all", () => {
    expect(buildToc([])).toEqual([]);
  });

  it("returns nothing when no heading is of a depth it takes", () => {
    expect(buildToc([h(1, "second-title"), h(4, "aside")])).toEqual([]);
  });

  // The low end of the floor. One entry links to the only section of the post, which the
  // reader reaches by scrolling once.
  it("returns nothing for a lone h2", () => {
    expect(buildToc([h(2, "only")])).toEqual([]);
  });

  // ...and the first value above it, which is why the floor counts headings rather than
  // sections: this is one section, and it is shown.
  it("shows an h2 carrying a single h3", () => {
    expect(buildToc([h(2, "section"), h(3, "nested")])).toEqual([
      { heading: h(2, "section"), children: [h(3, "nested")] },
    ]);
  });

  // Five headings it does not take plus one it does is still one entry.
  it("does not count the depths it skips towards the floor", () => {
    expect(
      buildToc([
        h(1, "a"),
        h(1, "b"),
        h(1, "c"),
        h(1, "d"),
        h(1, "e"),
        h(2, "only"),
      ]),
    ).toEqual([]);
  });

  // Measured: a punctuation-only heading such as `## ：：：` comes back with slug "" and
  // renders as <h2 id="">, and `href="#"` jumps to the top of the document instead of to
  // the heading.
  it("drops an h2 whose slug is empty", () => {
    expect(buildToc([h(2, "first"), h(2, "", "：：："), h(2, "second")])).toEqual([
      { heading: h(2, "first"), children: [] },
      { heading: h(2, "second"), children: [] },
    ]);
  });

  it("drops an h3 whose slug is empty instead of nesting it", () => {
    expect(buildToc([h(2, "first"), h(3, "", "：：："), h(2, "second")])).toEqual([
      { heading: h(2, "first"), children: [] },
      { heading: h(2, "second"), children: [] },
    ]);
  });

  // The drop happens before the count, so three headings in the document can still be
  // one entry -- and one entry is none.
  it("returns nothing when dropping empty slugs leaves a single heading", () => {
    expect(buildToc([h(2, "kept"), h(2, "", "：：："), h(3, "", "……")])).toEqual([]);
  });

  // render(post).headings is astro's own array and the sections hold its heading objects
  // by reference, so sorting or splicing it in here would be felt by whatever else on the
  // page reads it.
  it("does not modify the array it is given", () => {
    const headings = [
      h(3, "promoted"),
      h(2, "section"),
      h(1, "second-title"),
      h(3, "nested"),
    ];
    const before = headings.map((heading) => ({ ...heading }));

    const toc = buildToc(headings);

    // A function that returned [] without reading the input would also leave it
    // untouched, so say out loud that this call did something first.
    expect(
      toc,
      "buildToc returned nothing, so the comparison below would prove nothing",
    ).toHaveLength(2);
    expect(headings).toEqual(before);
  });
});
