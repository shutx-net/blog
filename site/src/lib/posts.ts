// Shared rules for listing posts: the draft predicate, the sort order, tag
// collection and URL normalisation.
//
// This module must NEVER import `astro:content`. The virtual module cannot be
// resolved by plain vitest, and getCollection() silently returns an empty Map
// there -- so pulling it in would make every rule below untestable. getCollection
// stays on the page side and takes the predicate as an argument:
//
//     getCollection("posts", isPublished)
//
// which is the same split content.config.ts already uses (real module subpaths in,
// virtual module out).
import type { z } from "astro/zod";

import type { postSchema } from "../content.config.ts";

/** Frontmatter of a post, derived from postSchema so it is never defined twice. */
export type PostData = z.infer<typeof postSchema>;

/**
 * The shape these helpers need from a collection entry. Structural, so real
 * CollectionEntry<"posts"> values from getCollection() satisfy it, and test
 * fixtures do not have to fake an entire entry.
 */
export type PostEntry = { data: PostData };

/** Posts per listing page. Also drives the expected page count in the tests. */
export const POSTS_PER_PAGE = 3;

/**
 * Every page that lists posts must apply this. Centralising it does not stop a
 * page from forgetting to pass it -- the real backstop is the dist/ scan in
 * test/build/pages.test.ts, which catches leaks in pages that do not exist yet.
 */
export const isPublished = (entry: PostEntry): boolean => !entry.data.draft;

/** Newest first. pubDate is a Date thanks to postSchema's z.coerce.date(). */
export const byPubDateDesc = (a: PostEntry, b: PostEntry): number =>
  b.data.pubDate.valueOf() - a.data.pubDate.valueOf();

/** Unique tags across the given posts, in a stable (alphabetical) order. */
export const collectTags = (posts: readonly PostEntry[]): string[] =>
  [...new Set(posts.flatMap((post) => post.data.tags))].sort();

/**
 * Japan has been on a fixed +09:00 with no DST since 1951, so the offset can be
 * a constant rather than a timezone database lookup.
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The published date as a Japanese reader expects to see it, in JST.
 *
 * Deliberately NOT Intl.DateTimeFormat: a Node built with small-icu falls back
 * to en-US and would silently print "September 8, 2026" instead, so the same
 * commit could render differently on a developer's machine and in CI. Shifting
 * the instant and reading the UTC parts has no such dependency.
 *
 * The timezone is pinned for the same reason -- reading local parts would make
 * the rendered date depend on the machine's TZ, and a post published late in the
 * evening JST would date itself a day earlier when built in CI (which runs UTC).
 */
export const formatPubDate = (date: Date): string => {
  const jst = new Date(date.valueOf() + JST_OFFSET_MS);

  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
};

/**
 * build.format is "directory", so canonical URLs and sitemap entries all end in a
 * slash -- but paginate() hands back "/2" and "/". Idempotent, which is the whole
 * point at the root: appending unconditionally would produce "//".
 */
export const withTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path : `${path}/`;
