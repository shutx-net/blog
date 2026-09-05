// Imported from astro's real module subpaths, not the `astro:content` virtual
// module. That keeps this file unit-testable from plain vitest (see
// test/unit/schema.test.ts) while living exactly where AGENTS.md requires.
// `astro/zod` is Zod 4 -- do not add a separate zod dependency, and note that
// `z` re-exported from `astro:content` is deprecated and goes away in Astro 8.
import { defineCollection } from "astro/content/config";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

import { resolvePostsDir } from "./posts-dir.ts";

export const postSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  // Coerced because YAML hands back a Date for unquoted dates and a string for
  // quoted ones; downstream code sorts on pubDate.valueOf().
  pubDate: z.coerce.date(),
  draft: z.boolean().default(false),
  // A tag becomes a directory name verbatim -- tags: ["Two Words"] would emit
  // dist/tags/Two Words/index.html, with a raw space in the path, and a Japanese
  // tag would emit a non-ASCII one. Neither can be verified end to end from here
  // (an S3 key plus the CloudFront Function URI rewrite, with no AWS credentials
  // available), so unroutable tags fail the build instead. Splitting a tag into a
  // display label and a slug is the change to make when Japanese tags are wanted.
  tags: z
    .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
    .default([]),
});

// base is resolved against the astro project root. It comes from a pure function
// rather than a literal because the posts live in a separate private repository
// and are checked out onto the default path at deploy time, while the test runs
// point POSTS_DIR at test/fixtures/posts to stay hermetic.
//
// Note that an empty collection is NOT a build failure: a missing base directory
// and a pattern matching nothing both produce a warning and exit code 0. Nothing
// here can catch that -- the guard is the post-count check in the deploy workflow.
const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: resolvePostsDir(process.env) }),
  schema: postSchema,
});

export const collections = { posts };
