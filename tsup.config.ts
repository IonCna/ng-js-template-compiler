import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  external: ["ng-js-compiler"],
});
