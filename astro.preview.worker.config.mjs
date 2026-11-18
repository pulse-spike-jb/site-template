import cloudflare from "@astrojs/cloudflare";
import base from "./astro.config.mjs";

// Preview renderer on the Workers runtime (Spike 0.2): the same components and catch-all route as
// astro.preview.config.mjs, but built for Cloudflare Workers instead of Node. In production this runs as one
// isolated script per site in a Workers for Platforms `preview` namespace (CLAUDE.md §11.2, §12.7).
export default {
  ...base,
  output: "server",
  adapter: cloudflare({ configPath: "./wrangler.preview.jsonc" }),
  outDir: "./.preview-worker",
};
