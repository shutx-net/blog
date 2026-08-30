import type { APIContext } from "astro";

// An endpoint rather than a static site/public/robots.txt, because the Sitemap
// directive has to be an absolute URL and the origin is only known at build time
// (it comes from SITE_URL). A static file would bake one host into the repository
// permanently -- and, since the production domain is undecided, the wrong one.
// AGENTS.md describes site/public/ as the place for a favicon and robots.txt;
// this is the documented exception, and public/ remains the home of the favicon.
export function GET(context: APIContext): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${new URL("sitemap-index.xml", context.site)}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
