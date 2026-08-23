// Boxless output-tree primitives shared by the ls/find/grep/bash renderers.
//
// ls/find/grep and bash `ls/find/grep/rg` results render their parsed output as
// a **boxless tree panel** — a summary header line followed by `├─/└─` rows —
// instead of a boxed command/response shell. This module owns:
//
// - output parsers that turn native tool text (entries, paths, `file:line:`
//   match lines) into structured records, dropping trailing truncation notices;
// - `renderOutputTree`, which lays out a flat list of entries under a header
//   (used by lone ls/find and bash ls/find);
// - `renderGrepTree`, which lays out grep matches grouped by file (used by grep
//   and bash grep/rg).
//
// Design notes:
// - Pure + theme-consuming: no filesystem, no global state, no caching (callers
//   cache at the component boundary).
// - Every row is width-safe via safeTruncateToWidth; the header is never
//   truncated by this layer (callers pass a concise, pre-sized header).
// - Tree indent matches the quiet-tool batch panel (`  ├─`) so the panels read
//   as one visual family.

import type { BoxTheme } from "../../../shared/box.js";
import { dimLine } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";

/** Indent for top-level tree rows; matches the quiet-tool batch panel. */
export const TREE_INDENT = "  ";
/** Extra indent for rows nested under a grouping node. */
export const TREE_CHILD_INDENT = "  ";
/** Default number of entries/matches shown before collapsing to "… N more". */
export const OUTPUT_TREE_HEAD_LIMIT = 6;

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

/** A parsed grep match line. Context lines are not surfaced in the tree. */
export interface GrepMatch {
	readonly file: string;
	readonly line: number;
	readonly content: string;
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

// Match line:  path/to/file.ts:42:  matched content   (Pi grep adds a space;
// ripgrep/grep emit no space). Context lines (path-line- …) are dropped.
const GREP_MATCH_PATTERN = /^(.*):(\d+):[ \t]?(.*)$/;
// Single-file ripgrep/grep output: `42:  content` (no filename).
const GREP_BARE_PATTERN = /^(\d+):[ \t]?(.*)$/;

/**
 * Parse native `grep` output into match records. Only real match lines
 * (`file:line: content`) are kept; context lines (`file-line- …`) are dropped
 * so the tree stays focused on hits. Trailing notices are removed.
 */
export function parseGrepOutput(rawText: string): GrepMatch[] {
	const matches: GrepMatch[] = [];
	for (const line of stripNotices(rawText)) {
		const match = GREP_MATCH_PATTERN.exec(line);
		if (!match) continue;
		const [, file, lineNo, content] = match;
		if (!file || lineNo === undefined || content === undefined) continue;
		const parsed = Number(lineNo);
		if (!Number.isFinite(parsed) || parsed < 1) continue;
		matches.push({ file, line: parsed, content });
	}
	return matches;
}

/**
 * Parse single-file grep/ripgrep output — `line: content` without a filename —
 * attributing every match to the given file. Used by bash `grep pattern file`.
 */
export function parseGrepBareOutput(rawText: string, file: string): GrepMatch[] {
	const matches: GrepMatch[] = [];
	for (const line of stripNotices(rawText)) {
		const match = GREP_BARE_PATTERN.exec(line);
		if (!match) continue;
		const parsed = Number(match[1]);
		if (!Number.isFinite(parsed) || parsed < 1) continue;
		matches.push({ file, line: parsed, content: match[2] ?? "" });
	}
	return matches;
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
	/** Maximum matches shown (across all files) before the "… N more" row. */
	headLimit?: number;
	/** Indent prefix applied to top-level rows. */
	indent?: string;
	/** Nerd Font mode: prefix file nodes with their file-type icon. */
	withIcons?: boolean;
}

function formatMatchRow(theme: BoxTheme, match: GrepMatch): string {
	// Match rows render in the output text color (not primary) so they read like
	// the matched code; only the file nodes carry the primary color.
	const label = theme.fg("toolOutput", `*${match.line}`);
	const sep = dimLine("│");
	return `${label}${sep} ${theme.fg("toolOutput", match.content)}`;
}

/**
 * Render a grep matches tree: `<header>` then matches grouped by file. With a
 * single file the matches are direct children; with several files each file is
 * a `├─ file` node and its matches hang off an indented trunk beneath. A
 * trailing `└─ … N more matches` row appears when the match budget is exceeded.
 */
export function renderGrepTree(
	theme: BoxTheme,
	header: string,
	matches: readonly GrepMatch[],
	width: number,
	options: GrepTreeOptions = {},
): string[] {
	const headLimit = options.headLimit ?? OUTPUT_TREE_HEAD_LIMIT;
	const indent = options.indent ?? TREE_INDENT;
	const safeWidth = Math.max(1, width);

	const out: string[] = [safeTruncateToWidth(header, safeWidth, "…")];
	if (matches.length === 0) return out;

	const groups = groupMatchesByFile(matches);
	const singleFile = groups.length === 1;

	// First decide which matches fit the budget so branch glyphs (├─ vs └─) and
	// the trailing "… N more" row stay consistent.
	const budget = matches.slice(0, headLimit);
	const remaining = matches.length - budget.length;
	const truncated = remaining > 0;
	const totalVisible = budget.length;

	const push = (line: string) => out.push(safeTruncateToWidth(line, safeWidth, "…"));

	if (singleFile) {
		budget.forEach((match, index) => {
			const isLast = index === totalVisible - 1 && !truncated;
			push(`${indent}${dimLine(isLast ? "└─" : "├─")} ${formatMatchRow(theme, match)}`);
		});
	} else {
		// Walk the budget, tracking position within each file group so the file
		// node and its match subtree render as one connected unit.
		let shown = 0;
		for (let gi = 0; gi < groups.length && shown < totalVisible; gi++) {
			const group = groups[gi];
			if (!group) continue;
			const isLastGroup = gi === groups.length - 1;
			const trunk = isLastGroup ? " " : dimLine("│");

			const visibleHere: GrepMatch[] = [];
			for (const match of group.matches) {
				if (shown >= totalVisible) break;
				visibleHere.push(match);
				shown++;
			}
			if (visibleHere.length === 0) continue;

			const groupIsLastRendered = shown >= totalVisible && !truncated;
			const fileLabel = options.withIcons ? `${fileIcon(group.file)} ${group.file}` : group.file;
			// File nodes use the primary (accent) color, matching read/ls/find paths.
			push(`${indent}${dimLine(groupIsLastRendered ? "└─" : "├─")} ${theme.fg("accent", fileLabel)}`);

			visibleHere.forEach((match, index) => {
				const isLastInGroup = index === visibleHere.length - 1;
				const isLastOverall = groupIsLastRendered && isLastInGroup;
				push(
					`${indent}${trunk}${TREE_CHILD_INDENT}${dimLine(isLastOverall ? "└─" : "├─")} ${formatMatchRow(theme, match)}`,
				);
			});
		}
	}

	if (truncated) {
		push(`${indent}${dimLine("└─")} ${theme.fg("dim", `… ${remaining} more ${pluralForm("match", remaining)}`)}`);
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
