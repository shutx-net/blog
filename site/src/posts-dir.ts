// Resolves the directory the posts collection is loaded from.
//
// The environment is taken as an argument rather than read from process.env, so
// this stays a pure function: content.config.ts passes process.env, tests pass a
// literal, and nothing has to mutate the environment to be testable. Same shape
// as site-url.ts, and for the same reason.
//
// Why this is configurable at all: the posts themselves live in a separate
// private repository (shutx-net/blog-content) and are checked out onto the
// default path below at deploy time. The test runs point POSTS_DIR at
// test/fixtures/posts instead, which is what keeps the suite hermetic -- it
// neither needs that repository nor changes result when a post is published.

/**
 * Where the posts collection is loaded from when POSTS_DIR is unset, relative
 * to the astro project root.
 *
 * Production deliberately leaves POSTS_DIR unset and checks the content
 * repository out onto this path, so that no environment variable stands between
 * a correct deploy and an empty site. The default therefore has to point at the
 * real posts, never at the fixtures: a build over the fixtures exits 0 and looks
 * entirely plausible, so nothing downstream would catch the swap.
 */
export const DEFAULT_POSTS_DIR = "./src/content/posts";

/**
 * Resolves POSTS_DIR to a directory relative to the astro project root.
 *
 * Empty and whitespace-only are treated as unset: GitHub expands an undefined
 * `env:` or `vars.*` entry to the empty string rather than leaving it out, so a
 * missing value arrives here as "" and must not be handed to the glob loader.
 * `new URL("", root)` resolves to the project root, where the collection's
 * pattern matches no Markdown at all -- and astro answers an empty collection
 * with a warning and exit code 0, not a failure.
 */
export function resolvePostsDir(env: Record<string, string | undefined>): string {
  const raw = env.POSTS_DIR?.trim();
  if (!raw) return DEFAULT_POSTS_DIR;

  return raw;
}

/**
 * The same directory as an absolute URL, for the tests that read posts off disk.
 *
 * The build and the tests that check the build have to agree on this directory:
 * comparing dist/ against a different corpus compares nothing. Routing both
 * through one helper makes that a single fact instead of three copies of a path.
 *
 * The trailing slash is not cosmetic -- `new URL(base, root)` treats a final
 * segment without one as a file name and drops it when anything is resolved
 * against the result.
 */
export function postsDirUrl(
  env: Record<string, string | undefined>,
  siteRoot: URL,
): URL {
  const dir = resolvePostsDir(env);

  return new URL(dir.endsWith("/") ? dir : `${dir}/`, siteRoot);
}
