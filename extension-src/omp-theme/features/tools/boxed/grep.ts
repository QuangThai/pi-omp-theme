// Boxed grep/search tool renderer.
//
// grep renders a **boxless grouped-search panel**: a calm summary header plus
// strict-budget file/code-frame groups. Collapsed mode favors breadth and match
// rows; expanded mode restores context without unbounded transcript growth.
// The panel lives in the call component and reads a live registry on every
// render, so result data is picked up without cross-component invalidation.
// grep does not batch (each call owns its own panel).
//
// Lifecycle: panels are keyed by toolCallId and cleared on session reset and new
// message boundaries (see resetGrepRegistry wiring in session-coordinator.ts and
// pi/index.ts), mirroring the batch registry.

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, type Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	dimLine,
	getTextOutput,
	replaceTabs,
	resolveAbsolutePath,
	shortenPath,
} from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import {
	GREP_COLLAPSED_LINE_LIMIT,
	GREP_EXPANDED_LINE_LIMIT,
	type GrepDisplayLine,
	type GrepMatch,
	groupMatchesByFile,
	parseGrepDisplayOutput,
	parseGrepOutput,
	pluralForm,
	renderGrepTree,
	SEARCH_ICON,
	SEARCH_ICON_UNICODE,
	TREE_INDENT,
} from "./output-tree.js";
import { getToolsRenderConfig } from "./session-config.js";
import { type BoxedToolDefinition, noteExecutionStart } from "./shared.js";

const GREP_ERROR_LINES = 2;

interface GrepPanelState {
	pattern: string;
	pathLabel: string;
	rawPath: string;
	cwd: string;
	searchPathKind: "file" | "directory" | undefined;
	/** `undefined` until the result arrives; an empty array means zero matches. */
	matches: GrepMatch[] | undefined;
	/** Match + context rows used only by expanded rendering. */
	displayLines: GrepDisplayLine[] | undefined;
	isError: boolean;
	errorText: string | undefined;
	isPartial: boolean;
	truncationLabel: string | undefined;
}

const grepPanels = new Map<string, GrepPanelState>();

/** Reset all grep panel state (session start/shutdown). */
export function resetGrepRegistry(): void {
	grepPanels.clear();
}

function pathLabel(rawPath: string): string {
	const displayPath = String(rawPath ?? ".");
	return displayPath === "." || displayPath === "" ? "current directory" : shortenPath(displayPath);
}

function localSearchPathKind(rawPath: string, cwd: string): "file" | "directory" | undefined {
	try {
		return statSync(resolveAbsolutePath(rawPath || ".", cwd)).isFile() ? "file" : "directory";
	} catch {
		return undefined;
	}
}

function registerGrepCall(
	toolCallId: string,
	pattern: string,
	label: string,
	rawPath: string,
	cwd: string,
): void {
	const searchPathKind = localSearchPathKind(rawPath, cwd);
	const existing = grepPanels.get(toolCallId);
	if (existing) {
		existing.pattern = pattern;
		existing.pathLabel = label;
		existing.rawPath = rawPath;
		existing.cwd = cwd;
		existing.searchPathKind = searchPathKind;
		return;
	}
	grepPanels.set(toolCallId, {
		pattern,
		pathLabel: label,
		rawPath,
		cwd,
		searchPathKind,
		matches: undefined,
		displayLines: undefined,
		isError: false,
		errorText: undefined,
		isPartial: true,
		truncationLabel: undefined,
	});
}

function registerGrepResult(
	toolCallId: string,
	data: {
		matches: GrepMatch[];
		displayLines: GrepDisplayLine[];
		isError: boolean;
		errorText: string | undefined;
		isPartial: boolean;
		truncationLabel: string | undefined;
	},
): void {
	const state = grepPanels.get(toolCallId);
	if (!state) return;
	state.matches = data.matches;
	state.displayLines = data.displayLines;
	state.isError = data.isError;
	state.errorText = data.errorText;
	state.isPartial = data.isPartial;
	state.truncationLabel = data.truncationLabel;
}

function bold(theme: BoxTheme, text: string): string {
	return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

function flattened(text: string): string {
	return replaceTabs(text).replace(/\r\n?|\n/g, " ");
}

function resolvedGrepFile(state: GrepPanelState, file: string): string {
	const searchPath = resolveAbsolutePath(state.rawPath || ".", state.cwd) || state.cwd;
	if (state.searchPathKind === "file") return searchPath;
	if (state.searchPathKind === "directory") return resolve(searchPath, file);
	const normalizedFile = file.replace(/\\/g, "/");
	const searchName = basename(searchPath).replace(/\\/g, "/");
	return normalizedFile === searchName ? searchPath : resolve(searchPath, file);
}

function linkFile(state: GrepPanelState, styledText: string, file: string, line?: number): string {
	if (!getCapabilities().hyperlinks || state.searchPathKind === undefined) return styledText;
	const url = pathToFileURL(resolvedGrepFile(state, file));
	if (line !== undefined) url.searchParams.set("line", String(line));
	return hyperlink(styledText, url.href);
}

function scopePart(theme: BoxTheme, state: GrepPanelState): string {
	if (!state.pathLabel) return "";
	const styledPath = theme.fg("dim", flattened(state.pathLabel));
	const scopePath = resolveAbsolutePath(state.rawPath || ".", state.cwd) || state.cwd;
	const linkedPath =
		getCapabilities().hyperlinks && state.searchPathKind !== undefined
			? hyperlink(styledPath, pathToFileURL(scopePath).href)
			: styledPath;
	return `${theme.fg("dim", " · in ")}${linkedPath}`;
}

/** Calm OMP-style status hierarchy: title in toolTitle, pattern muted, counts
 * and scope dim, with warning color reserved for incomplete results. */
function formatGrepHeader(theme: BoxTheme, state: GrepPanelState): string {
	const searchGlyph = getToolsRenderConfig().nerdFonts ? SEARCH_ICON : SEARCH_ICON_UNICODE;
	const icon = theme.fg(state.isError ? "error" : "toolTitle", state.isError ? "✘" : searchGlyph);
	const label = theme.fg(state.isError ? "error" : "toolTitle", bold(theme, "Grep:"));
	const pattern = flattened(state.pattern);
	const patternPart = pattern ? ` ${theme.fg(state.isError ? "error" : "muted", pattern)}` : "";
	const pathPart = scopePart(theme, state);
	if (state.isError) return `${icon} ${label}${patternPart}${pathPart}`;
	if (state.matches === undefined) return `${icon} ${label}${patternPart}${pathPart}`;

	const matchCount = state.matches.length;
	const fileCount = groupMatchesByFile(state.matches).length;
	const counts = theme.fg(
		"dim",
		` ${matchCount} ${pluralForm("match", matchCount)} · ${fileCount} ${pluralForm("file", fileCount)}`,
	);
	const truncated = state.truncationLabel ? theme.fg("warning", ` · ${state.truncationLabel}`) : "";
	return `${icon} ${label}${patternPart}${counts}${truncated}${pathPart}`;
}

function renderErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
	const raw = stripAnsi(errorText)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (raw.length === 0) return [];
	const prefix = `${TREE_INDENT}${dimLine("└─")} `;
	const out = raw
		.slice(0, GREP_ERROR_LINES)
		.map((line) => safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"));
	if (raw.length > GREP_ERROR_LINES)
		out.push(safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"));
	return out;
}

function grepLineBudget(expanded: boolean): number {
	const config = getToolsRenderConfig();
	const configured = expanded ? config.maxExpandedLines : config.maxCollapsedLines;
	const ompLimit = expanded ? GREP_EXPANDED_LINE_LIMIT : GREP_COLLAPSED_LINE_LIMIT;
	return Math.max(0, Math.min(configured, ompLimit));
}

function renderGrepPanelLines(theme: BoxTheme, state: GrepPanelState, width: number, expanded: boolean): string[] {
	const safeWidth = Math.max(1, width);
	const header = safeTruncateToWidth(formatGrepHeader(theme, state), safeWidth, "…");
	if (state.isError) {
		return [header, ...(state.errorText ? renderErrorLines(theme, state.errorText, width) : [])];
	}
	if (state.matches === undefined) return [header];
	const lineBudget = grepLineBudget(expanded);
	if (state.matches.length === 0) {
		if (lineBudget === 0) return [header];
		const empty = `${TREE_INDENT}${dimLine("└─")} ${theme.fg("muted", "No matches found")}`;
		return [header, safeTruncateToWidth(empty, safeWidth, "…")];
	}
	return renderGrepTree(theme, header, state.matches, safeWidth, {
		lineBudget,
		expanded,
		...(state.displayLines ? { displayLines: state.displayLines } : {}),
		withIcons: getToolsRenderConfig().nerdFonts,
		link: (styledText, file, line) => linkFile(state, styledText, file, line),
	});
}

/** Live panel component reading the registry on every render pass. The state
 *  reference is captured at creation (like the batch panel): a registry clear
 *  on session reset/resume must not blank already-rendered panels — the result
 *  renderer mutates this same object, so live updates still flow. */
function renderGrepPanel(theme: BoxTheme, toolCallId: string, expanded: boolean): Component {
	const state = grepPanels.get(toolCallId);
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!state) return [safeTruncateToWidth(bold(theme, "Grep:"), Math.max(1, width), "…")];
			return renderGrepPanelLines(theme, state, width, expanded);
		},
	};
}

/** Empty result component — the panel lives in the call component, which
 *  re-renders when the result arrives (Pi re-renders the tool execution
 *  component on tool_execution_end), picking up the stored matches. */
const EMPTY_GREP_RESULT: Component = {
	invalidate() {},
	render() {
		return [];
	},
};

function truncationLabel(result: { details?: unknown }, output: string): string | undefined {
	const details = result.details as
		| {
				matchLimitReached?: number;
				truncation?: { truncated?: boolean };
				linesTruncated?: boolean;
		  }
		| undefined;
	const reasons: string[] = [];
	if (typeof details?.matchLimitReached === "number") reasons.push(`${details.matchLimitReached}-match limit`);
	if (details?.truncation?.truncated) reasons.push("output limit");
	if (details?.linesTruncated) reasons.push("long lines");
	if (reasons.length > 0) return `truncated: ${reasons.join(", ")}`;
	// Historical transcripts may contain only the model-facing notice and no
	// structured details. Preserve the incomplete-result signal in that case.
	return /\[(?:Truncated:|[^\]]*limit reached|Some lines truncated)/i.test(output) ? "truncated" : undefined;
}

export const grepTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const pattern = String(args?.pattern ?? "");
		const rawPath = String(args?.path ?? ".");
		registerGrepCall(context.toolCallId, pattern, pathLabel(rawPath), rawPath, context.cwd);
		return renderGrepPanel(theme, context.toolCallId, context.expanded);
	},
	result(result, options, _theme, context) {
		const output = stripAnsi(getTextOutput(result)).trimEnd();
		const isError = Boolean(context.isError);
		const displayLines = isError ? [] : parseGrepDisplayOutput(output);
		const matches = isError ? [] : parseGrepOutput(output);
		registerGrepResult(context.toolCallId, {
			matches,
			displayLines,
			isError,
			errorText: isError ? output || undefined : undefined,
			isPartial: Boolean(options.isPartial),
			truncationLabel: isError ? undefined : truncationLabel(result, output),
		});
		return EMPTY_GREP_RESULT;
	},
};
