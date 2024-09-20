import { defineConfig } from "tsup";

export default defineConfig({
  entryPoints: ["src/index.ts"],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  minify: true,
  clean: true,
});
