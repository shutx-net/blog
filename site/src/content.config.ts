// Imported from astro's real module subpaths, not the `astro:content` virtual
// module. That keeps this file unit-testable from plain vitest (see
// test/unit/schema.test.ts) while living exactly where AGENTS.md requires.
// `astro/zod` is Zod 4 -- do not add a separate zod dependency, and note that
// `z` re-exported from `astro:content` is deprecated and goes away in Astro 8.
import { defineCollection } from "astro/content/config";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const postSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  // Coerced because YAML hands back a Date for unquoted dates and a string for
  // quoted ones; downstream code sorts on pubDate.valueOf().
  pubDate: z.coerce.date(),
  draft: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: postSchema,
});

export const collections = { posts };
