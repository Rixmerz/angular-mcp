import { defineConfig } from "tsup";

// The Claude Code plugin runs from a git checkout with no `npm install`, so the
// server ships as one committed file with its dependencies inlined. The
// analyzed project's `typescript` and `@angular/compiler` are never bundled:
// src/indexer/resolve.ts loads them at runtime from that project.
export default defineConfig({
  entry: { "server.bundle": "src/index.ts" },
  outDir: "../../mcp",
  outExtension: () => ({ js: ".mjs" }),
  format: ["esm"],
  target: "node20",
  platform: "node",
  noExternal: [/.*/],
  external: ["typescript", /^@angular\//],
  // Bundled CommonJS dependencies still call `require`, which ESM lacks.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  clean: false,
  sourcemap: false,
  dts: false,
});
