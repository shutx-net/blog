import { describe, expect, it } from "vitest";

import type { PostData, PostEntry } from "../../src/lib/posts.ts";
import {
  POSTS_PER_PAGE,
  byPubDateDesc,
  collectTags,
  isPublished,
  withTrailingSlash,
} from "../../src/lib/posts.ts";

// src/lib/posts.ts deliberately does not import `astro:content`, which is what
// lets plain vitest import it at all (the virtual module silently yields an empty
// Map here). getCollection() stays on the page side; only the predicates move.

const entry = (data: Partial<PostData> = {}): PostEntry => ({
  data: {
    title: "A post",
    description: "A description.",
    pubDate: new Date("2026-08-01"),
    draft: false,
    tags: [],
    ...data,
  },
});

describe("isPublished", () => {
  it("rejects drafts", () => {
    expect(isPublished(entry({ draft: true }))).toBe(false);
  });

  it("accepts published posts", () => {
    expect(isPublished(entry({ draft: false }))).toBe(true);
  });
});

describe("byPubDateDesc", () => {
  it("sorts newest first", () => {
    const older = entry({ title: "older", pubDate: new Date("2026-08-01") });
    const newer = entry({ title: "newer", pubDate: new Date("2026-08-02") });

    const sorted = [older, newer].sort(byPubDateDesc).map((post) => post.data.title);

    expect(sorted).toEqual(["newer", "older"]);
  });
});

describe("collectTags", () => {
  it("deduplicates tags and sorts them", () => {
    const posts = [entry({ tags: ["nix", "astro"] }), entry({ tags: ["astro", "aws"] })];

    expect(collectTags(posts)).toEqual(["astro", "aws", "nix"]);
  });

  it("returns nothing for posts with no tags", () => {
    expect(collectTags([entry()])).toEqual([]);
  });
});

describe("withTrailingSlash", () => {
  // paginate() hands back "/2" and "/" -- no trailing slash -- while the emitted
  // files are /2/index.html and the sitemap's loc values do carry one. Normalising
  // in one place keeps internal links and the sitemap agreeing on a single URL.
  it("appends a slash to a bare path", () => {
    expect(withTrailingSlash("/2")).toBe("/2/");
  });

  // Idempotence matters most at the root: astro 7.1's paginate `format` option
  // turns "/" into "//" for page 1, which is why this helper exists instead.
  it("leaves an already-slashed path alone", () => {
    expect(withTrailingSlash("/")).toBe("/");
  });
});

describe("POSTS_PER_PAGE", () => {
  it("is an integer greater than one", () => {
    expect(Number.isInteger(POSTS_PER_PAGE)).toBe(true);
    expect(POSTS_PER_PAGE).toBeGreaterThan(1);
  });
});
