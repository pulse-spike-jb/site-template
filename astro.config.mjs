import { defineConfig } from "astro/config";

// Pure static output: every page is prerendered to HTML. No adapter, no server runtime.
// The site Worker (worker/index.ts) sits in front of this output at the edge.
export default defineConfig({
  output: "static",
  outDir: process.env.OUT_DIR || "./dist",
  build: {
    format: "directory",
    inlineStylesheets: "never", // keeps a strict CSP possible (style-src 'self')
  },
  devToolbar: { enabled: false },
  vite: {
    build: { assetsInlineLimit: 0 }, // island scripts ship as files, never inline (script-src 'self')
    // CMS preview sandboxes run as git worktrees under .cms/ and resolve node_modules from the parent folder
    server: { fs: { strict: !process.env.AICMS_SANDBOX } },
  },
});
