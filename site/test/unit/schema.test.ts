import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@astrojs/markdown-remark";
import { describe, expect, it } from "vitest";

import { collections, pageSchema, postSchema } from "../../src/content.config.ts";
import { postsDirUrl } from "../../src/posts-dir.ts";

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

// Resolved the same way content.config.ts resolves the glob base, so this reads
// whichever corpus the run is actually building -- the fixtures under test, the
// real posts when POSTS_DIR is unset.
const postsDir = fileURLToPath(postsDirUrl(process.env, new URL("../../", import.meta.url)));
// Recursive because a slug is a date path (YYYY/MM/DD/HHmmss): the posts sit four
// levels down, and a plain readdirSync would hand back an empty list. "ships at
// least one markdown post" below is the floor that refuses that silently -- an
// empty list also makes the it.each() under it generate zero tests.
const postFiles = readdirSync(postsDir, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("content collections", () => {
  // Two and only two. A third collection is a new kind of content, and the posts
  // are the only one that feeds rss.xml and the deploy's slug guards.
  it("defines exactly the posts and pages collections", () => {
    expect(Object.keys(collections)).toEqual(["posts", "pages"]);
  });

  it("wires postSchema into the posts collection", () => {
    expect(collections.posts.schema).toBe(postSchema);
  });

  it("wires pageSchema into the pages collection", () => {
    expect(collections.pages.schema).toBe(pageSchema);
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

  // A tag name becomes a directory name verbatim: tags: ["Two Words"] emits
  // dist/tags/Two Words/index.html, with a raw space in the path. Whether that
  // survives an S3 key plus the CloudFront Function URI rewrite cannot be checked
  // from here (no AWS credentials), so the schema refuses to create such a path at
  // all rather than shipping a route nobody can verify.
  it.each(["Two Words", "設計メモ", "UPPER", "trailing-"])(
    "rejects the non-slug tag %j",
    (tag) => {
      expect(
        postSchema.safeParse({ ...minimalFrontmatter, tags: [tag] }).success,
      ).toBe(false);
    },
  );

  // Pinned next to the rejections on purpose: a pattern tightened by accident
  // would otherwise start failing real posts with nothing here to notice.
  it("accepts lowercase hyphenated slugs", () => {
    expect(
      postSchema.safeParse({ ...minimalFrontmatter, tags: ["astro", "aws-cdk"] }).success,
    ).toBe(true);
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

// The fixed pages are tracked in this repository, so unlike the posts there is no
// corpus to switch: this reads the real files. Listed rather than globbed so a
// deleted page fails here by name -- the routes in src/pages/ throw on a missing
// entry too, but only once the whole site is being built.
const pagesDir = fileURLToPath(new URL("../../src/content/pages/", import.meta.url));
const FIXED_PAGE_FILES = ["about.md", "privacy.md"];

describe("fixed page files", () => {
  it("are exactly the pages the site routes to", () => {
    expect(readdirSync(pagesDir).sort()).toEqual(FIXED_PAGE_FILES);
  });

  it.each(FIXED_PAGE_FILES)("%s has frontmatter satisfying pageSchema", (name) => {
    const { frontmatter } = parseFrontmatter(readFileSync(join(pagesDir, name), "utf8"));

    const result = pageSchema.safeParse(frontmatter);
    if (!result.success) {
      throw new Error(`${name}: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
  });
});
