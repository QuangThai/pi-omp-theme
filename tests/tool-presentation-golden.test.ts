// Golden snapshots of the tool presentation.
//
// Every case drives the boxed dispatcher through the same render passes Pi's
// ToolExecutionComponent makes (pending → execution started → streamed partials
// → settled), with one renderer state object shared across passes and a fixed
// clock, then records what the call and result components paint.
//
// Two files are compared: the layout (plain text, end of line marked with ¶ so
// padding is visible) and the styled form (each theme token, bold, italic and
// raw SGR spelled out). A layout or colour change in any tool surface shows up
// as a reviewable diff here before it reaches a transcript.
//
// Regenerate after an intended change: UPDATE_GOLDEN=1 npm test

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import {
	getKeybindings,
	KeybindingsManager,
	setCapabilities,
	setKeybindings,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import { resetBashTreeRegistry } from "../extension-src/omp-theme/features/tools/boxed/bash.js";
import { resetBatchRegistry } from "../extension-src/omp-theme/features/tools/boxed/batch.js";
import { resetGrepRegistry } from "../extension-src/omp-theme/features/tools/boxed/grep.js";
import { renderBoxedToolCall, renderBoxedToolResult } from "../extension-src/omp-theme/features/tools/boxed/index.js";
import { clearPresentationTui, resetToolRowHints } from "../extension-src/omp-theme/features/tools/boxed/render-viewport.js";
import { setToolsRenderConfig, stopAllElapsedTickers } from "../extension-src/omp-theme/features/tools/boxed/session-config.js";
import type { BoxedToolContext, BoxedToolResult } from "../extension-src/omp-theme/features/tools/boxed/shared.js";
import {
	beginAgentRun,
	finishAgentRun,
	registerTurnFromMessage,
	resetTurnRegistry,
} from "../extension-src/omp-theme/features/tools/boxed/turn-summary.js";
import { setBoxChrome, setBoxTheme } from "../extension-src/omp-theme/shared/box.js";
import {
	goldenTheme as theme,
	layoutOf,
	plainLine,
	readGoldenSections,
	styledLine,
	UPDATE_GOLDEN,
	writeGoldenSections,
} from "./support/golden.js";

const LAYOUT_FILE = resolve("tests/golden/tool-presentation.layout.txt");
const STYLED_FILE = resolve("tests/golden/tool-presentation.styled.txt");
const SOURCE = "tests/tool-presentation-golden.test.ts";
const CWD = "/repo";

// ── Lifecycle simulation ────────────────────────────────────────────────────

let clock = 0;

type Phase = "pending" | "running" | "streaming" | "settled";

interface ToolStep {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly phase?: Phase;
	readonly partial?: BoxedToolResult;
	readonly result?: BoxedToolResult;
	readonly isError?: boolean;
	readonly expanded?: boolean;
}

interface Painter {
	readonly toolCallId: string;
	readonly state: Record<string, unknown>;
	paint(width: number): string[];
}

let callSequence = 0;

function contextFor(
	step: ToolStep,
	toolCallId: string,
	state: Record<string, unknown>,
	over: Partial<BoxedToolContext>,
): BoxedToolContext {
	return {
		args: step.args,
		toolCallId,
		invalidate() {},
		lastComponent: undefined,
		state,
		cwd: CWD,
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded: Boolean(step.expanded),
		showImages: false,
		isError: false,
		...over,
	};
}

/** One Pi updateDisplay: build the call (and result) renderers, paint later. */
function pass(
	step: ToolStep,
	context: BoxedToolContext,
	result?: { value: BoxedToolResult; isPartial: boolean },
): (width: number) => string[] {
	const call = renderBoxedToolCall(step.tool, step.args, theme, context);
	const rendered = result
		? renderBoxedToolResult(
				step.tool,
				result.value,
				{ expanded: Boolean(step.expanded), isPartial: result.isPartial },
				theme,
				context,
			)
		: undefined;
	return (width) => [...call.render(width), ...(rendered ? rendered.render(width) : [])];
}

/** Drive one tool through Pi's render passes up to `step.phase` (default settled). */
function runTool(step: ToolStep, toolCallId = `golden-${++callSequence}`): Painter {
	const state: Record<string, unknown> = {};
	const phase = step.phase ?? "settled";
	clock = 1000;
	let paint = pass(step, contextFor(step, toolCallId, state, {}));
	if (phase !== "pending") {
		paint = pass(step, contextFor(step, toolCallId, state, { executionStarted: true }));
		clock = 1800;
	}
	if (phase === "streaming" || (phase === "settled" && step.partial)) {
		const partial = step.partial ?? { content: [], details: {} };
		const started = contextFor(step, toolCallId, state, { executionStarted: true });
		clock = 2000;
		paint = pass(step, started, { value: { content: [], details: {} }, isPartial: true });
		clock = 2400;
		paint = pass(step, started, { value: partial, isPartial: true });
	}
	if (phase === "settled") {
		clock = 3234;
		const settled = contextFor(step, toolCallId, state, {
			executionStarted: true,
			isPartial: false,
			isError: Boolean(step.isError),
		});
		paint = pass(step, settled, {
			value: step.result ?? { content: [], details: {} },
			isPartial: false,
		});
	}
	return { toolCallId, state, paint };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function text(value: string, details: Record<string, unknown> = {}): BoxedToolResult {
	return { content: [{ type: "text", text: value }], details };
}

function numbered(count: number, label = "line"): string {
	return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");
}

/** `count` output lines built from their 1-based number. */
function names(count: number, line: (n: number) => string): string {
	return Array.from({ length: count }, (_, index) => line(index + 1)).join("\n");
}

const MCP_TOOL = "mcp__exa__web_search_exa";
const MCP_ARGS = { query: "pi coding agent", numResults: 5 };
const BASH_ARGS = { command: "npm run check", timeout: 300 };
const GIT_STATUS = [
	"On branch main",
	"Your branch is ahead of 'origin/main' by 2 commits.",
	"",
	"Changes not staged for commit:",
	"\tmodified:   src/a.ts",
	"\tdeleted:    src/old.ts",
	"",
	"Untracked files:",
	"\tnotes.txt",
].join("\n");
const GIT_DIFF = [
	"diff --git a/notes.txt b/notes.txt",
	"index 1111111..2222222 100644",
	"--- a/notes.txt",
	"+++ b/notes.txt",
	"@@ -1,3 +1,3 @@",
	" alpha",
	"-beta",
	"+BETA",
	" gamma",
].join("\n");
const GH_PR_VIEW = ["title:\tFixture PR", "state:\tOPEN", "number:\t42", "--", "Body line one", "Body line two"].join("\n");
const QUICK_EDIT_OUTPUT = ["Applied 1 edit to src/plan.txt", "── diff ──", ":2", "- beta", "+ BETA", "---"].join("\n");
const EDIT_DIFF = ["  1 alpha", "- 2 beta", "+ 2 BETA", "  3 gamma", "+ 4 delta"].join("\n");
/** A one-line change inside a long run of unchanged lines, as Pi's diff sends it. */
const EDIT_DIFF_LONG_CONTEXT = [
	...Array.from({ length: 4 }, (_, index) => `  ${index + 1} row ${index + 1}`),
	"- 5 row 5",
	"+ 5 ROW 5",
	...Array.from({ length: 9 }, (_, index) => `  ${index + 6} row ${index + 6}`),
].join("\n");
const TODOS = [
	{ content: "Reproduce the failure", status: "completed" },
	{ content: "Fix the expiry check", status: "in_progress" },
	{ content: "Run the full suite", status: "pending" },
];

interface GoldenCase {
	readonly id: string;
	/** The one tool a single-step case drives (the expand-hint property replays it). */
	readonly step?: ToolStep;
	render(width: number): string[];
}

function single(id: string, step: ToolStep): GoldenCase {
	return { id, step, render: (width) => runTool(step).paint(width) };
}

const TOOL_CASES: readonly GoldenCase[] = [
	single("fallback/pending", { tool: MCP_TOOL, args: MCP_ARGS, phase: "pending" }),
	single("fallback/running", { tool: MCP_TOOL, args: MCP_ARGS, phase: "running" }),
	single("fallback/streaming", { tool: MCP_TOOL, args: MCP_ARGS, phase: "streaming", partial: text("Result 1\nResult 2") }),
	single("fallback/settled", {
		tool: MCP_TOOL,
		args: MCP_ARGS,
		partial: text("Result 1\nResult 2"),
		result: text("Result 1\nResult 2\nResult 3"),
	}),
	single("fallback/error", { tool: MCP_TOOL, args: MCP_ARGS, result: text("Request failed: 429 Too Many Requests"), isError: true }),
	single("fallback/empty", { tool: "todo_write", args: { todos: [] }, result: text("") }),
	single("fallback/long-collapsed", { tool: MCP_TOOL, args: MCP_ARGS, result: text(numbered(14, "result")) }),
	single("fallback/long-expanded", { tool: MCP_TOOL, args: MCP_ARGS, result: text(numbered(14, "result")), expanded: true }),
	single("todo/settled", { tool: "todo_write", args: { todos: TODOS }, result: text("Todos updated") }),
	// pi-todo: an update names ids only; the resulting list comes back in details.
	single("todo/update-from-details", {
		tool: "todo_update",
		args: { updates: [{ id: "t2", status: "completed" }] },
		result: text("Updated 1 todo", {
			todos: [
				{ id: "t1", content: "Reproduce the failure", status: "completed" },
				{ id: "t2", content: "Fix the expiry check", status: "completed" },
				{ id: "t3", content: "Drop the legacy path", status: "cancelled" },
				{ id: "t4", content: "Run the full suite", status: "in_progress" },
			],
		}),
	}),
	single("bash/pending", { tool: "bash", args: BASH_ARGS, phase: "pending" }),
	single("bash/running", { tool: "bash", args: BASH_ARGS, phase: "running" }),
	single("bash/streaming", { tool: "bash", args: BASH_ARGS, phase: "streaming", partial: text("typecheck passed\n") }),
	single("bash/settled", {
		tool: "bash",
		args: BASH_ARGS,
		partial: text("typecheck passed\n"),
		result: text("typecheck passed\ntests 24 passed\nbuild complete"),
	}),
	single("bash/exit-1", { tool: "bash", args: { command: "npm test" }, result: text("1 failing\n\nCommand exited with code 1"), isError: true }),
	single("bash/timeout", {
		tool: "bash",
		args: { command: "sleep 400", timeout: 300 },
		result: text("partial output\n\nCommand timed out after 300 seconds"),
		isError: true,
	}),
	single("bash/empty", { tool: "bash", args: { command: "true" }, result: text("") }),
	single("bash/multiline-command", { tool: "bash", args: { command: "cd /repo\nnpm ci\nnpm run build" }, result: text("built") }),
	single("bash/long-collapsed", { tool: "bash", args: { command: "seq 30" }, result: text(numbered(30)) }),
	single("bash/long-expanded", { tool: "bash", args: { command: "seq 30" }, result: text(numbered(30)), expanded: true }),
	single("bash/git-status", { tool: "bash", args: { command: "git status" }, result: text(GIT_STATUS) }),
	single("bash/git-diff", { tool: "bash", args: { command: "git diff" }, result: text(GIT_DIFF) }),
	single("bash/gh-pr-view", { tool: "bash", args: { command: "gh pr view 42" }, result: text(GH_PR_VIEW) }),
	single("bash/git-diff-empty", { tool: "bash", args: { command: "git diff" }, result: text("") }),
	single("bash/gh-run-job", {
		tool: "bash",
		args: { command: "gh run view --job=123 --log" },
		result: text("build\tSet up job\tok\nbuild\tRun tests\tpassed"),
	}),
	// Lists longer than their collapsed head: Ctrl+O shows the rest.
	single("bash/ls-many", { tool: "bash", args: { command: "ls src" }, result: text(names(10, (n) => `file${n}.ts`)) }),
	single("bash/find-many", {
		tool: "bash",
		args: { command: "find src -name '*.ts'" },
		result: text(names(10, (n) => `src/lib/file${n}.ts`)),
	}),
	single("ls/many", { tool: "ls", args: { path: "src" }, result: text(names(10, (n) => `file${n}.ts`)) }),
	single("bash/git-status-many", {
		tool: "bash",
		args: { command: "git status" },
		result: text(["On branch main", "Changes not staged for commit:", names(8, (n) => `\tmodified:   src/file${n}.ts`)].join("\n")),
	}),
	single("bash/git-log-many", {
		tool: "bash",
		args: { command: "git log --oneline" },
		result: text(names(8, (n) => `${(0xabc1230 + n).toString(16)} Commit number ${n}`)),
	}),
	single("bash/gh-pr-list-many", {
		tool: "bash",
		args: { command: "gh pr list" },
		result: text(names(8, (n) => `${40 + n}\tFixture PR ${n}\tfeature-${n}\tOPEN\t2026-10-01T00:00:00Z`)),
	}),
	single("bash/gh-pr-view-long-body", {
		tool: "bash",
		args: { command: "gh pr view 42" },
		result: text(["title:\tFixture PR", "state:\tOPEN", "number:\t42", "--", names(12, (n) => `Body line ${n}`)].join("\n")),
	}),
	single("bash/ls", { tool: "bash", args: { command: "ls src" }, result: text("a.ts\nb.ts\nlib/") }),
	single("bash/find", { tool: "bash", args: { command: "find src -name '*.ts'" }, result: text("src/a.ts\nsrc/lib/b.ts") }),
	// Shapes seen from a real Pi 1.1 session (openai-codex): null optional
	// arguments, a search in the current directory, Pi's literal "(no output)",
	// and content ending with a newline.
	single("read/null-optional-args", { tool: "read", args: { path: "/repo/src/auth.ts", offset: 1, limit: null }, result: text("a\nb") }),
	single("find/current-directory", { tool: "find", args: { pattern: "*.ts" }, result: text("src/a.ts") }),
	single("bash/no-output-exit-3", {
		tool: "bash",
		args: { command: "node -e \"process.exit(3)\"" },
		result: text("(no output)\n\nCommand exited with code 3"),
		isError: true,
	}),
	single("write/trailing-newline", {
		tool: "write",
		args: { path: "/repo/notes/summary.txt", content: "one\ntwo\nthree\n" },
		result: text("Successfully wrote 14 bytes"),
	}),
	single("read/lone", { tool: "read", args: { path: "/repo/docs/decisions/D-9cpa.md", offset: 10, limit: 20 }, result: text("body") }),
	single("read/error", { tool: "read", args: { path: "/repo/missing.md" }, result: text("ENOENT: no such file or directory"), isError: true }),
	single("ls/lone", { tool: "ls", args: { path: "src" }, result: text("a.ts\nb.ts\nlib/") }),
	single("find/lone", { tool: "find", args: { pattern: "*.ts", path: "src" }, result: text("src/a.ts\nsrc/lib/b.ts") }),
	single("grep/settled", {
		tool: "grep",
		args: { pattern: "renderStatus", path: "src" },
		result: text(
			[
				"src/a.ts:4: import { renderStatus } from './status.js'",
				"src/a.ts:54: export function renderStatus(",
				"src/b.ts:4: renderStatus()",
			].join("\n"),
		),
	}),
	single("grep/one-match", {
		tool: "grep",
		args: { pattern: "renderStatus", path: "src" },
		result: text("src/a.ts:54: export function renderStatus("),
	}),
	single("grep/many-matches", {
		tool: "grep",
		args: { pattern: "row", path: "src" },
		result: text(Array.from({ length: 12 }, (_, index) => `src/rows.ts:${index + 1}: row ${index + 1}`).join("\n")),
	}),
	single("bash/grep-many-matches", {
		tool: "bash",
		args: { command: "grep -rn row src" },
		result: text(Array.from({ length: 12 }, (_, index) => `src/rows.ts:${index + 1}:row ${index + 1}`).join("\n")),
	}),
	single("edit/diff", {
		tool: "edit",
		args: { path: "/repo/src/plan.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
		result: text("Successfully replaced text in src/plan.txt.", { diff: EDIT_DIFF }),
	}),
	single("edit/long-context", {
		tool: "edit",
		args: { path: "/repo/src/rows.txt", edits: [{ oldText: "row 5", newText: "ROW 5" }] },
		result: text("Successfully replaced text in src/rows.txt.", { diff: EDIT_DIFF_LONG_CONTEXT }),
	}),
	// Pi's own shape: four context lines each side, then its numberless `...` row.
	single("edit/pi-skip-marker", {
		tool: "edit",
		args: { path: "/repo/src/rows.txt", edits: [{ oldText: "row 5", newText: "ROW 5" }] },
		result: text("Successfully replaced text in src/rows.txt.", {
			diff: [
				...Array.from({ length: 4 }, (_, index) => ` ${String(index + 1).padStart(2)} row ${index + 1}`),
				"- 5 row 5",
				"+ 5 ROW 5",
				...Array.from({ length: 4 }, (_, index) => ` ${String(index + 6).padStart(2)} row ${index + 6}`),
				`  ${"".padStart(2)} ...`.slice(1),
			].join("\n"),
		}),
	}),
	single("edit/long-context-expanded", {
		tool: "edit",
		args: { path: "/repo/src/rows.txt", edits: [{ oldText: "row 5", newText: "ROW 5" }] },
		result: text("Successfully replaced text in src/rows.txt.", { diff: EDIT_DIFF_LONG_CONTEXT }),
		expanded: true,
	}),
	single("edit/error", {
		tool: "edit",
		args: { path: "/repo/src/plan.txt" },
		result: text("Could not find the exact text in src/plan.txt"),
		isError: true,
	}),
	single("edit/no-diff", { tool: "edit", args: { path: "/repo/src/plan.txt" }, result: text("Edit applied") }),
	single("quick-edit/diff", { tool: "quick_edit", args: { path: "/repo/src/plan.txt" }, result: text(QUICK_EDIT_OUTPUT) }),
	single("write/settled", {
		tool: "write",
		args: { path: "/repo/notes/todo.txt", content: "one\ntwo\nthree" },
		result: text("Successfully wrote 13 bytes to notes/todo.txt"),
	}),
	single("write/long-collapsed", {
		tool: "write",
		args: { path: "/repo/notes/long.txt", content: numbered(20) },
		result: text("Successfully wrote 130 bytes to notes/long.txt"),
	}),
	single("write/error", {
		tool: "write",
		args: { path: "/repo/notes/todo.txt", content: "x" },
		result: text("EACCES: permission denied"),
		isError: true,
	}),
	{
		id: "read/batch-of-three",
		render(width) {
			const painters = ["a.ts", "b.ts", "c.ts"].map((name) =>
				runTool({ tool: "read", args: { path: `/repo/src/${name}` }, phase: "running" }),
			);
			const settled = ["a.ts", "b.ts", "c.ts"].map((name, index) =>
				runTool({ tool: "read", args: { path: `/repo/src/${name}` }, result: text("body") }, painters[index]?.toolCallId),
			);
			return settled.flatMap((painter) => painter.paint(width));
		},
	},
	single("ask/header-labels", {
		tool: "ask_user_question",
		args: {
			questions: [
				{ id: "fix", header: "Fix", question: "Which fix?", options: [{ value: "a", label: "Use <=" }] },
				{ id: "scope", header: "Scope", question: "Where?", options: [{ value: "b", label: "auth.ts" }] },
			],
		},
		result: text("Fix: Use <=\nScope: auth.ts"),
	}),
	{
		// A failed tool stays on its own row; the summary of the rest stays green.
		id: "turn/with-failure",
		render(width) {
			const steps: ToolStep[] = [
				{ tool: "read", args: { path: "/repo/src/a.ts" }, result: text("body") },
				{ tool: "bash", args: { command: "npm test" }, result: text("1 failing\n\nCommand exited with code 1"), isError: true },
			];
			const settled = steps.map((step) => ({ step, painter: runTool(step) }));
			beginAgentRun();
			registerTurnFromMessage(
				{
					content: settled.map(({ step, painter }) => ({ type: "toolCall", id: painter.toolCallId, name: step.tool })),
				},
				settled.map(({ step, painter }) => ({ toolCallId: painter.toolCallId, isError: Boolean(step.isError) })),
			);
			finishAgentRun();
			const painters = settled.map(({ step, painter }) =>
				pass(
					step,
					contextFor(step, painter.toolCallId, painter.state, {
						executionStarted: true,
						isPartial: false,
						isError: Boolean(step.isError),
					}),
					{ value: step.result ?? { content: [], details: {} }, isPartial: false },
				),
			);
			return painters.flatMap((paint) => paint(width));
		},
	},
	{
		// Extension tools share one summary clause: `used vcc_recall, mcp ×2 and web_fetch`.
		id: "turn/extension-tools",
		render(width) {
			const steps: ToolStep[] = [
				{ tool: "read", args: { path: "/repo/src/a.ts" }, result: text("body") },
				{ tool: "vcc_recall", args: { query: "expiry" }, result: text("No matches") },
				{ tool: "mcp", args: { search: "files" }, result: text("0 tools") },
				{ tool: "mcp", args: { search: "git" }, result: text("0 tools") },
				{ tool: "web_fetch", args: { url: "http://127.0.0.1/" }, result: text("page") },
			];
			const settled = steps.map((step) => ({ step, painter: runTool(step) }));
			beginAgentRun();
			registerTurnFromMessage(
				{
					content: settled.map(({ step, painter }) => ({ type: "toolCall", id: painter.toolCallId, name: step.tool })),
				},
				settled.map(({ painter }) => ({ toolCallId: painter.toolCallId, isError: false })),
			);
			finishAgentRun();
			const painters = settled.map(({ step, painter }) =>
				pass(step, contextFor(step, painter.toolCallId, painter.state, { executionStarted: true, isPartial: false }), {
					value: step.result ?? { content: [], details: {} },
					isPartial: false,
				}),
			);
			return painters.flatMap((paint) => paint(width));
		},
	},
	{
		// Inline keeps the todo checklist in place; boxed folds it into the summary.
		id: "turn/keeps-todos-inline",
		render(width) {
			const steps: ToolStep[] = [
				{ tool: "read", args: { path: "/repo/src/a.ts" }, result: text("body") },
				{ tool: "todo_write", args: { todos: TODOS }, result: text("Saved 3 todos") },
			];
			const settled = steps.map((step) => ({ step, painter: runTool(step) }));
			beginAgentRun();
			registerTurnFromMessage(
				{
					content: settled.map(({ step, painter }) => ({ type: "toolCall", id: painter.toolCallId, name: step.tool })),
				},
				settled.map(({ painter }) => ({ toolCallId: painter.toolCallId, isError: false })),
			);
			finishAgentRun();
			const painters = settled.map(({ step, painter }) =>
				pass(step, contextFor(step, painter.toolCallId, painter.state, { executionStarted: true, isPartial: false }), {
					value: step.result ?? { content: [], details: {} },
					isPartial: false,
				}),
			);
			return painters.flatMap((paint) => paint(width));
		},
	},
	{
		id: "turn/collapsed-run",
		render(width) {
			const steps: ToolStep[] = [
				{ tool: "read", args: { path: "/repo/src/a.ts" }, result: text("body") },
				{ tool: "bash", args: { command: "npm test" }, result: text("ok") },
				{ tool: "bash", args: { command: "npm run build" }, result: text("built") },
				{ tool: "ls", args: { path: "src" }, result: text("a.ts\nb.ts") },
				{
					tool: "edit",
					args: { path: "/repo/src/plan.txt" },
					result: text("Successfully replaced text.", { diff: EDIT_DIFF }),
				},
			];
			const settled = steps.map((step) => ({ step, painter: runTool(step) }));
			beginAgentRun();
			registerTurnFromMessage(
				{
					content: settled.map(({ step, painter }) => ({ type: "toolCall", id: painter.toolCallId, name: step.tool })),
				},
				settled.map(({ painter }) => ({ toolCallId: painter.toolCallId, isError: false })),
			);
			finishAgentRun();
			// The run ends long after its tools settled: the summary must total the
			// tools' own time, not the time until collapse.
			clock = 60_000;
			// agent_end re-runs every member's updateDisplay; Pi paints afterwards.
			const painters = settled.map(({ step, painter }) =>
				pass(step, contextFor(step, painter.toolCallId, painter.state, { executionStarted: true, isPartial: false }), {
					value: step.result ?? { content: [], details: {} },
					isPartial: false,
				}),
			);
			return painters.flatMap((paint) => paint(width));
		},
	},
];

const NARROW_IDS = new Set([
	"fallback/settled",
	"bash/settled",
	"bash/exit-1",
	"bash/long-collapsed",
	"edit/diff",
	"write/settled",
	"write/long-collapsed",
	"grep/settled",
	"grep/many-matches",
]);

interface Variant {
	readonly chrome: "boxed" | "light" | "inline";
	readonly width: number;
}

const VARIANTS: readonly Variant[] = [
	{ chrome: "boxed", width: 80 },
	{ chrome: "light", width: 80 },
	{ chrome: "inline", width: 80 },
	{ chrome: "boxed", width: 36 },
	{ chrome: "light", width: 36 },
	{ chrome: "inline", width: 36 },
];

/** Inline chrome ships with the claude-code preset; the frames with claude. */
function toolsConfigFor(variant: Variant) {
	const preset = variant.chrome === "inline" ? "claude-code" : "claude";
	const { config } = resolveConfigDetailed({ global: { preset }, projectTrusted: true });
	return { ...config.tools, batchOpenGlyph: "●", nerdFonts: false };
}

function casesFor(variant: Variant): readonly GoldenCase[] {
	return variant.width >= 80 ? TOOL_CASES : TOOL_CASES.filter((entry) => NARROW_IDS.has(entry.id));
}

function sectionKey(variant: Variant, id: string): string {
	return `${variant.chrome} · w${variant.width} · ${id}`;
}

const expectedLayout = readGoldenSections(LAYOUT_FILE);
const expectedStyled = readGoldenSections(STYLED_FILE);
const actualLayout = new Map<string, string>();
const actualStyled = new Map<string, string>();

// ── Harness ─────────────────────────────────────────────────────────────────

const originalKeybindings = getKeybindings();

before(() => {
	mock.method(performance, "now", () => clock);
	setKeybindings(
		new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as const, {}),
	);
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	setBoxTheme(theme);
});

function resetRegistries(): void {
	stopAllElapsedTickers();
	resetBatchRegistry();
	resetTurnRegistry();
	resetGrepRegistry();
	resetBashTreeRegistry();
	resetToolRowHints();
	clearPresentationTui();
	callSequence = 0;
}

beforeEach(resetRegistries);
afterEach(resetRegistries);

after(() => {
	setBoxChrome("boxed");
	setBoxTheme(undefined);
	setKeybindings(originalKeybindings);
	mock.restoreAll();
	if (!UPDATE_GOLDEN) return;
	writeGoldenSections(LAYOUT_FILE, "Tool presentation golden — layout (¶ marks end of line)", SOURCE, actualLayout);
	writeGoldenSections(STYLED_FILE, "Tool presentation golden — styled ({token} … {/} = theme.fg)", SOURCE, actualStyled);
});

for (const variant of VARIANTS) {
	for (const entry of casesFor(variant)) {
		const key = sectionKey(variant, entry.id);
		test(`golden: ${key}`, () => {
			setBoxChrome(variant.chrome);
			setToolsRenderConfig(toolsConfigFor(variant));
			const lines = entry.render(variant.width);
			for (const [index, line] of lines.entries()) {
				assert.ok(
					visibleWidth(line) <= variant.width,
					`line ${index + 1} is ${visibleWidth(line)} columns wide at width ${variant.width}: ${plainLine(line)}`,
				);
			}
			const layout = layoutOf(lines);
			const style = lines.map(styledLine).join("\n");
			actualLayout.set(key, layout);
			actualStyled.set(key, style);
			if (UPDATE_GOLDEN) return;
			assert.ok(expectedLayout.has(key), `missing golden section "${key}"; run UPDATE_GOLDEN=1 npm test`);
			assert.equal(layout, expectedLayout.get(key), `layout changed for ${key}`);
			assert.equal(style, expectedStyled.get(key), `styling changed for ${key}`);
		});
	}
}

// ── Expand-hint property ─────────────────────────────────────────────────────
// A collapsed block may offer Ctrl+O only when expanding shows something it did
// not: every settled single-tool case is painted both ways in every chrome, and
// a hint whose expanded paint adds no line is a false promise.

/** The full hint, or the bare key a narrow row shrinks it to, whole at the end of a row. */
const EXPAND_HINT = /Ctrl\+O(?: to expand)?$/;

/** A painted line without ANSI, frame glyphs or trailing blanks. */
function unframed(line: string): string {
	return plainLine(line)
		.replace(/[─│╭╮╰╯┌┐└┘├┤]/g, "")
		.trimEnd();
}

/** Content of a painted line, without the hint, frame glyphs and separators. */
function hintFreeContent(line: string): string {
	return unframed(line)
		.replace(EXPAND_HINT, "")
		.replace(/(?:\s*[·…]\s*)+$/u, "")
		.trim();
}

function paintedContent(step: ToolStep, expanded: boolean, width: number): { hint: boolean; lines: Set<string> } {
	resetRegistries();
	const lines = runTool({ ...step, expanded }).paint(width);
	return {
		hint: lines.some((line) => EXPAND_HINT.test(unframed(line))),
		lines: new Set(lines.map(hintFreeContent).filter(Boolean)),
	};
}

for (const variant of VARIANTS) {
	test(`expand hints promise new lines: ${variant.chrome} · w${variant.width}`, () => {
		setBoxChrome(variant.chrome);
		setToolsRenderConfig(toolsConfigFor(variant));
		const falsePromises: string[] = [];
		const stillOffered: string[] = [];
		const unannounced: string[] = [];
		for (const entry of TOOL_CASES) {
			const step = entry.step;
			if (!step || (step.phase ?? "settled") !== "settled" || step.expanded) continue;
			const collapsed = paintedContent(step, false, variant.width);
			const expanded = paintedContent(step, true, variant.width);
			const added = [...expanded.lines].filter((line) => !collapsed.lines.has(line));
			if (collapsed.hint && added.length === 0) falsePromises.push(entry.id);
			if (expanded.hint) stillOffered.push(entry.id);
			if (!collapsed.hint && added.length > 0) unannounced.push(entry.id);
		}
		assert.deepEqual(falsePromises, [], "these collapsed blocks offer Ctrl+O but expanding adds nothing");
		assert.deepEqual(stillOffered, [], "these blocks still offer Ctrl+O once expanded");
		assert.deepEqual(unannounced, [], "expanding these shows more, but the collapsed block never says so");
	});
}

// ── Inline gutter property ───────────────────────────────────────────────────
// Every inline block is a `●` row and one result gutter: a second `⎿` under the
// same marker means two components each opened it (a call card and its result).

test("inline blocks open the result gutter once", () => {
	setBoxChrome("inline");
	for (const width of [80, 36]) {
		setToolsRenderConfig(toolsConfigFor({ chrome: "inline", width }));
		const reopened: string[] = [];
		for (const entry of TOOL_CASES) {
			resetRegistries();
			let openers = 0;
			for (const line of entry.render(width).map(plainLine)) {
				if (line.startsWith("●")) openers = 0;
				if (/^ {2}⎿/.test(line) && ++openers === 2) reopened.push(entry.id);
			}
		}
		assert.deepEqual(reopened, [], `w${width}: these blocks open a second gutter under one marker`);
	}
});

// ── Boxed batches ────────────────────────────────────────────────────────────
// Batches are multi-step, so the expand-hint property never replays them; the
// same promise is checked here: Ctrl+O while rows are left out, and expanding
// paints them.

function paintBatch(tool: string, members: ReadonlyArray<{ args: Record<string, unknown>; output: string }>, expanded: boolean) {
	resetRegistries();
	const running = members.map(({ args }) => runTool({ tool, args, phase: "running" }));
	const settled = members.map(({ args, output }, index) =>
		runTool({ tool, args, result: text(output), expanded }, running[index]?.toolCallId),
	);
	return settled.flatMap((painter) => painter.paint(80)).map(plainLine);
}

test("boxed batches show their hidden members and files on Ctrl+O", () => {
	for (const chrome of ["boxed", "light"] as const) {
		setBoxChrome(chrome);
		setToolsRenderConfig(toolsConfigFor({ chrome, width: 80 }));
		const reads = Array.from({ length: 7 }, (_, index) => ({ args: { path: `/repo/src/f${index + 1}.ts` }, output: "body" }));
		const collapsedReads = paintBatch("read", reads, false);
		assert.ok(collapsedReads.some((line) => /2 more · Ctrl\+O to expand/.test(line)), `${chrome}: collapsed reads offer the rest`);
		assert.ok(!collapsedReads.some((line) => line.includes("src/f7.ts")));
		const expandedReads = paintBatch("read", reads, true);
		assert.ok(expandedReads.some((line) => line.includes("src/f7.ts")), `${chrome}: expanded reads list every member`);
		assert.ok(!expandedReads.some((line) => /Ctrl\+O|more/.test(line)));

		const listing = names(6, (n) => `file${n}.ts`);
		const dirs = [{ args: { path: "src" }, output: listing }, { args: { path: "lib" }, output: listing }];
		const collapsedLs = paintBatch("ls", dirs, false);
		assert.ok(collapsedLs.some((line) => /… 2 more files · Ctrl\+O to expand/.test(line)), `${chrome}: collapsed members offer their files`);
		const expandedLs = paintBatch("ls", dirs, true);
		assert.equal(expandedLs.filter((line) => line.includes("file6.ts")).length, 2, `${chrome}: expanded members list every file`);
		assert.ok(!expandedLs.some((line) => /Ctrl\+O|more files/.test(line)));
	}
});

test("golden files carry no stale sections", () => {
	if (UPDATE_GOLDEN) return;
	const known = new Set(VARIANTS.flatMap((variant) => casesFor(variant).map((entry) => sectionKey(variant, entry.id))));
	const stale = [...expectedLayout.keys(), ...expectedStyled.keys()].filter((key) => !known.has(key));
	assert.deepEqual(stale, []);
});
