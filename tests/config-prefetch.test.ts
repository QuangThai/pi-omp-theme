import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConfigFilePort } from "../extension-src/omp-theme/app/config-storage.js";
import { DEFAULT_CONFIG } from "../extension-src/omp-theme/domain/config-normalization.js";
import { createConfigSourceAdapter } from "../extension-src/omp-theme/pi/config-session.js";

const paths = () => ({ globalPath: "<global>", projectPath: "<project>" });
const flags = { getFlag: () => true };

function recordingPort(contents: Record<string, string> = {}): { port: ConfigFilePort; reads: string[] } {
	const reads: string[] = [];
	const port: ConfigFilePort = {
		read: async (path: string) => {
			reads.push(path);
			const content = contents[path];
			if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return content;
		},
		writeAtomic: async () => {},
	};
	return { port, reads };
}

test("warming the config reads the global scope only: project settings wait for the trust decision", async () => {
	const { port, reads } = recordingPort({
		"<global>": JSON.stringify({ piOmpTheme: { preset: "claude" } }),
		"<project>": JSON.stringify({ piOmpTheme: { preset: "minimal" } }),
	});
	const source = createConfigSourceAdapter(flags, port, paths);

	source.warm();
	await Promise.resolve();
	assert.deepEqual(reads, ["<global>"], "an untrusted project's settings are not read speculatively");

	// The session turns out to be untrusted: the project file is still never read.
	source.setSession("D:\\Personal\\pi-omp-theme", false);
	const untrusted = await source.load();
	assert.deepEqual(reads, ["<global>"], "the warmed global read is reused and no project read is added");
	assert.equal((untrusted.config as { preset?: string }).preset, "claude");
});

test("a trusted session reuses the warmed global read and adds the project scope", async () => {
	const { port, reads } = recordingPort({
		"<global>": JSON.stringify({ piOmpTheme: { preset: "claude" } }),
		"<project>": JSON.stringify({ piOmpTheme: { statusLine: { bottomMargin: 3 } } }),
	});
	const source = createConfigSourceAdapter(flags, port, paths);

	source.warm();
	source.setSession("D:\\Personal\\pi-omp-theme", true);
	const resolved = await source.load();

	assert.deepEqual(reads, ["<global>", "<project>"]);
	assert.equal((resolved.config as { preset?: string }).preset, "claude");
	assert.equal((resolved.config as { statusLine: { bottomMargin: number } }).statusLine.bottomMargin, 3);

	// The warmed read is consumed once; a later reload sees the file again.
	await source.load();
	assert.deepEqual(reads, ["<global>", "<project>", "<global>", "<project>"]);
});

test("a load keeps the trust decision it started with across an awaited warm read", async () => {
	let releaseGlobal: (() => void) | undefined;
	const globalReady = new Promise<void>((resolve) => {
		releaseGlobal = resolve;
	});
	const reads: string[] = [];
	const port: ConfigFilePort = {
		read: async (path: string) => {
			reads.push(path);
			if (path === "<global>") {
				await globalReady;
				return JSON.stringify({ piOmpTheme: { preset: "claude" } });
			}
			return JSON.stringify({ piOmpTheme: { preset: "minimal" } });
		},
		writeAtomic: async () => {},
	};
	const source = createConfigSourceAdapter(flags, port, paths);

	source.warm();
	source.setSession("D:\\untrusted", false);
	const loading = source.load();
	// A later session becoming trusted while the global read is pending must not
	// authorize this already-started load to read that later session's project.
	source.setSession("D:\\trusted", true);
	releaseGlobal?.();
	const resolved = await loading;

	assert.deepEqual(reads, ["<global>"]);
	assert.equal((resolved.config as { preset?: string }).preset, "claude");
});

test("an unreadable global config still reports its diagnostic through the warmed read", async () => {
	// readScopedConfig never rejects: an unreadable file becomes a CFG-IO
	// diagnostic. Warming must hand that verdict through unchanged rather than
	// swallow it, or the doctor would report a healthy config that never loaded.
	const port: ConfigFilePort = {
		read: async () => {
			throw new Error("disk hiccup");
		},
		writeAtomic: async () => {},
	};
	const source = createConfigSourceAdapter(flags, port, paths);

	source.warm();
	await Promise.resolve();
	source.setSession("D:\\Personal\\pi-omp-theme", true);
	const resolved = await source.load();

	const io = resolved.diagnostics.filter((diagnostic) => diagnostic.code === "CFG-IO");
	assert.equal(io.length, 2, "one per scope");
	assert.match(io[0]?.message ?? "", /disk hiccup/);
	// The session still starts, on the shipped defaults.
	assert.equal((resolved.config as { preset?: string }).preset, DEFAULT_CONFIG.preset);
});
