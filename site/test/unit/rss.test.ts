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
    // **型を意図的に破っている。** `site` は `string | URL` で `undefined` を受け付けない
    // ので、型のまま書くとこのケースは書けない。だが検証したいのは**型が止められない
    // 経路**のほう — astro.config.mjs が `site` を落とせば、実行時に `undefined` が
    // ここへ来る。キャストは引数 1 個に閉じ込め、feed 本体の型は保つ。
    const withoutSite = { ...feed, site: undefined } as unknown as Parameters<
      typeof getRssString
    >[0];

    await expect(getRssString(withoutSite)).rejects.toThrow(/site/);
  });
});
