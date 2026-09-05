import { describe, expect, it } from "vitest";

import { DEFAULT_POSTS_DIR, postsDirUrl, resolvePostsDir } from "../../src/posts-dir.ts";

// The same shape as site-url.test.ts: the resolver takes the environment as an
// argument, so nothing has to mutate process.env to be testable.
//
// The direction of the default is the whole safety argument here. Production
// sets no POSTS_DIR at all -- the content repo is checked out onto the default
// path -- while the test runs opt in to the fixtures. Flipping that would ship
// the fixtures to the public site, and no assertion downstream would notice,
// because a build over the fixtures succeeds and looks entirely plausible.
describe("resolvePostsDir", () => {
  it("falls back to the real posts directory when POSTS_DIR is unset", () => {
    expect(resolvePostsDir({})).toBe("./src/content/posts");
  });

  // Pinned to the literal as well as the constant: asserting only
  // toBe(DEFAULT_POSTS_DIR) would still pass if the constant itself were
  // repointed at the fixtures.
  it("names the real posts directory as the default", () => {
    expect(DEFAULT_POSTS_DIR).toBe("./src/content/posts");
  });

  // GitHub expands an unset `env:`/`vars.` entry to the empty string rather than
  // leaving it undefined, so an empty value has to mean "unset" too. Same trap
  // resolveSiteUrl already handles.
  it("falls back to the default when POSTS_DIR is empty", () => {
    expect(resolvePostsDir({ POSTS_DIR: "" })).toBe(DEFAULT_POSTS_DIR);
  });

  it("falls back to the default when POSTS_DIR is only whitespace", () => {
    expect(resolvePostsDir({ POSTS_DIR: "   " })).toBe(DEFAULT_POSTS_DIR);
  });

  it("returns POSTS_DIR when it is set", () => {
    expect(resolvePostsDir({ POSTS_DIR: "./test/fixtures/posts" })).toBe(
      "./test/fixtures/posts",
    );
  });
});

// The tests that read posts off disk and the build that renders them must land
// on the same directory -- an admin parity run comparing dist/ against a
// different corpus would be comparing nothing. Resolving both through this one
// helper is what makes that a single fact rather than three copies of a path.
describe("postsDirUrl", () => {
  const siteRoot = new URL("file:///repo/site/");

  it("resolves the default against the astro project root", () => {
    expect(postsDirUrl({}, siteRoot).href).toBe("file:///repo/site/src/content/posts/");
  });

  it("resolves POSTS_DIR against the astro project root", () => {
    expect(postsDirUrl({ POSTS_DIR: "./test/fixtures/posts" }, siteRoot).href).toBe(
      "file:///repo/site/test/fixtures/posts/",
    );
  });

  // readdirSync tolerates a missing trailing slash but `new URL(base, root)`
  // does not: without one, the last segment is treated as a file name and gets
  // dropped when anything is resolved against it.
  it("ends in a slash whether or not POSTS_DIR carries one", () => {
    expect(postsDirUrl({ POSTS_DIR: "./a/b" }, siteRoot).href).toBe("file:///repo/site/a/b/");
    expect(postsDirUrl({ POSTS_DIR: "./a/b/" }, siteRoot).href).toBe("file:///repo/site/a/b/");
  });
});
