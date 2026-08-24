import assert from "node:assert/strict";
import { test } from "node:test";
import { createDoctor } from "../extension-src/omp-theme/app/doctor.js";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import { renderStatus } from "../extension-src/omp-theme/domain/status-renderer.js";
import { createBuiltinSegments, type StatusSnapshot } from "../extension-src/omp-theme/domain/status.js";
import type { ResolvedTheme } from "../extension-src/omp-theme/domain/theme.js";
import { visibleWidth } from "../extension-src/omp-theme/shared/ansi.js";

const theme: ResolvedTheme = {
	color: () => "",
	apply: (_token, text) => text,
	rainbow: (text) => text,
	glyph: () => "",
	mode: "ascii",
	noColor: true,
};

test("claude preset resolves its coordinated editor and status composition", () => {
	const result = resolveConfigDetailed({ global: { preset: "claude" } });

	assert.equal(result.config.placement, "below");
	assert.equal(result.config.editor.style, "dock");
	assert.equal(result.config.editor.frame, "claude");
	assert.equal(result.config.statusLine.separator, "|");
	assert.deepEqual(result.config.statusLine.layout, {
		left: ["model_effort", "path", "git", "claude_context"],
		right: [],
		secondary: [],
	});
	assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE"));
});

test("doctor warns when explicit values turn a coordinated preset into a hybrid", () => {
	const result = resolveConfigDetailed({
		global: {
			preset: "claude",
			placement: "border",
			editor: { frame: "rounded" },
			statusLine: { layout: { left: ["path", "git", "context_bar", "cost"] } },
		},
	});
	const warning = result.diagnostics.find((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE");

	assert.ok(warning);
	assert.equal(warning.level, "warning");
	assert.match(warning.message, /preset "claude"/);
	assert.match(warning.message, /placement \(global\)/);
	assert.match(warning.message, /editor\.frame \(global\)/);
	assert.match(warning.message, /statusLine\.layout\.left \(global\)/);

	const doctor = createDoctor({ config: result.config, diagnostics: result.diagnostics, surfaces: {} });
	assert.deepEqual(doctor.diagnostics, result.diagnostics);
});

test("preset guardrails follow trusted project, environment, and session precedence", () => {
	const cases = [
		{
			label: "project",
			sources: { global: { preset: "claude" }, project: { placement: "border" } },
			source: "project",
		},
		{
			label: "environment",
			sources: { global: { preset: "claude" }, environment: { PI_OMP_THEME_STATUS: "above" } },
			source: "environment",
		},
		{
			label: "session",
			sources: { global: { preset: "claude" }, session: { placement: "border" } },
			source: "session",
		},
	] as const;

	for (const entry of cases) {
		const result = resolveConfigDetailed(entry.sources);
		const warning = result.diagnostics.find((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE");
		assert.ok(warning, `${entry.label} override was not diagnosed`);
		assert.match(warning.message, new RegExp(`placement \\(${entry.source}\\)`));
	}

	const untrusted = resolveConfigDetailed({
		global: { preset: "claude" },
		project: { placement: "border" },
		projectTrusted: false,
	});
	assert.ok(!untrusted.diagnostics.some((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE"));

	const repairedBySession = resolveConfigDetailed({
		global: { preset: "claude", placement: "border" },
		session: { placement: "below" },
	});
	assert.equal(repairedBySession.sources.placement, "session");
	assert.ok(!repairedBySession.diagnostics.some((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE"));
});

test("preset warning remains visible when invalid leaves fill the diagnostic budget", () => {
	const invalidLeaves = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`unknown${index}`, true]));
	const result = resolveConfigDetailed({
		global: { preset: "claude", placement: "border", ...invalidLeaves },
	});

	assert.equal(result.diagnostics.length, 32);
	assert.equal(result.diagnostics[0]?.code, "CFG-PRESET-OVERRIDE");
});

test("matching explicit values and unrelated customization do not trigger preset warnings", () => {
	const result = resolveConfigDetailed({
		global: {
			preset: "omp",
			placement: "border",
			editor: { style: "dock", frame: "rounded" },
			theme: { autoApply: "titanium-light" },
		},
	});

	assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "CFG-PRESET-OVERRIDE"));
});

test("claude status keeps context visible and respects narrow terminal widths", () => {
	const { config } = resolveConfigDetailed({ global: { preset: "claude" } });
	const snapshot: StatusSnapshot = {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
		cwd: "D:/Personal/a-very-long-project-name",
		git: {
			available: true,
			branch: "feature/a-long-branch-name",
			staged: 0,
			unstaged: 1,
			untracked: 0,
			refreshing: false,
		},
		context: { currentTokens: 19_200, windowTokens: 272_000 },
	};

	for (const width of [10, 24, 48]) {
		const rendered = renderStatus(config.statusLine.layout, snapshot, width, {
			separator: config.statusLine.separator,
			segments: createBuiltinSegments(),
			theme,
			options: { claude_context: { width: config.statusLine.contextBarWidth } },
		});
		assert.ok(rendered.visibleSegments.includes("claude_context"), `context missing at width ${width}`);
		assert.ok(rendered.lines.every((line) => visibleWidth(line) <= width), `row overflow at width ${width}`);
	}
});

test("omp and claude presets do not inherit default secondary status items", () => {
	for (const preset of ["omp", "claude"] as const) {
		const { config } = resolveConfigDetailed({ global: { preset } });
		assert.deepEqual(config.statusLine.layout.secondary, []);
		assert.ok(!config.statusLine.layout.left.includes("extension_statuses"));
		assert.ok(!config.statusLine.layout.right.includes("extension_statuses"));
	}
});
