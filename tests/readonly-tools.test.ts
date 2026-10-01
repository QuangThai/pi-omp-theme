import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PRESET_NAMES, resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import piOmpThemeExtension, { __setCompatibilityTestHooks } from "../extension-src/omp-theme/pi/index.js";

const coreTools = ["read", "bash", "edit", "write"];
const readonlyTools = ["grep", "find", "ls"];
const flagName = "pi-omp-theme-readonly-tools";

type FixtureOptions = {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	trusted?: boolean;
	flag?: string;
	active?: string[];
	available?: string[];
};

function fixture(options: FixtureOptions = {}) {
	let global = options.global ?? {};
	let active = [...(options.active ?? coreTools)];
	const changes: string[][] = [];
	const notices: string[] = [];
	const registrations = new Map<string, { type: string; default?: boolean | string }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const available = options.available ?? [...coreTools, ...readonlyTools, "anchor_grep", "replace"];
	const pi = {
		registerFlag(name: string, definition: { type: string; default?: boolean | string }) {
			registrations.set(name, definition);
		},
		getFlag(name: string) {
			return name === flagName && options.flag !== undefined ? options.flag : registrations.get(name)?.default;
		},
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
		getActiveTools: () => [...active],
		getAllTools: () => available.map((name) => ({ name })),
		setActiveTools(names: string[]) { active = [...names]; changes.push([...names]); },
	} as unknown as ExtensionAPI;
	const restore = __setCompatibilityTestHooks({
		filePort: {
			async read(path) {
				return JSON.stringify({ piOmpTheme: path === "<global>" ? global : options.project ?? {} });
			},
			async writeAtomic() {},
		},
		paths: () => ({ globalPath: "<global>", projectPath: "<project>" }),
		gitRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
	});
	try { piOmpThemeExtension(pi); } finally { restore(); }
	const ctx = {
		mode: "rpc",
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => options.trusted ?? false,
		ui: { notify: (message: string) => notices.push(message) },
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined, getSessionName: () => undefined },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	return {
		registrations, changes, notices,
		get active() { return active; },
		setGlobal(value: Record<string, unknown>) { global = value; },
		deactivate(name: string) { active = active.filter((tool) => tool !== name); },
		async start(reason = "startup") { await handlers.get("session_start")?.({ reason }, ctx); },
		async stop() { await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx); },
	};
}

test("read-only activation is off for every preset, and configuration accepts only booleans", () => {
	for (const preset of PRESET_NAMES) assert.equal(resolveConfigDetailed({ global: { preset } }).config.readonlyTools, false);
	for (const value of [true, false]) {
		const result = resolveConfigDetailed({ global: { readonlyTools: value } });
		assert.equal(result.config.readonlyTools, value);
		assert.equal(result.sources.readonlyTools, "global");
		assert.deepEqual(result.diagnostics, []);
	}
	for (const value of ["true", "false", 1, null, {}]) {
		const result = resolveConfigDetailed({ global: { readonlyTools: value } });
		assert.equal(result.config.readonlyTools, false);
		assert.ok(result.diagnostics.some((entry) => entry.path === "readonlyTools"));
	}
});

test("the CLI override is value-taking with no default that masks settings", async () => {
	const f = fixture();
	try {
		assert.equal(f.registrations.get(flagName)?.type, "string");
		assert.equal(f.registrations.get(flagName)?.default, undefined);
	} finally { await f.stop(); }
});

for (const options of [
	{},
	{ global: { readonlyTools: false } },
	{ active: ["read", "bash", "write", "anchor_grep", "replace"] },
	{ active: [...coreTools, "grep", "find", "ls"] },
] satisfies FixtureOptions[]) {
	test(`default/disabled activation preserves tools: ${JSON.stringify(options)}`, async () => {
		const f = fixture(options);
		const initial = [...f.active];
		try {
			await f.start();
			assert.deepEqual(f.active, initial);
			assert.deepEqual(f.changes, []);
		} finally { await f.stop(); }
	});
}

for (const options of [
	{ global: { readonlyTools: true } },
	{ flag: "true" },
	{ global: { readonlyTools: false }, flag: "true" },
	{ project: { readonlyTools: true }, trusted: true },
] satisfies FixtureOptions[]) {
	test(`explicit opt-in adds available tools once: ${JSON.stringify(options)}`, async () => {
		const f = fixture({ ...options, active: ["read", "anchor_grep", "replace"], available: ["read", "anchor_grep", "replace", "grep", "ls"] });
		try {
			await f.start();
			assert.deepEqual(f.active, ["read", "anchor_grep", "replace", "grep", "ls"]);
			await f.start("reload");
			assert.equal(f.changes.length, 1);
		} finally { await f.stop(); }
	});
}

for (const options of [
	{ global: { readonlyTools: true }, flag: "false" },
	{ global: { readonlyTools: true, enabled: false }, flag: "true" },
	{ project: { readonlyTools: true }, trusted: false },
	{ global: { readonlyTools: true }, project: { readonlyTools: false }, trusted: true },
	{ global: { readonlyTools: true }, available: coreTools },
] satisfies FixtureOptions[]) {
	test(`opt-out/trust/availability gates activation: ${JSON.stringify(options)}`, async () => {
		const f = fixture(options);
		try {
			await f.start();
			assert.deepEqual(f.active, coreTools);
			assert.deepEqual(f.changes, []);
		} finally { await f.stop(); }
	});
}

test("invalid CLI values fail closed even when config opts in, with an actionable warning", async () => {
	const f = fixture({ global: { readonlyTools: true }, flag: "nope" });
	try {
		await f.start();
		assert.deepEqual(f.changes, []);
		assert.ok(f.notices.some((message) => message.includes(flagName) && message.includes("true or false")));
	} finally { await f.stop(); }
});

test("the environment disable gate wins over read-only config and CLI opt-in", async () => {
	const previous = process.env.PI_OMP_THEME_DISABLED;
	process.env.PI_OMP_THEME_DISABLED = "1";
	const f = fixture({ global: { readonlyTools: true }, flag: "true" });
	try {
		await f.start();
		assert.deepEqual(f.changes, []);
	} finally {
		await f.stop();
		if (previous === undefined) delete process.env.PI_OMP_THEME_DISABLED;
		else process.env.PI_OMP_THEME_DISABLED = previous;
	}
});

test("session boundaries re-read configuration without removing or resurrecting others' tools", async () => {
	const f = fixture({ global: { readonlyTools: true } });
	try {
		await f.start();
		assert.deepEqual(f.active, [...coreTools, ...readonlyTools]);
		f.setGlobal({ readonlyTools: false });
		f.deactivate("grep");
		await f.start("new");
		assert.deepEqual(f.active, [...coreTools, "find", "ls"]);
		assert.equal(f.changes.length, 1);
	} finally { await f.stop(); }
});
