import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import type { ResolvedTheme } from "../extension-src/omp-theme/domain/theme.js";
import { renderStartup, type StartupToolItem } from "../extension-src/omp-theme/features/startup/index.js";
import {
	renderWelcome,
	WELCOME_MAX_WIDTH,
	type WelcomeData,
	type WelcomeProvider,
} from "../extension-src/omp-theme/features/startup/welcome.js";
import { toolSourceLabel } from "../extension-src/omp-theme/pi/startup-resources.js";
import { stripAnsi, visibleWidth } from "../extension-src/omp-theme/shared/ansi.js";

const plainTheme: ResolvedTheme = {
	color: () => "",
	apply: (_token, text) => text,
	rainbow: (text) => text,
	glyph: () => "",
	mode: "unicode",
	noColor: true,
};
const uncolored = { fg: (_color: string, text: string) => text };
const { config } = resolveConfigDetailed({ global: { preset: "claude-code" }, projectTrusted: true });

const provider = (name: string, count: number): WelcomeProvider => ({
	name,
	tools: Array.from({ length: count }, (_, index) => `${name}_tool_${index + 1}`),
});
const session = (name: string, timeAgo: string) => ({ name, timeAgo });

function card(data: Partial<WelcomeData>, width = 100): string[] {
	return renderWelcome(
		plainTheme,
		{ label: "Pi v1.1.0", title: "Welcome back!", providers: [], sessions: [], ...data },
		width,
	).map(stripAnsi);
}

/** The text of one column of a card row: 0 is the left column, 1 the right. */
function column(line: string, index: 0 | 1): string {
	return line.split("│")[index + 1] ?? "";
}

test("the card keeps one height whatever it lists", () => {
	const heights = new Set<number>();
	for (const providers of [[], [provider("core", 4), provider("pi-ask", 1)], Array.from({ length: 8 }, (_, i) => provider(`ext${i}`, 2))]) {
		for (const sessions of [[], [1, 2, 3, 4].map((n) => session(`session ${n}`, `${n}h ago`))]) {
			heights.add(card({ providers, sessions }).length);
		}
	}
	assert.deepEqual([...heights], [17]);
});

test("both columns open and close with a blank row, and the title shares the tips row", () => {
	const lines = card({ providers: [provider("core", 4)], sessions: [session("fix grep", "2h ago")] });
	const body = lines.slice(1, -1);
	for (const index of [0, 1] as const) {
		assert.equal(column(body[0] ?? "", index).trim(), "", "a blank row under the top border");
		assert.equal(column(body.at(-1) ?? "", index).trim(), "", "a blank row over the bottom border");
	}
	assert.match(column(body[1] ?? "", 0), /Welcome back!/);
	assert.match(column(body[1] ?? "", 1), /^ {2}Tips {3}\/ {2}commands/);
	// `!!` runs a command without sending its output to the model (Pi's usage guide).
	assert.match(column(body[1] ?? "", 1), /!! {2}bash, not sent to model/);
});

test("a rule inset from the divider and the frame separates the right column's sections", () => {
	for (const providers of [[provider("core", 4)], Array.from({ length: 6 }, (_, i) => provider(`ext${i}`, 2))]) {
		const right = card({ providers, sessions: [session("fix grep", "2h ago")] })
			.slice(1, -1)
			.map((line) => column(line, 1));
		const rules = right.flatMap((line, index) => (/─/.test(line) ? [index] : []));
		assert.equal(rules.length, 2, "one rule under the tips, one under the providers");
		for (const index of rules) {
			assert.match(right[index] ?? "", /^ {2}─+ {2}$/, "the rule stops two columns short of each edge");
			assert.match(right[index + 1] ?? "", /^ {2}(Tool providers|Recent sessions)/, "a heading follows each rule");
		}
		assert.equal(rules[0], 2, "the first rule sits directly under the tips row");
		// The left column has no sections, so it has no rules.
		assert.ok(!card({ providers }).some((line) => /─/.test(column(line, 0))));
	}
});

test("more providers than slots end in a +N more row that names the rest", () => {
	const providers = [provider("core", 4), provider("pi-search", 8), provider("pi-teams", 7), provider("pi-todo", 3), provider("pi-ask", 1)];
	const right = card({ providers }).map((line) => column(line, 1));
	const start = right.findIndex((line) => line.includes("Tool providers"));
	const rows = right.slice(start + 1, start + 5).map((line) => line.trim());
	assert.match(rows[0] ?? "", /^core +4 +core_tool_1, core_tool_2/);
	assert.match(rows[1] ?? "", /^pi-search +8 /);
	assert.match(rows[1] ?? "", /\+\d+$/, "tool names that do not fit are counted");
	assert.match(rows[3] ?? "", /^\+2 more +pi-todo, pi-ask$/);
});

test("session ages share one right-aligned column", () => {
	const sessions = [session("a short title", "2h ago"), session("a much longer session title than the others", "15d ago")];
	const rows = card({ sessions }).map((line) => column(line, 1)).filter((line) => / ago/.test(line));
	assert.equal(rows.length, 2);
	const ends = rows.map((line) => line.trimEnd().length);
	assert.equal(ends[0], ends[1], "ages end in the same column");
	for (const line of rows) assert.ok(line.endsWith("  "), "the frame keeps two columns of padding");
});

test("the startup card sits on Pi's one-column gutter and stops growing at 100 columns", () => {
	const snapshot = { reason: "startup" as const, resources: { sessions: [] } };
	for (const width of [80, 100, 160]) {
		const lines = renderStartup(snapshot, config, uncolored, width);
		const frame = lines.map(stripAnsi).filter((line) => /[╭│╰]/.test(line));
		assert.ok(frame.length > 0);
		for (const line of frame) {
			assert.ok(line.startsWith(" ") && !line.startsWith("  "), `${width}: the card starts at column 1`);
			assert.ok(visibleWidth(line) <= Math.min(width - 1, WELCOME_MAX_WIDTH + 1), `${width}: ${line}`);
		}
	}
	// One blank row above; the transcript's own spacing follows below.
	const lines = renderStartup(snapshot, config, uncolored, 100).map(stripAnsi);
	assert.equal(lines[0], "");
	assert.ok(lines[1]?.includes("╭"));
	assert.ok(lines.at(-1)?.includes("╰"));
});

test("providers lead with core, then the largest sources", () => {
	const tool = (source: string, name: string): StartupToolItem => ({ source, name });
	const toolDetails = [
		tool("pi-ask", "ask_user_question"),
		tool("pi-search", "websearch"),
		tool("pi-search", "web_fetch"),
		tool("core", "read"),
		tool("pi-todo", "todo_read"),
		tool("pi-todo", "todo_write"),
		tool("pi-todo", "todo_update"),
	];
	const lines = renderStartup({ reason: "startup", resources: { toolDetails, sessions: [] } }, config, uncolored, 100);
	const names = lines
		.map((line) => column(stripAnsi(line), 1).trim())
		.filter((line) => /^(core|pi-\w+) +\d/.test(line))
		.map((line) => line.split(/ +/)[0]);
	assert.deepEqual(names, ["core", "pi-todo", "pi-search", "pi-ask"]);
});

test("source labels keep the package name, not its scope, version, or ref", () => {
	const label = (source: string) => toolSourceLabel({ source, path: "", baseDir: "" } as never);
	assert.equal(label("npm:@quandev104/pi-teams@0.1.6"), "pi-teams");
	assert.equal(label("npm:@heyhuynhgiabuu/pi-search"), "pi-search");
	assert.equal(label("npm:pi-mcp-adapter@2.1.0"), "pi-mcp-adapter");
	assert.equal(label("npm:pi-mcp-adapter"), "pi-mcp-adapter");
	assert.equal(label("git:github.com/QuangThai/pi-multi-pass@fix/authstorage-compat-pi-0-80-10"), "pi-multi-pass");
	assert.equal(label("git:github.com/earendil-works/pi-review"), "pi-review");
	assert.equal(label("git:git@github.com:owner/pi-tool.git"), "pi-tool");
	assert.equal(label("git:https://github.com/owner/pi-tool.git#v1"), "pi-tool");
	assert.equal(label("builtin"), "core");
});
