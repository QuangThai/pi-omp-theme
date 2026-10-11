// With the inline markers on, an assistant answer starts `●` on Pi's gutter and
// its text two columns later. Pi draws the user's message itself, with the text
// on the gutter, so the prompt gets the editor's `❯` in the marker column and
// both texts start in the same column, as in Claude Code.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
	decorateMessageUpdate,
	decorateUserMessageRebuild,
	type MessageDecorationSnapshot,
} from "../extension-src/omp-theme/features/messages/index.js";
import {
	disposePiCompatibilityProbe,
	probePiCompatibility,
} from "../extension-src/omp-theme/pi/compatibility-probe.js";
import { stripAnsi, visibleWidth } from "../extension-src/omp-theme/shared/ansi.js";

const PROMPT = "please check whether this repository still builds after the upgrade and report back";
const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07\x1b]133;C\x07";

const markers: MessageDecorationSnapshot = {
	assistantPrefix: "│ ",
	assistantEnabled: false,
	collapseHiddenThinking: false,
	hideInterimText: false,
	assistantMarker: true,
};

before(() => {
	initTheme("dark", false);
});

type Rendered = { render(width: number): string[] };

/** Pi 0.85's shape: the real component, a band Box around the Markdown. */
function boxedPrompt(outputPad = 1, snapshot = markers): Rendered {
	const component = new UserMessageComponent(PROMPT, getMarkdownTheme(), outputPad);
	const { rebuild } = UserMessageComponent.prototype as unknown as { rebuild: unknown };
	decorateUserMessageRebuild(rebuild, component, [], snapshot);
	return component;
}

/** Pi 1.1's shape: one Markdown that pads and paints its own band. */
function paintedPrompt(outputPad = 1): Rendered {
	const background = (text: string) => `\x1b[48;2;15;18;22m${text}\x1b[49m`;
	const component = {
		outputPad,
		children: [] as unknown[],
		render(width: number) {
			const lines = (this.children[0] as Rendered).render(width);
			return [`${OSC_START}${lines[0]}`, ...lines.slice(1, -1), `${OSC_END}${lines.at(-1)}`];
		},
	};
	const rebuild = function (this: typeof component) {
		this.children = [new Markdown(PROMPT, this.outputPad, 1, getMarkdownTheme(), { bgColor: background })];
	};
	decorateUserMessageRebuild(rebuild, component, [], markers);
	return component;
}

function textColumn(line: string): number {
	return stripAnsi(line).search(/[A-Za-z]/);
}

test("the prompt's text starts in the same column as the answer's", () => {
	const answer = new AssistantMessageComponent(undefined, false);
	decorateMessageUpdate(
		AssistantMessageComponent.prototype.updateContent,
		answer,
		[{ role: "assistant", content: [{ type: "text", text: "It builds." }], stopReason: "stop", timestamp: 1 }],
		markers,
	);
	const answerRow = answer.render(80).find((line) => stripAnsi(line).includes("It builds."));
	assert.ok(answerRow);
	for (const prompt of [boxedPrompt(), paintedPrompt()]) {
		const firstRow = prompt.render(80).find((line) => stripAnsi(line).trim() !== "");
		assert.ok(firstRow);
		assert.match(stripAnsi(firstRow), /^ ❯ please/);
		assert.equal(textColumn(firstRow), textColumn(answerRow));
	}
});

test("wrapped prompt rows hang under the text, and the band keeps its full width", () => {
	for (const prompt of [boxedPrompt(), paintedPrompt()]) {
		const lines = prompt.render(40);
		const text = lines.filter((line) => stripAnsi(line).trim() !== "");
		assert.ok(text.length > 1, "the prompt wraps at 40 columns");
		for (const line of text.slice(1)) assert.match(stripAnsi(line), /^ {3}\S/);
		assert.equal(text.filter((line) => stripAnsi(line).includes("❯")).length, 1, "one marker per prompt");
		for (const line of lines) assert.equal(visibleWidth(line), 40, JSON.stringify(stripAnsi(line)));
		// Every row, the blank band rows above and below included, is painted.
		for (const line of lines) assert.ok(line.includes("\x1b[48;"), "the inserted cells stay inside the band");
		assert.ok(lines[0]?.startsWith(OSC_START), "Pi's prompt zone still opens the block");
		assert.ok(lines.at(-1)?.startsWith(OSC_END), "and closes it");
	}
});

test("with outputPad 0 the marker moves to the edge with the text", () => {
	const firstRow = boxedPrompt(0)
		.render(60)
		.find((line) => stripAnsi(line).trim() !== "");
	assert.match(stripAnsi(firstRow ?? ""), /^❯ please/);
});

test("without markers Pi's user message is untouched", () => {
	const native = new UserMessageComponent(PROMPT, getMarkdownTheme(), 1);
	const decorated = boxedPrompt(1, { ...markers, assistantMarker: false });
	assert.deepEqual(decorated.render(60), native.render(60));
});

test("the prompt marker installs only alongside the assistant marker", () => {
	for (const assistantMarker of [true, false]) {
		const report = probePiCompatibility("99.99.99", {
			config: {
				messages: {
					enabled: true,
					assistantPrefix: false,
					specialBlocks: false,
					hideThinkingLabel: false,
					hideInterimText: false,
					assistantMarker,
				},
				tools: { enabled: false, style: "compact-box", maxCollapsedLines: 4, maxExpandedLines: 50, dimOutput: false },
				preset: "claude-code",
			},
		});
		try {
			const installed = report.recordSnapshots.some((item) => item.subtype === "native-user-message" && !item.disposed);
			const disabled = report.unsupported.some(
				(item) => item.subtype === "native-user-message" && item.cause === "disabled",
			);
			assert.equal(installed, assistantMarker);
			assert.equal(disabled, !assistantMarker);
		} finally {
			assert.equal(disposePiCompatibilityProbe(report).complete, true);
		}
	}
});
