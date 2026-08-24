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
	// The bundle is plain ESM JavaScript but is shipped with a `.ts` extension on
	// purpose. Pi loads extensions through jiti, which tries a *native* import for
	// `.js`/`.mjs` ESM files first and only applies its host aliases
	// (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` -> the running
	// Pi's own modules) when that native import fails. A `.js` entry next to a
	// resolvable `node_modules/@earendil-works/*` (a local checkout installed with
	// `pi install <dir>`, or any hoisted copy) therefore binds the extension to a
	// second copy of Pi, and every prototype patch lands on classes the TUI never
	// uses. jiti always transpiles `.ts`, so the aliases always apply and the
	// extension always patches the Pi that is actually running.
	outExtension: () => ({ js: ".ts" }),
	banner: {
		js: [
			"// @nguyenquangthai/pi-omp-theme — compiled bundle.",
			"// The .ts extension is deliberate: Pi's jiti loader always transpiles .ts and",
			"// resolves @earendil-works/* to the running Pi's own modules (see tsup.config.ts).",
		].join("\n"),
	},
});
