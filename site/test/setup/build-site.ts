import { fileURLToPath } from "node:url";

import { build } from "astro";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Builds the real site once for the whole `build` project, so every assertion
// in test/build/ reads the same dist/ and the build cost is paid a single time.
// If astro's JavaScript API ever changes under us, the fallback is to spawn the
// CLI instead (resolve astro/package.json -> bin, run it with process.execPath);
// the CLI is the stable public interface.
export default async function setup(): Promise<void> {
  await build({ root, logLevel: "error" });
}
