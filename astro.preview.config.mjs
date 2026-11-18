import node from "@astrojs/node";
import base from "./astro.config.mjs";

// Preview renderer: the same components, rendered per request. Content comes from the platform's
// content API for a given changeset (see src/pages/[...slug].astro), so content changes never need a rebuild.
// Rebuilt only when the site's code changes.
export default {
  ...base,
  output: "server",
  adapter: node({ mode: "standalone" }),
  outDir: "./.preview",
};
