import { getRssString } from "@astrojs/rss";
import { describe, expect, it } from "vitest";

import { PLACEHOLDER_SITE_URL } from "../../src/site-url.ts";

// getRssString is the pure half of @astrojs/rss and is exported for exactly this:
// the feed generation rules can be pinned without starting astro. What the build
// layer then has to prove is only that the endpoint feeds it the right posts.

const feed = {
  title: "blog",
  description: "shutx-net の個人ブログ。",
  site: PLACEHOLDER_SITE_URL,
  items: [
    {
      title: "A post",
      description: "A description.",
      pubDate: new Date("2026-08-01"),
      link: "/posts/p/",
    },
  ],
};

describe("getRssString", () => {
  // Item links are written root-relative and resolved against `site` here, which
  // is why the endpoint does not have to build absolute URLs itself.
  it("resolves a relative item link against site", async () => {
    expect(await getRssString(feed)).toContain(
      `<link>${PLACEHOLDER_SITE_URL}posts/p/</link>`,
    );
  });

  // The load-bearing asymmetry behind this whole phase: with no `site`, RSS fails
  // the build outright while @astrojs/sitemap merely warns and emits nothing at
  // exit code 0. The feed is what makes a missing `site` impossible to miss.
  it("fails when site is missing", async () => {
    await expect(getRssString({ ...feed, site: undefined })).rejects.toThrow(/site/);
  });
});
