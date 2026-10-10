// Behaviour of the inline (Claude Code) presentation that goldens cannot show:
// configuration, patch gating, click handling, timing and the working row.

import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { resolveConfigDetailed, validateConfigLayer } from "../extension-src/omp-theme/domain/config-normalization.js";
import { decorateMessageUpdate, THINKING_SUMMARY_LABEL } from "../extension-src/omp-theme/features/messages/index.js";
import {
	noteThinkingEvent,
	resetThinkingTimings,
	thinkingDurationMs,
} from "../extension-src/omp-theme/features/messages/thinking-timing.js";
import {
	configureWorkingShimmer,
	disposeWorkingShimmer,
	formatRunElapsed,
	startWorkingShimmer,
} from "../extension-src/omp-theme/features/working-indicator/index.js";
import {
	disposePiCompatibilityProbe,
	probePiCompatibility,
} from "../extension-src/omp-theme/pi/compatibility-probe.js";
import { checklistFromArgs, inlineArgsSummary, inlineHeaderLine } from "../extension-src/omp-theme/shared/inline.js";
import { goldenTheme, plainLine } from "./support/golden.js";

const originalKeybindings = getKeybindings();

before(() => {
	initTheme("dark", false);
	setKeybindings(
		new KeybindingsManager(
			{
				"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
				"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
			} as const,
			{},
		),
	);
});

after(() => {
	resetThinkingTimings();
	setKeybindings(originalKeybindings);
});

test("the claude-code preset turns on the whole inline transcript", () => {
	const { config, diagnostics } = resolveConfigDetailed({ global: { preset: "claude-code" }, projectTrusted: true });
	assert.equal(config.tools.chrome, "inline");
	assert.equal(config.tools.maxCollapsedLines, 4);
	assert.equal(config.messages.assistantMarker, true);
	assert.equal(config.messages.thinkingSummary, true);
	assert.equal(config.theme.workingElapsed, true);
	assert.equal(config.editor.frame, "claude");
	assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE"));
});

test("the default and claude presets keep every inline option off", () => {
	for (const preset of ["default", "claude"]) {
		const { config } = resolveConfigDetailed({ global: { preset }, projectTrusted: true });
		assert.equal(config.tools.chrome, "boxed", preset);
		assert.equal(config.messages.assistantMarker, false, preset);
		assert.equal(config.messages.thinkingSummary, false, preset);
		assert.equal(config.theme.workingElapsed, false, preset);
	}
});

test("inline options validate like every other leaf", () => {
	const accepted = validateConfigLayer({
		tools: { chrome: "inline" },
		messages: { assistantMarker: true, thinkingSummary: true },
		theme: { workingElapsed: true },
	});
	assert.deepEqual(accepted.diagnostics, []);
	const rejected = validateConfigLayer({ tools: { chrome: "cozy" }, messages: { assistantMarker: "yes" } });
	assert.equal(rejected.diagnostics.length, 2);
});

test("a thinking summary alone installs the updateContent decoration", () => {
	const report = probePiCompatibility("99.99.99", {
		config: {
			messages: {
				enabled: true,
				assistantPrefix: false,
				specialBlocks: false,
				hideThinkingLabel: false,
				hideInterimText: false,
				thinkingSummary: true,
			},
			tools: { enabled: false, style: "compact-box", maxCollapsedLines: 4, maxExpandedLines: 50, dimOutput: false },
			preset: "claude-code",
		},
	});
	try {
		const disabled = report.unsupported.filter((item) => item.cause === "disabled").map((item) => item.method);
		assert.ok(!disabled.includes("updateContent"), "updateContent must stay decorated for the summary");
		assert.ok(disabled.includes("render"), "the assistant prefix render patch stays off");
	} finally {
		assert.equal(disposePiCompatibilityProbe(report).complete, true);
	}
});

test("a collapsed thinking run still toggles on click through its marker", () => {
	const component = new AssistantMessageComponent(undefined, true, undefined, THINKING_SUMMARY_LABEL);
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Check the comparison first." },
			{ type: "text", text: "Fixed." },
		],
		stopReason: "stop",
		timestamp: 41,
	};
	decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, component, [message, false], {
		assistantPrefix: "│ ",
		assistantEnabled: false,
		collapseHiddenThinking: false,
		hideInterimText: false,
		assistantMarker: true,
		thinkingSummary: true,
	});
	const children = (component as unknown as { contentContainer: { children: unknown[] } }).contentContainer.children;
	const thinking = children.find((child) => plainLine((child as { render(w: number): string[] }).render(40).join("")).includes("Thought"));
	assert.ok(thinking, "the thinking run renders behind its marker");
	assert.match(plainLine((thinking as { render(w: number): string[] }).render(40).join("")), /^● Thought/);
	const result = (thinking as { handleMouse(event: unknown): unknown }).handleMouse({
		type: "click",
		button: "left",
		x: 3,
		y: 0,
		width: 40,
		height: 1,
		screenX: 3,
		screenY: 0,
	});
	assert.deepEqual(result, { handled: true });
	const overrides = (component as unknown as { thinkingVisibilityOverrides: Map<number, boolean> }).thinkingVisibilityOverrides;
	assert.equal(overrides.get(0), false, "the click reveals that run");
});

test("thinking durations are per content block and need a recorded end", () => {
	resetThinkingTimings();
	const message = { timestamp: 7 };
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 0 }, 100);
	assert.equal(thinkingDurationMs(message, [0]), undefined, "still thinking");
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 0 }, 2600);
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 2 }, 3000);
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 2 }, 3500);
	noteThinkingEvent(message, { type: "text_delta", contentIndex: 1 }, 9999);
	assert.equal(thinkingDurationMs(message, [0]), 2500);
	assert.equal(thinkingDurationMs(message, [2]), 500);
	assert.equal(thinkingDurationMs({ timestamp: 8 }, [0]), undefined, "restored messages carry no timing");
});

test("the working row counts the run time inside its hint", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const messages: Array<string | undefined> = [];
	try {
		configureWorkingShimmer(
			{ setWorkingMessage: (message) => messages.push(message) },
			"off",
			() => ({ low: "", mid: "", high: "" }),
			{ elapsed: true },
		);
		startWorkingShimmer();
		assert.match(plainLine(messages.at(-1) ?? ""), /^Working\.\.\. \(Escape to interrupt\)$/);
		mock.timers.tick(14_000);
		assert.match(plainLine(messages.at(-1) ?? ""), /^Working\.\.\. \(14s · Escape to interrupt\)$/);
		mock.timers.tick(111_000);
		assert.match(plainLine(messages.at(-1) ?? ""), /\(2m 5s · Escape to interrupt\)$/);
	} finally {
		disposeWorkingShimmer();
		mock.timers.reset();
	}
	assert.equal(formatRunElapsed(999), "");
	assert.equal(formatRunElapsed(61_000), "1m 1s");
});

test("todo arguments become a checklist by shape, whatever the tool is called", () => {
	assert.deepEqual(
		checklistFromArgs({
			todos: [
				{ content: "a", status: "completed" },
				{ title: "b", status: "in_progress" },
				{ text: "c", status: "pending" },
			],
		}),
		[
			{ text: "a", state: "done" },
			{ text: "b", state: "active" },
			{ text: "c", state: "open" },
		],
	);
	assert.equal(checklistFromArgs({ todos: [] }), undefined);
	assert.equal(checklistFromArgs({ todos: [{ status: "pending" }] }), undefined);
	assert.equal(checklistFromArgs({ items: [{ content: "a" }] }), undefined);
});

test("call headers keep the closing parenthesis when arguments are cut", () => {
	for (const width of [12, 20, 36, 80]) {
		const line = inlineHeaderLine(goldenTheme, "running", "Bash", "cd /Users/bean/Documents/Develope/pi-agent-ext", width);
		assert.ok(visibleWidth(line) <= width, `fits ${width}`);
		if (width === 20 || width === 36) assert.match(plainLine(line), /…\)$/, `cut at ${width}`);
		if (width === 80) assert.match(plainLine(line), /pi-agent-ext\)$/, "fits whole at 80");
	}
	assert.equal(inlineArgsSummary({ command: "ls", timeout: 5 }), "command: ls, timeout: 5");
	assert.equal(inlineArgsSummary({ path: "src/a.ts" }), "src/a.ts");
	assert.equal(inlineArgsSummary({ query: "x\ny" }), "x …");
});
