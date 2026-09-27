// The site's own name and description, as opposed to any individual post's.
//
// Extracted because three places need the same two strings and a fourth was about
// to: the listing's <h1> and <title>, the RSS channel, and og:site_name. They were
// literals in each file, which is the shape a value takes right before two copies
// drift apart.
//
// Not in lib/posts.ts -- that module is about posts, and this is about the site.

/** Shown as the listing heading, the browser title and the feed's channel title. */
export const SITE_NAME = "blog";

/** The listing's meta description and the feed's channel description. */
export const SITE_DESCRIPTION = "shutx-net の個人ブログ。";
