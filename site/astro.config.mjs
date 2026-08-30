import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from "astro/config";

// Astro 7 defaults to the Satteri (Rust) processor. This project pins the
// remark/rehype pipeline instead so the admin preview and production render
// Markdown identically -- see AGENTS.md, non-negotiable decision 1.
// test/unit/markdown.test.ts asserts this at the config level; deleting the
// `processor` line below is not detectable from the generated HTML.
export default defineConfig({
  markdown: {
    processor: unified(),
  },
});
