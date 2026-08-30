import { isUnifiedProcessor } from "@astrojs/markdown-remark";
import { describe, expect, it } from "vitest";

import config from "../../astro.config.mjs";

// This suite is the only effective guard on AGENTS.md's non-negotiable decision 1
// ("use @astrojs/markdown-remark explicitly"). The generated HTML cannot protect it:
// the default Satteri processor and unified() differ by exactly one trailing newline
// for this kind of Markdown, so no assertion on dist/ output would notice the
// `processor:` line being deleted. Keep the config-level assertion below.
describe("markdown processor configuration", () => {
  it("is explicitly set to the unified() processor", () => {
    const processor = config.markdown?.processor;

    expect(processor).toBeDefined();
    expect(processor.name).toBe("unified");
    expect(isUnifiedProcessor(processor)).toBe(true);
  });

  it("renders GFM strikethrough, smart quotes and heading ids", async () => {
    const processor = config.markdown?.processor;
    const renderer = await processor.createRenderer({ syntaxHighlight: false });

    const { code, metadata } = await renderer.render(
      ['## Heading two', "", 'A ~~struck~~ word and a "quoted" phrase.', ""].join("\n"),
    );

    expect(code).toContain("<del>struck</del>");
    expect(code).toContain("“quoted”");
    expect(metadata.headings).toEqual([
      { depth: 2, slug: "heading-two", text: "Heading two" },
    ]);
  });
});
