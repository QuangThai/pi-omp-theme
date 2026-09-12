import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { renderBoxedToolCall, renderBoxedToolResult } from "../extension-src/omp-theme/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "../extension-src/omp-theme/features/tools/boxed/session-config.js";
import {
	beginAgentRun,
	finishAgentRun,
	rebuildTurnRegistryFromEntries,
	registerTurnFromMessage,
	resetTurnRegistry,
	turnSummaryParts,
	type TurnState,
} from "../extension-src/omp-theme/features/tools/boxed/turn-summary.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function context(toolCallId: string, args: Record<string, unknown> = {}) {
	return {
		args,
		toolCallId,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

function completeRun(tools: readonly { id: string; name: string }[]): TurnState {
	beginAgentRun();
	registerTurnFromMessage(
		{
			content: tools.map(({ id, name }) => ({ type: "toolCall", id, name })),
		},
		tools.map(({ id }) => ({ toolCallId: id, isError: false })),
	);
	const turn = finishAgentRun();
	assert.ok(turn, "fixture run should finish with every tool result registered");
	return turn;
}

beforeEach(() => {
	resetTurnRegistry();
	setToolsRenderConfig({ collapseAfterTurn: true, collapseMutatingTools: false });
});

afterEach(() => {
	resetTurnRegistry();
	setToolsRenderConfig({ collapseAfterTurn: true, collapseMutatingTools: false });
});

test("a completed Ask card remains visible as the record of the user's decision", () => {
	setToolsRenderConfig({ collapseMutatingTools: true });
	completeRun([{ id: "ask-1", name: "ask_user_question" }]);
	const args = { questions: [{ id: "confirm", question: "Proceed?", options: [{ value: "yes", label: "Yes" }] }] };
	const ctx = context("ask-1", args);
	const call = renderBoxedToolCall("ask_user_question", args, theme, ctx);
	const result = renderBoxedToolResult(
		"ask_user_question",
		{ content: [{ type: "text", text: 'confirm: yes ("Yes")' }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);
	const rendered = [...call.render(100), ...result.render(100)].join("\n");

	assert.match(rendered, /Ask User Question/);
	assert.match(rendered, /confirm: yes/);
	assert.doesNotMatch(rendered, /used 1 ask_user_question/);
});

test("Ask stays visible while ordinary read-only tools still form the turn summary", () => {
	const turn = completeRun([
		{ id: "ask-1", name: "ask_user_question" },
		{ id: "read-1", name: "read" },
	]);

	assert.deepEqual(turnSummaryParts(turn).parts, ["Read 1 file"]);
	const ask = renderBoxedToolCall("ask_user_question", { questions: [{}] }, theme, context("ask-1")).render(100).join("\n");
	const read = renderBoxedToolCall("read", { path: "README.md" }, theme, context("read-1")).render(100).join("\n");
	assert.match(ask, /Ask User Question/);
	assert.match(read, /➔ Read 1 file/);
});

test("a restored session also preserves its completed Ask card", () => {
	rebuildTurnRegistryFromEntries([
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "ask-restored", name: "ask_user_question" }],
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "ask-restored", isError: false } },
	]);

	const rendered = renderBoxedToolCall(
		"ask_user_question",
		{ questions: [{}] },
		theme,
		context("ask-restored"),
	)
		.render(100)
		.join("\n");
	assert.match(rendered, /Ask User Question/);
	assert.doesNotMatch(rendered, /used 1 ask_user_question/);
});
