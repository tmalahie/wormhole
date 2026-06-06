import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: false,
  splitting: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Worm-owned recipe code lives ONCE in the package, parameterized at run time
  // — never copied into a project's .worm/recipes/. Ship it alongside the bundle
  // so `packagedRecipeScript()` (which resolves relative to dist/) can find it.
  onSuccess: async () => {
    await cp("src/recipes", "dist/recipes", { recursive: true });
  },
});
