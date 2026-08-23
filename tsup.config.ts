import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"pi-omp-theme": "extension-src/omp-theme/pi/index.ts",
	},
	format: ["esm"],
	dts: false,
	sourcemap: false,
	clean: true,
	target: "node22",
	outDir: "dist/extensions",
	external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
});
