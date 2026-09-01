import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../extension-src/omp-theme/shared/ansi.js";
import { safeVisibleWidth } from "../extension-src/omp-theme/shared/render-budget.js";
import { resetBatchRegistry } from "../extension-src/omp-theme/features/tools/boxed/batch.js";
import { probePiCompatibility } from "../extension-src/omp-theme/pi/compatibility-probe.js";

function firstGlyphColumn(line: string): number {
	const index = stripAnsi(line).search(/\S/u);
	return index < 0 ? 0 : index;
}

function contentLines(component: ToolExecutionComponent, width: number): string[] {
	return component.render(width).filter((line) => stripAnsi(line).trim().length > 0);
}

const ui = {
	requestRender() {},
} as never;

const deeplyInsetCustomTool = {
	name: "web_fetch",
	label: "Web Fetch",
	description: "Runtime geometry fixture",
	parameters: {},
	execute: async () => ({ content: [{ type: "text", text: "fetched" }] }),
	renderCall: (_args: unknown, theme: { fg(color: string, text: string): string }) =>
		new Text(theme.fg("toolTitle", "     native Web Fetch"), 0, 0),
	renderResult: (
		_result: unknown,
		_options: unknown,
		theme: { fg(color: string, text: string): string },
	) => new Text(theme.fg("toolOutput", "     native fetched result"), 0, 0),
} as never;

test("Pi 0.84.4 ToolExecutionComponent renders quiet and custom tools on the same outer column", () => {
	initTheme("dark", false);
	resetBatchRegistry();
	const report = probePiCompatibility("0.84.4", {
		config: {
			tools: { enabled: true },
			messages: { enabled: false },
			theme: { cacheHighlight: false },
		},
		toolSnapshot: { style: "compact-box" },
	} as never);
	try {
		const certification = report.certification.filter((surface) => surface.feature === "tools");
		assert.ok(certification.length >= 2);
		assert.ok(certification.every((surface) => surface.status === "certified"));

		const firstRead = new ToolExecutionComponent(
			"read",
			"runtime-read-a",
			{ path: "src/a.ts" },
			{},
			undefined,
			ui,
			process.cwd(),
		);
		new ToolExecutionComponent(
			"read",
			"runtime-read-b",
			{ path: "src/b.ts" },
			{},
			undefined,
			ui,
			process.cwd(),
		);
		const custom = new ToolExecutionComponent(
			"web_fetch",
			"runtime-web-fetch",
			{ url: "https://example.test" },
			{},
			deeplyInsetCustomTool,
			ui,
			process.cwd(),
		);
		custom.updateResult(
			{ content: [{ type: "text", text: "fetched result" }], details: undefined, isError: false },
			false,
		);

		for (const width of [11, 12, 32, 89, 120]) {
			const readLines = contentLines(firstRead, width);
			const customLines = contentLines(custom, width);
			assert.equal(firstGlyphColumn(readLines[0] ?? ""), 0, `Read outer column at ${width}`);
			assert.equal(firstGlyphColumn(customLines[0] ?? ""), 0, `custom outer column at ${width}`);
			assert.ok([...readLines, ...customLines].every((line) => safeVisibleWidth(line) <= width));
			assert.ok(!customLines.join("\n").includes("native Web Fetch"));
			assert.ok(!customLines.join("\n").includes("native fetched result"));
		}

		const host = custom as unknown as {
			contentBox: { paddingX: number; paddingY: number };
		};
		assert.equal(host.contentBox.paddingX, 0);
		assert.equal(host.contentBox.paddingY, 0);
	} finally {
		report.disposeOwner();
		resetBatchRegistry();
	}
});
