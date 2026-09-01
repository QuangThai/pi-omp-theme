// Boxless output-tree primitives shared by the ls/find/grep/bash renderers.
//
// ls/find/grep and bash `ls/find/grep/rg` results render their parsed output as
// a **boxless tree panel** — a summary header line followed by `├─/└─` rows —
// instead of a boxed command/response shell. This module owns:
//
// - output parsers that turn native tool text into structured entries plus grep
//   match/context code-frame rows, dropping model-facing truncation notices;
// - `renderOutputTree`, which lays out a flat list of entries under a header
//   (used by lone ls/find and bash ls/find);
// - `renderGrepTree`, which applies strict final-row budgets to grouped grep
//   output, favors file breadth when collapsed, and restores context when expanded.
//
// Design notes:
// - Pure + theme-consuming: no filesystem, no global state, no caching (callers
//   cache at the component boundary).
// - Every row is width-safe via safeTruncateToWidth; the header is never
//   truncated by this layer (callers pass a concise, pre-sized header).
// - Tree indent matches the quiet-tool batch panel (`  ├─`) so the panels read
//   as one visual family.

import type { BoxTheme } from "../../../shared/box.js";
import { dimLine, replaceTabs, TOOL_CONTENT_PREFIX } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";

/** Indent for top-level tree rows; shared with every boxless tool body. */
export const TREE_INDENT = TOOL_CONTENT_PREFIX;
/** Extra indent for rows nested under a grouping node. */
export const TREE_CHILD_INDENT = "  ";
/** Default number of entries shown before collapsing to "… N more". */
export const OUTPUT_TREE_HEAD_LIMIT = 6;
/** OMP search previews use strict final-row budgets, separate from generic tools. */
export const GREP_COLLAPSED_LINE_LIMIT = 6;
export const GREP_EXPANDED_LINE_LIMIT = 24;

// ── Nerd Font file-type icons ───────────────────────────────────────────────
// Only used when the session glyph mode is nerd (see withIcons). Unicode/ASCII
// modes render plain entries.

const FILE_ICON_FOLDER = "\u{F415}"; //  (nf-md-folder)
const FILE_ICON_DEFAULT = "\u{E612}"; //  (nf-seti-default)
/** Search (magnifying-glass) icon for find/grep headers (nf-fa-search). */
export const SEARCH_ICON = "\u{F002}";
/** Font-independent counterpart, so search surfaces keep an icon without Nerd Fonts. */
export const SEARCH_ICON_UNICODE = "⌕";
const FILE_ICONS: Readonly<Record<string, string>> = {
	ts: "\u{E628}", //  (nf-seti-typescript)
	tsx: "\u{E7BA}", //  (nf-seti-react)
	js: "\u{E62C}", //  (nf-seti-javascript)
	jsx: "\u{E7BA}", //  (nf-seti-react)
	mjs: "\u{E62C}",
	cjs: "\u{E62C}",
	json: "\u{E62B}", //  (nf-seti-json)
	md: "\u{E609}", //  (nf-seti-markdown)
	mdx: "\u{E609}",
	css: "\u{E749}", //  (nf-seti-css)
	scss: "\u{E749}",
	sass: "\u{E749}",
	less: "\u{E749}",
	html: "\u{E60E}", //  (nf-seti-html)
	htm: "\u{E60E}",
	py: "\u{E606}", //  (nf-seti-python)
	go: "\u{E627}", //  (nf-seti-go)
	rs: "\u{E7A8}", //  (nf-seti-rust)
	sh: "\u{E795}", //  (nf-seti-shell)
	bash: "\u{E795}",
	zsh: "\u{E795}",
	fish: "\u{E795}",
	yml: "\u{E615}", //  (nf-seti-yaml)
	yaml: "\u{E615}",
	toml: "\u{E615}",
	java: "\u{E738}", //  (nf-seti-java)
	c: "\u{E61E}", //  (nf-seti-c)
	h: "\u{E61E}",
	cpp: "\u{E61E}",
	hpp: "\u{E61E}",
	cs: "\u{E61E}",
	svg: "\u{E62A}", //  (nf-seti-svg)
	png: "\u{E61D}", //  (nf-seti-image)
	jpg: "\u{E61D}",
	jpeg: "\u{E61D}",
	gif: "\u{E61D}",
	webp: "\u{E61D}",
	pdf: "\u{E67A}", //  (nf-seti-pdf)
	dockerfile: "\u{E7B0}", //  (nf-seti-docker)
	lock: "\u{E7B0}",
	gitignore: "\u{E702}", //  (nf-seti-git)
	gitattributes: "\u{E702}",
	vue: "\u{ED43}", //  (nf-vue)
	svelte: "\u{E697}",
};

/** Nerd Font file-type icon for a path, or "" when not applicable. */
export function fileIcon(path: string): string {
	if (path.endsWith("/")) return FILE_ICON_FOLDER;
	const name = path.split("/").pop() ?? path;
	const lower = name.toLowerCase();
	const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
	return FILE_ICONS[ext] ?? FILE_ICONS[lower] ?? FILE_ICON_DEFAULT;
}

/** Lines produced by these native tools to signal truncation (already in the
 *  output text, not separate metadata). Dropped before parsing. */
const NOTICE_LINE_PATTERN = /^\[[^\]]*\]$/;

/** A parsed grep match line. */
export interface GrepMatch {
	readonly file: string;
	readonly line: number;
	readonly content: string;
}

/** A user-visible grep code-frame line. Expanded rendering includes context
 * lines; collapsed rendering filters down to actual matches. */
export interface GrepDisplayLine extends GrepMatch {
	readonly isMatch: boolean;
}

/** Drop trailing tool notices (`[Showing last …]`, `[Truncated: …]`) and blanks. */
function stripNotices(text: string): string[] {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !NOTICE_LINE_PATTERN.test(line.trim()));
}

/**
 * Parse native `ls` output into display entries. Directories keep their `/`
 * suffix; the `(empty directory)` placeholder and truncation notices are
 * removed. Output is already sorted alphabetically by the tool.
 */
export function parseLsOutput(rawText: string): string[] {
	return stripNotices(rawText)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== "(empty directory)");
}

/**
 * Parse `ls -l`/`ls -la` long-format output into display entries: the entry
 * name is the text after the time column; directory names get a trailing `/`.
 * The `total N` summary and `.`/`..` entries are dropped. Standard POSIX
 * columns: perms links owner group size month day time name. macOS `@`/`+`
 * permission suffixes are tolerated.
 */
export function parseLsLongOutput(rawText: string): string[] {
	const entries: string[] = [];
	for (const line of stripNotices(rawText)) {
		if (!/^[bcdlsp-][rwxtsST-]{9}/.test(line)) continue;
		const parts = line.split(/\s+/);
		const name = parts.slice(8).join(" ").trim();
		if (!name || name === "." || name === "..") continue;
		const isDir = (parts[0] ?? "").startsWith("d");
		entries.push(isDir ? `${name}/` : name);
	}
	return entries;
}

/**
 * Parse native `find` output into display paths (one per line). Notices are
 * removed. The native tool returns paths relative to the search directory.
 */
export function parseFindOutput(rawText: string): string[] {
	return stripNotices(rawText)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

// Pi match lines use `file:line: content`; context uses `file-line- content`.
// Match parsing binds the first numeric delimiter (after a possible drive
// prefix) so `:N:` inside source content cannot steal the file/line boundary.
const GREP_MATCH_PATTERN = /^(.*?):(\d+):[ \t]?(.*)$/;
const GREP_CONTEXT_FALLBACK_PATTERN = /^(.*)-(\d+)-[ \t]?(.*)$/;
// Single-file ripgrep/grep output omits the filename.
const GREP_BARE_MATCH_PATTERN = /^(\d+):[ \t]?(.*)$/;
const GREP_BARE_CONTEXT_PATTERN = /^(\d+)-[ \t]?(.*)$/;

function parsedDisplayLine(
	match: RegExpExecArray | null,
	isMatch: boolean,
	fileOverride?: string,
): GrepDisplayLine | undefined {
	if (!match) return undefined;
	const file = fileOverride ?? match[1];
	const lineNo = fileOverride === undefined ? match[2] : match[1];
	const content = fileOverride === undefined ? match[3] : match[2];
	if (!file || lineNo === undefined || content === undefined) return undefined;
	const parsed = Number(lineNo);
	if (!Number.isFinite(parsed) || parsed < 1) return undefined;
	return { file, line: parsed, content, isMatch };
}

function pushUniqueDisplayLine(
	lines: GrepDisplayLine[],
	indexes: Map<string, number>,
	line: GrepDisplayLine,
): void {
	const key = `${line.file}\0${line.line}`;
	const existingIndex = indexes.get(key);
	if (existingIndex === undefined) {
		indexes.set(key, lines.length);
		lines.push(line);
		return;
	}
	// Overlapping context windows can repeat the same source line. Keep one row,
	// upgrading a prior context copy when that line is itself a later match.
	const existing = lines[existingIndex];
	if (line.isMatch && existing && !existing.isMatch) lines[existingIndex] = line;
}

function parsedContextLine(rawLine: string, knownFiles: readonly string[]): GrepDisplayLine | undefined {
	for (const file of knownFiles) {
		const prefix = `${file}-`;
		if (!rawLine.startsWith(prefix)) continue;
		const match = /^(\d+)-[ \t]?(.*)$/.exec(rawLine.slice(prefix.length));
		if (!match) continue;
		const parsed = Number(match[1]);
		if (!Number.isFinite(parsed) || parsed < 1) continue;
		return { file, line: parsed, content: match[2] ?? "", isMatch: false };
	}
	return parsedDisplayLine(GREP_CONTEXT_FALLBACK_PATTERN.exec(rawLine), false);
}

/** Parse native grep output for the TUI, preserving match and context rows. */
export function parseGrepDisplayOutput(rawText: string): GrepDisplayLine[] {
	const rawLines = stripNotices(rawText);
	const knownFiles = [
		...new Set(
			rawLines
				.map((line) => parsedDisplayLine(GREP_MATCH_PATTERN.exec(line), true)?.file)
				.filter((file): file is string => Boolean(file)),
		),
	].sort((left, right) => right.length - left.length);
	const lines: GrepDisplayLine[] = [];
	const indexes = new Map<string, number>();
	for (const line of rawLines) {
		const parsed = parsedDisplayLine(GREP_MATCH_PATTERN.exec(line), true) ?? parsedContextLine(line, knownFiles);
		if (parsed) pushUniqueDisplayLine(lines, indexes, parsed);
	}
	return lines;
}

/** Parse native grep output into actual match records only. */
export function parseGrepOutput(rawText: string): GrepMatch[] {
	return parseGrepDisplayOutput(rawText)
		.filter((line) => line.isMatch)
		.map(({ file, line, content }) => ({ file, line, content }));
}

/** Parse single-file grep/ripgrep output for the TUI. */
export function parseGrepBareDisplayOutput(rawText: string, file: string): GrepDisplayLine[] {
	const lines: GrepDisplayLine[] = [];
	const indexes = new Map<string, number>();
	for (const line of stripNotices(rawText)) {
		const parsed =
			parsedDisplayLine(GREP_BARE_MATCH_PATTERN.exec(line), true, file) ??
			parsedDisplayLine(GREP_BARE_CONTEXT_PATTERN.exec(line), false, file);
		if (parsed) pushUniqueDisplayLine(lines, indexes, parsed);
	}
	return lines;
}

/** Parse single-file grep/ripgrep output into actual matches only. */
export function parseGrepBareOutput(rawText: string, file: string): GrepMatch[] {
	return parseGrepBareDisplayOutput(rawText, file)
		.filter((line) => line.isMatch)
		.map(({ file: parsedFile, line, content }) => ({ file: parsedFile, line, content }));
}

/** Group grep matches by file, preserving first-seen order. */
export function groupMatchesByFile(matches: readonly GrepMatch[]): { file: string; matches: GrepMatch[] }[] {
	const order: string[] = [];
	const buckets = new Map<string, GrepMatch[]>();
	for (const match of matches) {
		let bucket = buckets.get(match.file);
		if (!bucket) {
			bucket = [];
			buckets.set(match.file, bucket);
			order.push(match.file);
		}
		bucket.push(match);
	}
	return order.map((file) => ({ file, matches: buckets.get(file) ?? [] }));
}

export interface OutputTreeOptions {
	/** Maximum entries shown before the "… N more" row. */
	headLimit?: number;
	/** Singular noun used in the collapse row (default "file"); pluralized automatically. */
	moreUnit?: string;
	/** Optional ANSI-themed color for entry text (defaults to "toolOutput"). */
	entryColor?: string;
	/** Indent prefix applied to every row (defaults to TREE_INDENT). */
	indent?: string;
	/** Nerd Font mode: prefix each entry with its file-type icon. */
	withIcons?: boolean;
}

/**
 * Render a flat output tree: `<header>` then `├─/└─` rows for the first entries
 * and a trailing `└─ … N more <unit>` row when truncated. Used by lone ls/find
 * (and bash ls/find).
 */
export function renderOutputTree(
	theme: BoxTheme,
	header: string,
	entries: readonly string[],
	width: number,
	options: OutputTreeOptions = {},
): string[] {
	const headLimit = options.headLimit ?? OUTPUT_TREE_HEAD_LIMIT;
	const moreUnit = options.moreUnit ?? "file";
	const entryColor = options.entryColor ?? "toolOutput";
	const indent = options.indent ?? TREE_INDENT;
	const safeWidth = Math.max(1, width);
	const label = (entry: string) => (options.withIcons && entry ? `${fileIcon(entry)} ${entry}` : entry);

	const out: string[] = [safeTruncateToWidth(header, safeWidth, "…")];
	if (entries.length === 0) return out;

	const visible = entries.slice(0, headLimit);
	const more = entries.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const line = `${indent}${dimLine(branch)} ${theme.fg(entryColor, label(visible[i] ?? ""))}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
	}
	if (more > 0) {
		const line = `${indent}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm(moreUnit, more)}`)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
	}
	return out;
}

export interface GrepTreeOptions {
	/** Strict body-row budget, including file nodes and the trailing summary. */
	lineBudget?: number;
	/** Expanded mode may include context lines supplied through displayLines. */
	expanded?: boolean;
	/** Parsed match + context lines. Falls back to match-only records. */
	displayLines?: readonly GrepDisplayLine[];
	/** Indent prefix applied to top-level rows. */
	indent?: string;
	/** Nerd Font mode: prefix file nodes with their file-type icon. */
	withIcons?: boolean;
	/** Optional OSC-8/link wrapper supplied by a renderer that knows the cwd. */
	link?: (styledText: string, file: string, line?: number) => string;
}

interface GrepDisplayGroup {
	file: string;
	lines: GrepDisplayLine[];
}

interface SelectedGrepGroup {
	group: GrepDisplayGroup;
	lines: GrepDisplayLine[];
}

function groupDisplayLines(lines: readonly GrepDisplayLine[]): GrepDisplayGroup[] {
	const groups: GrepDisplayGroup[] = [];
	const byFile = new Map<string, GrepDisplayGroup>();
	for (const line of lines) {
		let group = byFile.get(line.file);
		if (!group) {
			group = { file: line.file, lines: [] };
			byFile.set(line.file, group);
			groups.push(group);
		}
		group.lines.push(line);
	}
	return groups;
}

function fullRowCount(groups: readonly GrepDisplayGroup[], multiFile: boolean): number {
	return groups.reduce((count, group) => count + group.lines.length + (multiFile ? 1 : 0), 0);
}

function selectCollapsedGroups(
	groups: readonly GrepDisplayGroup[],
	lineBudget: number,
	multiFile: boolean,
): SelectedGrepGroup[] {
	const matchesOnly = groups.map((group) => ({
		file: group.file,
		lines: group.lines.filter((line) => line.isMatch),
	}));
	if (fullRowCount(matchesOnly, multiFile) <= lineBudget) {
		return matchesOnly.filter((group) => group.lines.length > 0).map((group) => ({ group, lines: [...group.lines] }));
	}

	// Keep one row for the global summary, then select matches round-robin by
	// file. This prevents one hot file from hiding every other result group.
	const contentBudget = Math.max(0, lineBudget - 1);
	const selected = new Map<string, SelectedGrepGroup>();
	let usedRows = 0;
	for (let round = 0; ; round++) {
		let progressed = false;
		for (const group of matchesOnly) {
			const line = group.lines[round];
			if (!line) continue;
			const existing = selected.get(group.file);
			const cost = existing ? 1 : multiFile ? 2 : 1;
			if (usedRows + cost > contentBudget) continue;
			if (existing) existing.lines.push(line);
			else selected.set(group.file, { group, lines: [line] });
			usedRows += cost;
			progressed = true;
		}
		if (!progressed) break;
	}
	return matchesOnly.flatMap((group) => {
		const value = selected.get(group.file);
		return value ? [value] : [];
	});
}

function expandedSliceWithMatch(lines: readonly GrepDisplayLine[], capacity: number): GrepDisplayLine[] {
	if (capacity <= 0) return [];
	const prefix = lines.slice(0, capacity);
	if (prefix.some((line) => line.isMatch)) return prefix;
	const firstMatch = lines.findIndex((line) => line.isMatch);
	if (firstMatch < 0) return [];
	const start = Math.max(0, firstMatch - (capacity - 1));
	return lines.slice(start, firstMatch + 1);
}

function selectExpandedGroups(
	groups: readonly GrepDisplayGroup[],
	lineBudget: number,
	multiFile: boolean,
): SelectedGrepGroup[] {
	if (fullRowCount(groups, multiFile) <= lineBudget) {
		return groups.map((group) => ({ group, lines: [...group.lines] }));
	}
	const contentBudget = Math.max(0, lineBudget - 1);
	const selected: SelectedGrepGroup[] = [];
	let usedRows = 0;
	for (const group of groups) {
		const headerCost = multiFile ? 1 : 0;
		const available = contentBudget - usedRows - headerCost;
		const lines = expandedSliceWithMatch(group.lines, available);
		if (lines.length === 0) continue;
		selected.push({ group, lines });
		usedRows += headerCost + lines.length;
		if (lines.length < group.lines.length) break;
	}
	return selected;
}

function formatMatchRow(theme: BoxTheme, line: GrepDisplayLine, lineNumberWidth: number): string {
	const marker = line.isMatch ? "*" : " ";
	const lineNumber = `${marker}${String(line.line).padStart(lineNumberWidth, " ")}`;
	const contentColor = line.isMatch ? "toolOutput" : "dim";
	return `${theme.fg("dim", lineNumber)}${dimLine("│")} ${theme.fg(contentColor, replaceTabs(line.content))}`;
}

function moreSummary(
	theme: BoxTheme,
	hiddenMatches: number,
	hiddenLines: number,
	hiddenFiles: number,
): string {
	const primary =
		hiddenMatches > 0
			? `${hiddenMatches} more ${pluralForm("match", hiddenMatches)}`
			: `${hiddenLines} more ${pluralForm("line", hiddenLines)}`;
	const files = hiddenFiles > 0 ? ` · ${hiddenFiles} more ${pluralForm("file", hiddenFiles)}` : "";
	return theme.fg("dim", `… ${primary}${files}`);
}

/**
 * Render grep output with a strict visual-line budget. Collapsed mode favors
 * breadth across files and match lines only; expanded mode keeps source order
 * and includes context. Each file is one tree item whose continuation gutter
 * carries its code frame, matching OMP's quieter grouped-search presentation.
 */
export function renderGrepTree(
	theme: BoxTheme,
	header: string,
	matches: readonly GrepMatch[],
	width: number,
	options: GrepTreeOptions = {},
): string[] {
	const indent = options.indent ?? TREE_INDENT;
	const safeWidth = Math.max(1, width);
	const lineBudget = Math.max(0, Math.floor(options.lineBudget ?? OUTPUT_TREE_HEAD_LIMIT));
	const out: string[] = [safeTruncateToWidth(header, safeWidth, "…")];
	if (matches.length === 0 || lineBudget === 0) return out;

	const fallbackLines: GrepDisplayLine[] = matches.map((match) => ({ ...match, isMatch: true }));
	const displayLines = options.displayLines?.some((line) => line.isMatch) ? options.displayLines : fallbackLines;
	const groups = groupDisplayLines(displayLines);
	const multiFile = groups.length > 1;
	const selected = options.expanded
		? selectExpandedGroups(groups, lineBudget, multiFile)
		: selectCollapsedGroups(groups, lineBudget, multiFile);
	const selectedLines = selected.flatMap((entry) => entry.lines);
	const selectedMatches = selectedLines.filter((line) => line.isMatch).length;
	const totalDisplayMatches = displayLines.filter((line) => line.isMatch).length;
	const hiddenMatches = Math.max(matches.length - selectedMatches, totalDisplayMatches - selectedMatches, 0);
	// Collapsed mode intentionally discards context; only expanded context omitted
	// by its own budget is user-visible as "more lines".
	const hiddenLines = options.expanded ? Math.max(displayLines.length - selectedLines.length, 0) : 0;
	const selectedFiles = new Set(selected.filter((entry) => entry.lines.some((line) => line.isMatch)).map((entry) => entry.group.file));
	const hiddenFiles = groups.filter((group) => !selectedFiles.has(group.file)).length;
	const hasSummary = hiddenMatches > 0 || hiddenLines > 0;
	const push = (line: string) => out.push(safeTruncateToWidth(line, safeWidth, "…"));

	selected.forEach((entry, index) => {
		const isLast = index === selected.length - 1 && !hasSummary;
		const branchPrefix = `${indent}${dimLine(isLast ? "└─" : "├─")} `;
		const continuePrefix = `${indent}${isLast ? "  " : dimLine("│ ")} `;
		const lineNumberWidth = entry.group.lines.reduce(
			(max, line) => Math.max(max, String(line.line).length),
			1,
		);
		if (multiFile) {
			const rawLabel = options.withIcons ? `${fileIcon(entry.group.file)} ${entry.group.file}` : entry.group.file;
			const styledLabel = theme.fg("accent", rawLabel);
			push(`${branchPrefix}${options.link?.(styledLabel, entry.group.file) ?? styledLabel}`);
			for (const line of entry.lines) {
				const styledLine = formatMatchRow(theme, line, lineNumberWidth);
				push(`${continuePrefix}${options.link?.(styledLine, line.file, line.line) ?? styledLine}`);
			}
			return;
		}
		entry.lines.forEach((line, lineIndex) => {
			const styledLine = formatMatchRow(theme, line, lineNumberWidth);
			const linked = options.link?.(styledLine, line.file, line.line) ?? styledLine;
			push(`${lineIndex === 0 ? branchPrefix : continuePrefix}${linked}`);
		});
	});

	if (hasSummary && out.length - 1 < lineBudget) {
		push(`${indent}${dimLine("└─")} ${moreSummary(theme, hiddenMatches, hiddenLines, hiddenFiles)}`);
	}
	return out;
}

/** Return the pluralized form of a noun for the given count. */
export function pluralForm(noun: string, count: number): string {
	if (count === 1) return noun;
	return /(s|x|z|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`;
}

/** Pluralize a count noun: "1 file" / "3 files", "1 match" / "3 matches". */
export function pluralize(count: number, noun: string): string {
	return `${count} ${pluralForm(noun, count)}`;
}
