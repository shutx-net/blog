import type { APIContext } from "astro";
import rss from "@astrojs/rss";
import { getCollection } from "astro:content";

import { byPubDateDesc, isPublished } from "../lib/posts.ts";

// The feed is the least forgiving consumer of astro's `site`: <guid
// isPermaLink="true"> is a permanent, subscriber-side identity for each item, so
// a wrong origin here cannot be taken back -- moving domains later re-delivers
// every post as new. It is also the only consumer that fails the build when
// `site` is missing, which is what stops that mistake from shipping quietly.
export async function GET(context: APIContext): Promise<Response> {
  // isPublished matters more here than anywhere else: a draft leaked into the
  // feed is pushed to subscribers and cannot be recalled.
  // byPubDateDesc matters too -- getCollection() returns entries in filename
  // order, so without it the feed comes out oldest-first.
  const posts = (await getCollection("posts", isPublished)).sort(byPubDateDesc);

  return rss({
    title: "blog",
    description: "shutx-net の個人ブログ。",
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      // Root-relative on purpose: @astrojs/rss resolves each link against `site`.
      // The identifier is `id` (Content Layer API), not `slug`.
      link: `/posts/${post.id}/`,
      categories: post.data.tags,
    })),
  });
}
