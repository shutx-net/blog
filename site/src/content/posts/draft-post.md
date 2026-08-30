---
title: "Draft post"
description: "An unfinished post; it must never reach dist/."
pubDate: 2026-08-03
draft: true
tags: ["astro", "draft-only"]
---

This post exists so the build tests can prove drafts are kept out of both the
listing and the generated pages, even though its date is the newest of the three.

The tags above are test fixtures, not decoration -- do not remove them. `astro` is
shared with published posts, so a tag page that forgot to filter drafts would list
this title; `draft-only` belongs to no published post, so the same mistake would
emit a whole `/tags/draft-only/` page. Without them the dist/ scan in
test/build/pages.test.ts has nothing to detect.
