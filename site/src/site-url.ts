// Resolves astro's `site` -- the absolute origin every canonical link, rss.xml,
// sitemap-*.xml and robots.txt is built from.
//
// The environment is taken as an argument rather than read from process.env, so
// this stays a pure function: astro.config.mjs passes process.env, tests pass a
// literal, and nothing has to mutate the environment to be testable.
//
// Note that astro does NOT load .env files while evaluating the config file, so
// only a shell export, a CLI prefix or a CI-injected value is visible here.

/**
 * Fallback origin used when SITE_URL is unset.
 *
 * `.invalid` is reserved by RFC 2606 and never resolves, so a build that ships
 * this fallback is unmistakably broken rather than plausibly wrong. That matters
 * most for the feed: <guid isPermaLink="true"> is a permanent subscriber-side
 * identity, and publishing under a real-but-wrong host then moving would
 * re-deliver every post as new, with no way to take it back.
 */
export const PLACEHOLDER_SITE_URL = "https://blog.invalid/";

/**
 * Resolves SITE_URL to an absolute origin with a trailing slash.
 *
 * Unset is allowed on purpose -- failing the build would break `npm run -w site
 * build` and the build-layer tests for zero safety, since the placeholder cannot
 * be mistaken for a real domain. A malformed or non-https value is a genuine typo
 * and throws, because that one would otherwise be baked into the feed silently.
 */
export function resolveSiteUrl(env: Record<string, string | undefined>): string {
  const raw = env.SITE_URL?.trim();
  if (!raw) return PLACEHOLDER_SITE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SITE_URL must be an absolute URL, got: ${raw}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`SITE_URL must use https://, got: ${raw}`);
  }

  // origin + "/" rather than the parsed href: dropping any path, query and
  // fragment means the result cannot vary with a stray trailing slash.
  return `${parsed.origin}/`;
}
