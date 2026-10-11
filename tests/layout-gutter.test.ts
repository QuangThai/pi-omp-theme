// Every row the theme draws sits on Pi's own gutter: `outputPad` columns (1
// unless the user turned it off) from each edge, where Pi starts its messages,
// tool output, and working row.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import { renderBashExecutionBox, setBashExecutionTheme } from "../extension-src/omp-theme/features/tools/bash-execution.js";
import { createToolDecorationOwner } from "../extension-src/omp-theme/features/tools/index.js";
import { installStatusLine } from "../extension-src/omp-theme/features/status-line/index.js";
import { setBoxChrome, setBoxTheme } from "../extension-src/omp-theme/shared/box.js";
import { stripAnsi, visibleWidth } from "../extension-src/omp-theme/shared/ansi.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function leftColumn(line: string): number {
	return stripAnsi(line).search(/\S/);
}

test("the status row keeps one column clear on each side", () => {
	const { config } = resolveConfigDetailed({ global: { preset: "claude-code" }, projectTrusted: true });
	const widgets = new Map<string, unknown>();
	const installation = installStatusLine({
		host: {
			setWidget: (key, content) => widgets.set(key, content),
			setFooter: () => {},
		},
		config,
		generation: 1,
		initialSnapshot: { model: "gpt-6-astra", cwd: "D:/work/project" },
	});
	try {
		const factory = widgets.get(installation.primaryKey) as (
			tui: object,
			theme: object,
		) => { render(width: number): string[] };
		for (const width of [40, 80, 120]) {
			const [row] = factory({}, theme).render(width);
			assert.ok(row, `${width}: a status row renders`);
			assert.equal(leftColumn(row), 1, `${width}: ${stripAnsi(row)}`);
			assert.ok(visibleWidth(row) <= width - 1, `${width}: the last column stays clear`);
		}
	} finally {
		installation.dispose();
	}
});

function userBash(outputPad: number | undefined) {
	return {
		command: "npm test",
		status: "complete",
		exitCode: 0,
		piOmpThemeStart: 1_000,
		...(outputPad === undefined ? {} : { outputPad }),
		contentContainer: { render: () => [" $ npm test", " ", " ✓ 12 passed"] },
	};
}

test("a user bash block follows Pi's output padding in every chrome", () => {
	setBashExecutionTheme(theme);
	setBoxTheme(theme);
	try {
		for (const chrome of ["boxed", "light", "inline"] as const) {
			setBoxChrome(chrome);
			for (const [pad, column] of [
				[undefined, 1],
				[1, 1],
				[0, 0],
			] as const) {
				const lines = (renderBashExecutionBox(userBash(pad), [60]) ?? []).filter((line) => stripAnsi(line).trim());
				assert.ok(lines.length > 0);
				assert.equal(Math.min(...lines.map(leftColumn)), column, `${chrome}, outputPad ${pad}`);
				for (const line of lines) assert.ok(visibleWidth(line) <= 60 - column, `${chrome}: ${stripAnsi(line)}`);
			}
		}
	} finally {
		setBoxChrome("boxed");
		setBashExecutionTheme(undefined);
		setBoxTheme(undefined);
	}
});

test("a self-shell tool gets the gutter Pi gives boxed tool output", () => {
	// Pi's edit tool renders into a plain Container that Pi never pads.
	const owner = createToolDecorationOwner({ style: "compact-box" });
	setBoxTheme(theme);
	try {
		for (const chrome of ["boxed", "light", "inline"] as const) {
			setBoxChrome(chrome);
			const contentBox = { paddingX: 1, paddingY: 1, setBgFn() {} };
			const selfRenderContainer = { setBgFn() {} };
			const instance = { toolName: "edit", outputPad: 1, getRenderShell: () => "self", contentBox, selfRenderContainer };
			const renderer = owner.decorateToolRendererSelection("tool-call-renderer", () => undefined, instance, []) as (
				...args: unknown[]
			) => { render(width: number): string[] };
			const component = renderer({ path: "README.md" }, theme, {
				args: { path: "README.md" },
				toolCallId: `edit-${chrome}`,
				invalidate() {},
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: false,
				argsComplete: true,
				isPartial: true,
				expanded: false,
				showImages: false,
				isError: false,
			});
			const lines = component.render(80).filter((line) => stripAnsi(line).trim());
			assert.ok(lines.length > 0, chrome);
			assert.equal(Math.min(...lines.map(leftColumn)), 1, `${chrome}: ${lines.map(stripAnsi).join(" / ")}`);
			for (const line of lines) assert.ok(visibleWidth(line) <= 79, `${chrome}: ${stripAnsi(line)}`);
		}
	} finally {
		owner.dispose();
		setBoxChrome("boxed");
		setBoxTheme(undefined);
	}
});
