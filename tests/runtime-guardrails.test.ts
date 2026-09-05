import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigFilePort } from "../extension-src/omp-theme/app/config-storage.js";
import { decorateMessageUpdate } from "../extension-src/omp-theme/features/messages/index.js";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import {
	clearPresentationTui,
	notePresentationTui,
	noteToolRowHint,
	resetToolRowHints,
	toolRowPlacement,
} from "../extension-src/omp-theme/features/tools/boxed/render-viewport.js";
import {
	activeElapsedTickerCount,
	getStateElapsedMs,
	recordExecutionStarted,
	startElapsedTicker,
	stopAllElapsedTickers,
	stopElapsedTicker,
} from "../extension-src/omp-theme/features/tools/boxed/session-config.js";
import {
	invalidateTurnMembers,
	noteTurnMemberRender,
	resetTurnRegistry,
	type TurnState,
} from "../extension-src/omp-theme/features/tools/boxed/turn-summary.js";
import { createCompatibilityCoordinator } from "../extension-src/omp-theme/pi/compatibility-coordinator.js";
import {
	COMPATIBILITY_BASIS,
	disposePiCompatibilityProbe,
	fingerprint,
	KNOWN_NATIVE_IDENTITIES,
	matchKnownNativeIdentity,
	probePiCompatibility,
} from "../extension-src/omp-theme/pi/compatibility-probe.js";
import { probeHostBinding } from "../extension-src/omp-theme/pi/host-binding.js";
import piOmpThemeExtension from "../extension-src/omp-theme/pi/index.js";
import { createPiOmpThemeSessionCoordinator } from "../extension-src/omp-theme/pi/session-coordinator.js";

function packageFixture() {
	const hostRoot = resolve(".virtual-tests", "host", "node_modules", "@earendil-works", "pi-coding-agent");
	const extensionRoot = resolve(".virtual-tests", "extension", "node_modules", "@earendil-works", "pi-coding-agent");
	const packageJson = JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		exports: { ".": { import: "./dist/index.js" } },
	});
	const files = new Map([
		[join(hostRoot, "package.json"), packageJson],
		[join(extensionRoot, "package.json"), packageJson],
	]);
	return {
		hostRoot,
		extensionRoot,
		readFile(path: string) {
			const content = files.get(path);
			if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return content;
		},
	};
}

afterEach(() => {
	stopAllElapsedTickers();
	resetTurnRegistry();
	resetToolRowHints();
	clearPresentationTui();
});

test("host-binding probe distinguishes shared and foreign Pi module identities", async () => {
	const fixture = packageFixture();
	const sharedComponent = function SharedComponent() {};
	const common = {
		argv1: join(fixture.hostRoot, "dist", "cli.js"),
		readFile: fixture.readFile,
		resolveExtensionEntry: () => join(fixture.extensionRoot, "dist", "index.js"),
		extensionAssistantMessageComponent: sharedComponent,
	};

	const bound = await probeHostBinding({
		...common,
		importModule: async () => ({ AssistantMessageComponent: sharedComponent }),
	});
	assert.equal(bound.status, "bound");
	assert.equal(bound.hostPackage, fixture.hostRoot);
	assert.equal(bound.extensionPackage, fixture.extensionRoot);

	const foreign = await probeHostBinding({
		...common,
		importModule: async () => ({ AssistantMessageComponent: function ForeignComponent() {} }),
	});
	assert.equal(foreign.status, "foreign");
	assert.match(foreign.reason, /second copy/);
});

test("host-binding probe treats Pi's bundled Node runtime as the loader host", async () => {
	const fixture = packageFixture();
	const binding = await probeHostBinding({
		argv1: join(fixture.hostRoot, "dist", "bundle", "cli.js"),
		readFile: fixture.readFile,
		resolveExtensionEntry: () => join(fixture.extensionRoot, "dist", "index.js"),
		extensionAssistantMessageComponent: function SharedComponent() {},
		bundledHostRuntime: true,
		importModule: async () => {
			throw new Error("the modular package entry must not be imported for a bundled host");
		},
	});

	assert.equal(binding.status, "bound");
	assert.match(binding.reason, /bundled runtime/);
	assert.equal(binding.hostPackage, fixture.hostRoot);
});

test("compatibility probing is identity-based rather than version-allowlisted", () => {
	const report = probePiCompatibility("99.99.99");
	try {
		assert.equal(report.attemptedVersion, "99.99.99");
		assert.equal(report.compatibilityBasis, COMPATIBILITY_BASIS);
		assert.ok(report.certification.length > 0);
		assert.ok(report.certification.every((surface) => surface.status === "certified"));
		assert.ok(report.certification.every((surface) => surface.matchedIdentity !== undefined));
		assert.equal("supportedVersions" in report, false);
		assert.equal("certificationTable" in report, false);
	} finally {
		assert.equal(disposePiCompatibilityProbe(report).complete, true);
	}
});

test("bundled contract markers tolerate harmless rewrites but reject contract drift", () => {
	const compatibleRewrite = function getCallRenderer(this: {
		toolDefinition?: { renderCall?: unknown };
	}) {
		const renderer = this.toolDefinition?.renderCall;
		return renderer;
	};
	const incompatibleRewrite = function getCallRenderer(this: { toolDefinition?: unknown }) {
		return this.toolDefinition;
	};
	const identities = KNOWN_NATIVE_IDENTITIES["tool-call-renderer:getCallRenderer"] ?? [];

	assert.equal(identities.some((identity) => identity.fingerprint === fingerprint(compatibleRewrite)), false);
	assert.ok(
		matchKnownNativeIdentity("tool-call-renderer:getCallRenderer", compatibleRewrite, { bundledRuntime: true }),
	);
	assert.equal(
		matchKnownNativeIdentity("tool-call-renderer:getCallRenderer", compatibleRewrite, { bundledRuntime: false }),
		undefined,
	);
	assert.equal(
		matchKnownNativeIdentity("tool-call-renderer:getCallRenderer", incompatibleRewrite, { bundledRuntime: true }),
		undefined,
	);
});

test("disabled assistant decoration does not degrade configured special blocks", () => {
	const compatibility = createCompatibilityCoordinator();
	const { config } = resolveConfigDetailed({
		global: { preset: "claude", compatibility: { allowCorePatches: true } },
	});
	compatibility.captureAuthorization(true, true, true, true, false);
	const report = compatibility.install(config, true, "allow", { status: "bound", reason: "shared test host" });
	assert.ok(report);
	try {
		const state = compatibility.state(config) as {
			nativeFallbacks: number;
			assistantMessage: { configured: boolean; nativeFallback: boolean };
			specialBlocks: { configured: boolean; nativeFallback: boolean };
			tools: { configured: boolean; nativeFallback: boolean };
		};
		assert.equal(state.assistantMessage.configured, false);
		assert.equal(state.assistantMessage.nativeFallback, false);
		assert.equal(state.specialBlocks.configured, true);
		assert.equal(state.specialBlocks.nativeFallback, false);
		assert.equal(state.tools.nativeFallback, false);
		assert.equal(state.nativeFallbacks, 0);
	} finally {
		assert.equal(compatibility.dispose().complete, true);
	}
});

test("Pi 0.85 tool renderer identities are recorded for modular and bundled hosts", () => {
	assert.deepEqual(
		KNOWN_NATIVE_IDENTITIES["tool-call-renderer:getCallRenderer"]?.slice(-2).map((identity) => identity.fingerprint),
		["e0a9ed86", "73116365"],
	);
	assert.deepEqual(
		KNOWN_NATIVE_IDENTITIES["tool-result-renderer:getResultRenderer"]?.slice(-2).map((identity) => identity.fingerprint),
		["1567dcf4", "d613a2a3"],
	);
});

test("hidden-thinking cleanup unwraps Pi 0.85's MouseRegion wrapper", () => {
	const blankText = {
		setCustomBgFn() {},
		render: () => ["\u001b[3m\u001b[23m"],
	};
	const spacer = { setLines() {} };
	const instance = {
		hideThinkingBlock: true,
		hiddenThinkingLabel: "",
		contentContainer: { children: [
			{ child: blankText, render: blankText.render },
			spacer,
		] },
	};
	const original = function (this: typeof instance) {
		return this.contentContainer;
	};

	decorateMessageUpdate(original, instance, [], {
		assistantPrefix: "│ ",
		assistantEnabled: true,
		collapseHiddenThinking: true,
		hideInterimText: false,
	});
	assert.deepEqual(instance.contentContainer.children, []);
});

test("host-binding probe degrades to unknown when no absolute host entry exists", async () => {
	const binding = await probeHostBinding({
		argv1: "relative-cli.js",
		extensionAssistantMessageComponent: function Component() {},
		resolveExtensionEntry: () => {
			throw new Error("unavailable");
		},
	});

	assert.equal(binding.status, "unknown");
	assert.match(binding.reason, /not an absolute path/);
});

test("foreign host binding withholds compatibility patch installation", () => {
	const compatibility = createCompatibilityCoordinator();
	compatibility.captureAuthorization(true, true, true, true, false);
	const { config } = resolveConfigDetailed({
		global: { preset: "claude", compatibility: { allowCorePatches: true } },
	});
	const binding = { status: "foreign", reason: "test foreign module" } as const;

	assert.equal(compatibility.install(config, true, "allow", binding), undefined);
	const state = compatibility.state(config);
	assert.equal(state.installed, false);
	assert.deepEqual(state.hostBinding, binding);
});

test("session start captures project trust exactly once and reuses the decision", async () => {
	let trustChecks = 0;
	const pi = {
		getFlag() {
			return false;
		},
	} as unknown as ExtensionAPI;
	const filePort: ConfigFilePort = {
		async read() {
			return JSON.stringify({ piOmpTheme: { enabled: false } });
		},
		async writeAtomic() {},
	};
	const coordinator = createPiOmpThemeSessionCoordinator(pi, {
		filePort,
		paths: () => ({ globalPath: "<global>", projectPath: "<project>" }),
		gitRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
	});
	const ctx = {
		mode: "rpc",
		hasUI: false,
		cwd: "D:\\Personal\\pi-omp-theme",
		isProjectTrusted() {
			trustChecks++;
			return true;
		},
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;

	try {
		await coordinator.start({ reason: "startup" }, ctx);
		assert.equal(trustChecks, 1);
	} finally {
		coordinator.shutdown();
	}
});

function lifecycleHandlers(): Map<string, (...args: unknown[]) => unknown> {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerFlag() {},
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		getFlag() {
			return false;
		},
	} as unknown as ExtensionAPI;
	piOmpThemeExtension(pi);
	return handlers;
}

test("agent and session boundary handlers clean up leaked elapsed tickers", () => {
	const handlers = lifecycleHandlers();
	for (const eventName of ["agent_end", "session_shutdown"]) {
		const state: Record<string, unknown> = {};
		recordExecutionStarted(state, true);
		startElapsedTicker(state, () => {});
		assert.equal(activeElapsedTickerCount(), 1);
		const handler = handlers.get(eventName);
		assert.ok(handler, `${eventName} handler was not registered`);
		handler();
		assert.equal(activeElapsedTickerCount(), 0);
		assert.notEqual(getStateElapsedMs(state), undefined);
	}
});

test("run-boundary cleanup stops every elapsed ticker and freezes durations", async () => {
	const first: Record<string, unknown> = {};
	const second: Record<string, unknown> = {};
	recordExecutionStarted(first, true);
	recordExecutionStarted(second, true);
	startElapsedTicker(first, () => {});
	startElapsedTicker(second, () => {});
	assert.equal(activeElapsedTickerCount(), 2);

	stopElapsedTicker(first);
	assert.equal(activeElapsedTickerCount(), 1);
	startElapsedTicker(first, () => {});
	assert.equal(activeElapsedTickerCount(), 2);

	stopAllElapsedTickers();
	assert.equal(activeElapsedTickerCount(), 0);
	const firstElapsed = getStateElapsedMs(first);
	const secondElapsed = getStateElapsedMs(second);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	assert.equal(getStateElapsedMs(first), firstElapsed);
	assert.equal(getStateElapsedMs(second), secondElapsed);
});

test("viewport placement is conservative in regular mode and safe in fullscreen", () => {
	notePresentationTui({ mode: "regular", previousLines: Array.from({ length: 100 }), previousViewportTop: 88 });
	noteToolRowHint("inside");
	assert.equal(toolRowPlacement("inside"), "inside");

	clearPresentationTui();
	resetToolRowHints();
	notePresentationTui({ mode: "regular", previousLines: Array.from({ length: 100 }), previousViewportTop: 89 });
	noteToolRowHint("above");
	assert.equal(toolRowPlacement("above"), "above");

	clearPresentationTui();
	notePresentationTui({ mode: "fullscreen", previousLines: [], previousViewportTop: 999 });
	assert.equal(toolRowPlacement("untracked"), "inside");
});

test("completed-turn invalidation skips off-screen leaders but updates visible runs", () => {
	const turn: TurnState = {
		leaderId: "leader",
		ended: true,
		members: [{ toolCallId: "leader", toolName: "read", hasResult: true, isError: false }],
	};
	let invalidations = 0;
	noteTurnMemberRender("leader", () => invalidations++);
	notePresentationTui({ mode: "regular", previousLines: Array.from({ length: 20 }), previousViewportTop: 9 });
	noteToolRowHint("leader");
	assert.equal(invalidateTurnMembers(turn), false);
	assert.equal(invalidations, 0);

	resetToolRowHints();
	clearPresentationTui();
	notePresentationTui({ mode: "regular", previousLines: Array.from({ length: 20 }), previousViewportTop: 8 });
	noteToolRowHint("leader");
	assert.equal(invalidateTurnMembers(turn), true);
	assert.equal(invalidations, 1);
});
