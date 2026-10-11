// Golden snapshots of the message presentation.
//
// Assistant messages are real Pi AssistantMessageComponent instances driven
// through the extension's updateContent/render decorations, so the snapshot is
// what a transcript shows. Their colours come from Pi's own theme, which
// depends on the terminal's colour support, so only their layout is recorded.
// Special message blocks are painted with the golden theme and recorded in full.
//
// Regenerate after an intended change: UPDATE_GOLDEN=1 npm test

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
	decorateMessageRender,
	decorateMessageUpdate,
	type MessageDecorationSnapshot,
	THINKING_SUMMARY_LABEL,
} from "../extension-src/omp-theme/features/messages/index.js";
import { noteThinkingEvent, resetThinkingTimings } from "../extension-src/omp-theme/features/messages/thinking-timing.js";
import {
	renderSpecialMessageBlock,
	setSpecialBlockTheme,
	type SpecialBlockSubtype,
} from "../extension-src/omp-theme/features/messages/special-blocks.js";
import { renderBashExecutionBox, setBashExecutionTheme } from "../extension-src/omp-theme/features/tools/bash-execution.js";
import { setBoxChrome, setBoxTheme } from "../extension-src/omp-theme/shared/box.js";
import {
	goldenTheme,
	layoutOf,
	plainLine,
	readGoldenSections,
	styledLine,
	UPDATE_GOLDEN,
	writeGoldenSections,
} from "./support/golden.js";

const GOLDEN_FILE = resolve("tests/golden/message-presentation.txt");
const SOURCE = "tests/message-presentation-golden.test.ts";
const WIDTH = 60;

type Content =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function assistant(content: Content[], stopReason = "stop", errorMessage?: string, timestamp = 1) {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp,
	};
}

const DEFAULT_SNAPSHOT: MessageDecorationSnapshot = Object.freeze({
	assistantPrefix: "│ ",
	assistantEnabled: false,
	collapseHiddenThinking: false,
	hideInterimText: false,
});

interface MessageCase {
	readonly id: string;
	readonly content: Content[];
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly hideThinkingBlock?: boolean;
	readonly hiddenThinkingLabel?: string;
	readonly isStreaming?: boolean;
	readonly snapshot?: Partial<MessageDecorationSnapshot>;
	/** Recorded thinking span of content block 0, as message_update reports it. */
	readonly thinkingSpan?: readonly [number, number];
	readonly timestamp?: number;
}

const ANSWER = "The expiry check compared with `<` instead of `<=`, so tokens expiring this very millisecond were still accepted. I changed the comparison and added a regression test.";
const THINKING = "The failing test is about expiry. Let me look at the comparison in auth.ts before changing anything.";

const MESSAGE_CASES: readonly MessageCase[] = [
	{ id: "assistant/text", content: [{ type: "text", text: ANSWER }] },
	{
		id: "assistant/thinking-hidden-collapsed",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: "",
		snapshot: { collapseHiddenThinking: true },
	},
	{
		id: "assistant/thinking-hidden-label",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: "Thinking...",
	},
	{
		id: "assistant/thinking-visible",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
	},
	{
		id: "assistant/thinking-streaming",
		content: [{ type: "thinking", thinking: THINKING }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: "",
		isStreaming: true,
		snapshot: { collapseHiddenThinking: true },
	},
	{
		id: "assistant/prefix-gutter",
		content: [{ type: "text", text: ANSWER }],
		snapshot: { assistantEnabled: true },
	},
	{
		id: "assistant/interim-text-hidden",
		content: [
			{ type: "text", text: "Let me run the tests." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
		],
		snapshot: { hideInterimText: true },
	},
	{
		id: "assistant/interim-text-shown",
		content: [
			{ type: "text", text: "Let me run the tests." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
		],
	},
	{ id: "assistant/aborted", content: [{ type: "text", text: "Partial answer" }], stopReason: "aborted" },
	// Inline (Claude Code) message style.
	{ id: "inline/text-marked", content: [{ type: "text", text: ANSWER }], snapshot: { assistantMarker: true } },
	{
		id: "inline/thinking-summary-timed",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: THINKING_SUMMARY_LABEL,
		snapshot: { assistantMarker: true, thinkingSummary: true },
		thinkingSpan: [1000, 7200],
		timestamp: 2,
	},
	{
		id: "inline/thinking-summary-restored",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: THINKING_SUMMARY_LABEL,
		snapshot: { assistantMarker: true, thinkingSummary: true },
		timestamp: 3,
	},
	{
		id: "inline/thinking-summary-streaming",
		content: [{ type: "thinking", thinking: THINKING }],
		hideThinkingBlock: true,
		hiddenThinkingLabel: THINKING_SUMMARY_LABEL,
		isStreaming: true,
		snapshot: { assistantMarker: true, thinkingSummary: true },
		timestamp: 4,
	},
	{
		id: "inline/thinking-visible-marked",
		content: [{ type: "thinking", thinking: THINKING }, { type: "text", text: ANSWER }],
		snapshot: { assistantMarker: true, thinkingSummary: true },
		timestamp: 5,
	},
	{
		id: "inline/interim-text-marked",
		content: [
			{ type: "text", text: "Let me run the tests." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
		],
		snapshot: { assistantMarker: true },
	},
	// Models that interleave reasoning with short text (Codex commentary) put a
	// text block before a thinking run, or two text blocks, in one message.
	{
		id: "assistant/text-then-thinking",
		content: [
			{ type: "text", text: "The test passes." },
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text: ANSWER },
		],
	},
	{
		id: "inline/text-then-thinking",
		content: [
			{ type: "text", text: "The test passes." },
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text: ANSWER },
		],
		snapshot: { assistantMarker: true, thinkingSummary: true },
		timestamp: 6,
	},
	{
		id: "inline/text-then-thinking-summary",
		content: [
			{ type: "text", text: "The test passes." },
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text: ANSWER },
		],
		hideThinkingBlock: true,
		hiddenThinkingLabel: THINKING_SUMMARY_LABEL,
		snapshot: { assistantMarker: true, thinkingSummary: true },
		timestamp: 7,
	},
	{
		id: "inline/text-then-text",
		content: [
			{ type: "text", text: "The test passes." },
			{ type: "text", text: ANSWER },
		],
		snapshot: { assistantMarker: true },
	},
];

function renderMessage(entry: MessageCase): string[] {
	const snapshot = { ...DEFAULT_SNAPSHOT, ...entry.snapshot };
	const component = new AssistantMessageComponent(
		undefined,
		entry.hideThinkingBlock ?? false,
		undefined,
		entry.hiddenThinkingLabel ?? "Thinking...",
	);
	const message = assistant(entry.content, entry.stopReason, entry.errorMessage, entry.timestamp);
	if (entry.thinkingSpan) {
		noteThinkingEvent(message, { type: "thinking_start", contentIndex: 0 }, entry.thinkingSpan[0]);
		noteThinkingEvent(message, { type: "thinking_end", contentIndex: 0 }, entry.thinkingSpan[1]);
	}
	decorateMessageUpdate(
		AssistantMessageComponent.prototype.updateContent,
		component,
		[message, entry.isStreaming ?? false],
		snapshot,
	);
	const rendered = decorateMessageRender(AssistantMessageComponent.prototype.render, component, [WIDTH], snapshot);
	return rendered as string[];
}

// ── Special message blocks ──────────────────────────────────────────────────

type SpecialFixture = {
	message?: { tokensBefore?: number; tokensAfter?: number; summary?: string; customType?: string; content?: string };
	skillBlock?: { name: string; content: string };
	markdownTheme?: unknown;
};

function renderSpecial(subtype: SpecialBlockSubtype, fixture: SpecialFixture): string[] {
	let child: Component | undefined;
	const instance = {
		...fixture,
		expanded: false,
		clear() {
			child = undefined;
		},
		addChild(component: unknown) {
			child = component as Component;
		},
		removeChild() {},
		setBgFn() {},
	};
	renderSpecialMessageBlock(
		subtype,
		() => {
			throw new Error(`${subtype} patch unexpectedly fell back to Pi`);
		},
		instance,
		[],
	);
	assert.ok(child, `${subtype} patch should attach a component`);
	return child.render(WIDTH);
}

const SPECIAL_CASES: ReadonlyArray<{ id: string; render(): string[] }> = [
	{
		id: "special/compaction",
		render: () =>
			renderSpecial("native-compaction-message", {
				message: { tokensBefore: 10_000, tokensAfter: 4_000, summary: "Compacted test context." },
			}),
	},
	{
		id: "special/skill",
		render: () =>
			renderSpecial("native-skill-message", {
				skillBlock: { name: "release-checklist", content: "Run the release checklist before tagging." },
			}),
	},
	{
		// pi-vcc summaries open with bracketed section labels.
		id: "special/compaction-pi-vcc",
		render: () =>
			renderSpecial("native-compaction-message", {
				message: {
					tokensBefore: 4_964,
					// Emphasis marks go; the underscore inside is_expired stays.
					summary: "[Session Goal]\n- Fix the __is_expired__ boundary\n\n[Files And Changes]\n- Read: src/auth.ts",
				},
			}),
	},
	{
		// An extension's own message type (pi-vcc's /pi-vcc-recall).
		id: "special/custom-vcc-recall",
		render: () =>
			renderSpecial("native-custom-message", {
				message: { customType: "vcc-recall", content: 'No matches for "expiry" in session history.' },
				markdownTheme: getMarkdownTheme(),
			}),
	},
	{
		// Pi prefixes every skill body with where its references resolve.
		id: "special/skill-pi-preamble",
		render: () =>
			renderSpecial("native-skill-message", {
				skillBlock: {
					name: "release-checklist",
					content: "References are relative to C:\\skills\\release-checklist.\n\nRun the release checklist before tagging.",
				},
			}),
	},
	{
		id: "special/branch",
		render: () => renderSpecial("native-branch-message", { message: { summary: "Prepared a test branch." } }),
	},
];

// ── User bash (`!command`) ───────────────────────────────────────────────────

/** Pi's BashExecutionComponent rows: padded header, blank, output, status. */
function userBash(status: "running" | "complete" | "error" | "cancelled", rows: string[], exitCode?: number) {
	const instance = {
		command: "npm test -- auth",
		status,
		exitCode,
		piOmpThemeStart: 1_000,
		// Pi ends the output with a styled empty row: blank on screen, not to trim().
		contentContainer: { render: () => [" $ npm test -- auth", " ", ...rows.map((row) => ` ${row}`), " \x1b[90m\x1b[39m"] },
	};
	return renderBashExecutionBox(instance, [WIDTH]) ?? [];
}

const USER_BASH_CASES: ReadonlyArray<{ id: string; render(): string[] }> = [
	{ id: "user-bash/complete", render: () => userBash("complete", ["✓ 12 passed"], 0) },
	{ id: "user-bash/error", render: () => userBash("error", ["✕ rejects expired tokens", "(exit 1)"], 1) },
	{ id: "user-bash/running", render: () => userBash("running", ["⠋ Running..."]) },
];

// ── Harness ─────────────────────────────────────────────────────────────────

const expected = readGoldenSections(GOLDEN_FILE);
const actual = new Map<string, string>();
const originalKeybindings = getKeybindings();

before(() => {
	initTheme("dark", false);
	setKeybindings(
		new KeybindingsManager(
			{
				"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
				"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
			} as const,
			{},
		),
	);
	setBoxTheme(goldenTheme);
	setSpecialBlockTheme(goldenTheme);
	setBashExecutionTheme(goldenTheme);
	// A running user command shows its elapsed: 12.4s after it started.
	mock.method(Date, "now", () => 13_400);
});

after(() => {
	resetThinkingTimings();
	setBoxChrome("boxed");
	setBoxTheme(undefined);
	setSpecialBlockTheme(undefined);
	setBashExecutionTheme(undefined);
	mock.restoreAll();
	setKeybindings(originalKeybindings);
	if (UPDATE_GOLDEN) writeGoldenSections(GOLDEN_FILE, "Message presentation golden (¶ marks end of line)", SOURCE, actual);
});

function check(key: string, lines: string[], styled: boolean): void {
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= WIDTH, `line ${index + 1} overflows width ${WIDTH}: ${plainLine(line)}`);
	}
	const body = styled ? `${layoutOf(lines)}\n--- styled ---\n${lines.map(styledLine).join("\n")}` : layoutOf(lines);
	actual.set(key, body);
	if (UPDATE_GOLDEN) return;
	assert.ok(expected.has(key), `missing golden section "${key}"; run UPDATE_GOLDEN=1 npm test`);
	assert.equal(body, expected.get(key), `presentation changed for ${key}`);
}

const knownKeys = new Set<string>();

for (const entry of MESSAGE_CASES) {
	const key = `w${WIDTH} · ${entry.id}`;
	knownKeys.add(key);
	test(`golden: ${key}`, () => check(key, renderMessage(entry), false));
}

for (const chrome of ["boxed", "light", "inline"] as const) {
	for (const entry of [...SPECIAL_CASES, ...USER_BASH_CASES]) {
		const key = `${chrome} · w${WIDTH} · ${entry.id}`;
		knownKeys.add(key);
		test(`golden: ${key}`, () => {
			setBoxChrome(chrome);
			check(key, entry.render(), true);
		});
	}
}

test("message golden carries no stale sections", () => {
	if (UPDATE_GOLDEN) return;
	assert.deepEqual(
		[...expected.keys()].filter((key) => !knownKeys.has(key)),
		[],
	);
});
