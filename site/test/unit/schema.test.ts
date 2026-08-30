import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@astrojs/markdown-remark";
import { describe, expect, it } from "vitest";

import { collections, postSchema } from "../../src/content.config.ts";

// src/content.config.ts imports defineCollection/glob/z from astro's real module
// subpaths rather than the astro:content virtual module, which is what lets this
// file be imported by plain vitest -- no astro runtime, no content data store.
// See the plan's rationale: getCollection() under vitest silently returns an empty
// Map, so schema coverage has to come from the schema object itself.

const minimalFrontmatter = {
  title: "Hello world",
  description: "The first post.",
  pubDate: "2026-08-01",
};

const withoutKey = (key: string): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...minimalFrontmatter };
  delete clone[key];
  return clone;
};

const postsDir = fileURLToPath(new URL("../../src/content/posts/", import.meta.url));
const postFiles = readdirSync(postsDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("content collections", () => {
  it("defines exactly one collection, posts", () => {
    expect(Object.keys(collections)).toEqual(["posts"]);
  });

  it("wires postSchema into the posts collection", () => {
    expect(collections.posts.schema).toBe(postSchema);
  });
});

describe("postSchema", () => {
  it("accepts minimal frontmatter and fills in defaults", () => {
    const parsed = postSchema.parse(minimalFrontmatter);

    expect(parsed.draft).toBe(false);
    expect(parsed.tags).toEqual([]);
    expect(parsed.pubDate).toBeInstanceOf(Date);
  });

  it("rejects frontmatter with no title", () => {
    expect(postSchema.safeParse(withoutKey("title")).success).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(postSchema.safeParse({ ...minimalFrontmatter, title: "" }).success).toBe(false);
  });

  it("rejects frontmatter with no description", () => {
    expect(postSchema.safeParse(withoutKey("description")).success).toBe(false);
  });

  it("rejects a pubDate that is not a date", () => {
    expect(
      postSchema.safeParse({ ...minimalFrontmatter, pubDate: "not a date" }).success,
    ).toBe(false);
  });

  it("rejects tags that are not all strings", () => {
    expect(
      postSchema.safeParse({ ...minimalFrontmatter, tags: ["astro", 42] }).success,
    ).toBe(false);
  });
});

describe("post fixtures", () => {
  it("ships at least one markdown post", () => {
    expect(postFiles.length).toBeGreaterThan(0);
  });

  it.each(postFiles)("%s has frontmatter satisfying postSchema", (name) => {
    const raw = readFileSync(join(postsDir, name), "utf8");
    const { frontmatter } = parseFrontmatter(raw);

    const result = postSchema.safeParse(frontmatter);
    if (!result.success) {
      // Name the file and the offending fields, so a bad post is diagnosable
      // straight from the failure message rather than by bisecting the directory.
      throw new Error(`${name}: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
  });
});
