import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CommandApp,
	type CommandHost,
	executePiOmpThemeCommand,
} from "../extension-src/omp-theme/app/command-service.js";
import { formatDoctorSummary } from "../extension-src/omp-theme/app/doctor.js";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";

const degradedReport = {
	config: {
		preset: "claude",
		enabled: true,
		placement: "below",
		statusLine: "enabled",
		editor: "enabled",
		startup: "compact",
	},
	diagnostics: [
		{
			code: "CFG-002",
			level: "warning",
			path: "C:\\Users\\Lenovo\\.pi\\agent\\settings.json.piOmpTheme.schemaVersion",
			message: "missing schemaVersion accepted as v1-shaped input",
		},
	],
	sources: { "statusLine.layout.left": "preset:claude" },
	surfaces: {
		status: "installed",
		editor: "installed",
		startup: "installed",
		assistantMessage: { configured: false, nativeFallback: true },
		specialBlocks: { configured: true, installed: true, nativeFallback: true },
		tools: { configured: true, installed: true, nativeFallback: true },
	},
	piVersion: "0.85.0",
	compatibilityBasis: "runtime-identity",
	operational: {
		compatibility: {
			hostBinding: { status: "bound" },
		},
		authorization: { core: true },
	},
};

test("doctor summary prioritizes actionable compatibility state", () => {
	const summary = formatDoctorSummary(degradedReport);

	assert.equal(summary.type, "warning");
	assert.match(summary.message, /^pi-omp-theme doctor · DEGRADED/m);
	assert.match(summary.message, /OFF\s+Assistant message\s+disabled by configuration/);
	assert.match(summary.message, /NATIVE\s+Special blocks\s+using Pi renderer \(fallback\)/);
	assert.match(summary.message, /NATIVE\s+Tools\s+using Pi renderer \(fallback\)/);
	assert.match(summary.message, /CFG-002/);
	assert.match(summary.message, /at ~\\\.pi\\agent\\settings\.json/);
	assert.match(summary.message, /\/pi-omp-theme doctor json/);
	assert.doesNotMatch(summary.message, /statusLine\.layout\.left/);
});

test("disabled surfaces do not make an otherwise healthy report degraded", () => {
	const summary = formatDoctorSummary({
		...degradedReport,
		diagnostics: [],
		surfaces: {
			status: "installed",
			editor: "installed",
			startup: "installed",
			assistantMessage: { configured: false, nativeFallback: true },
			specialBlocks: { configured: true, installed: true, nativeFallback: false },
			tools: { configured: true, installed: true, nativeFallback: false },
		},
	});

	assert.equal(summary.type, "info");
	assert.match(summary.message, /^pi-omp-theme doctor · HEALTHY/m);
});

test("doctor command shows the summary by default and preserves raw JSON on request", async () => {
	const notices: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	const host: CommandHost = {
		cwd: "D:\\repo",
		isProjectTrusted: () => true,
		ui: {
			select: async () => undefined,
			notify: (message, type) => notices.push({ message, type }),
		},
	};
	const app: CommandApp = {
		config: resolveConfigDetailed({}).config,
		applySession() {},
		reload: async () => {},
		doctor: () => degradedReport,
	};
	const storage = {
		port: {
			read: async () => "{}",
			writeAtomic: async () => {},
		},
		paths: { globalPath: "global.json", projectPath: "project.json" },
	};

	await executePiOmpThemeCommand("doctor", host, app, storage);
	await executePiOmpThemeCommand("doctor json", host, app, storage);

	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /doctor · DEGRADED/);
	assert.equal(notices[1]?.type, "info");
	assert.deepEqual(JSON.parse(notices[1]?.message ?? "{}"), degradedReport);
});
