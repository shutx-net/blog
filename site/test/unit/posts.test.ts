import { describe, expect, it } from "vitest";

import type { PostData, PostEntry } from "../../src/lib/posts.ts";
import {
  POSTS_PER_PAGE,
  byPubDateDesc,
  collectTags,
  formatPubDate,
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

describe("formatPubDate", () => {
  it("writes the date the way a Japanese reader expects", () => {
    expect(formatPubDate(new Date("2026-09-08T05:40:01.000Z"))).toBe("2026年9月8日");
  });

  // A date-only frontmatter value parses as UTC midnight, which is 09:00 JST the
  // same day -- the displayed date must not slip backwards for those.
  it("keeps a date-only pubDate on its own day", () => {
    expect(formatPubDate(new Date("2026-08-01"))).toBe("2026年8月1日");
  });

  // The month and day are not zero-padded, matching how the date is written in
  // Japanese prose.
  it("does not pad the month or the day", () => {
    expect(formatPubDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026年1月5日");
  });

  // The whole reason the offset is applied by hand. 15:00 UTC is already the next
  // day in Tokyo, so a build running in CI (UTC) and one running on the author's
  // machine have to agree that this is the 1st, not the 31st.
  it("rolls over to the next day at 15:00 UTC", () => {
    expect(formatPubDate(new Date("2026-12-31T14:59:59.000Z"))).toBe("2026年12月31日");
    expect(formatPubDate(new Date("2026-12-31T15:00:00.000Z"))).toBe("2027年1月1日");
  });

  // CI builds under UTC and the author's machine does not, so the rendered date
  // must not move with the process timezone.
  it("does not depend on the process timezone", () => {
    const instant = new Date("2026-09-08T05:40:01.000Z");
    const previous = process.env.TZ;

    try {
      // Read local hours either side of the change, so this test fails rather
      // than passing vacuously if TZ ever stops taking effect mid-process (which
      // would make the comparison below prove nothing).
      process.env.TZ = "UTC";
      const utcHours = instant.getHours();
      process.env.TZ = "America/Los_Angeles";
      const laHours = instant.getHours();

      expect(utcHours, "TZ no longer takes effect; this test proves nothing").not.toBe(
        laHours,
      );
      expect(formatPubDate(instant)).toBe("2026年9月8日");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
