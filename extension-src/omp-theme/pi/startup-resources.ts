import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Startup resource collection for the pi/ adapter layer. Runs once at session
 * start, outside any render path, and produces the bounded tool details that
 * the startup surface renders.
 */

const CORE_TOOL_SOURCE_LABEL = "core";

function stripKnownExtension(name: string): string {
	return name.replace(/\.(?:mjs|cjs|js|jsx|ts|tsx)$/i, "");
}

function compactSourcePathLabel(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return "";
	const synthetic = /^<([^:>]+)(?::[^>]*)?>$/.exec(trimmed);
	if (synthetic?.[1]) return synthetic[1];
	const segments = trimmed
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "." && segment !== "~");
	const last = segments.at(-1) ?? trimmed;
	if (/^index\.(?:mjs|cjs|js|jsx|ts|tsx)$/i.test(last) && segments.length > 1) {
		return segments[segments.length - 2] ?? last;
	}
	return stripKnownExtension(last);
}

function compactPackageSourceLabel(source: string): string {
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	if (source.startsWith("git:")) return compactSourcePathLabel(source.replace(/\.git(?:#.*)?$/i, "")) || source;
	return source;
}

/** Compact display label for a tool's source. */
export function toolSourceLabel(sourceInfo: SourceInfo | undefined): string {
	if (!sourceInfo || typeof sourceInfo !== "object") return CORE_TOOL_SOURCE_LABEL;
	const source = typeof sourceInfo.source === "string" ? sourceInfo.source : "";
	if (source === "builtin") return CORE_TOOL_SOURCE_LABEL;
	if (source === "sdk") return "sdk";
	if (source.startsWith("npm:") || source.startsWith("git:")) return compactPackageSourceLabel(source);
	const baseDir = typeof sourceInfo.baseDir === "string" ? sourceInfo.baseDir : "";
	if (baseDir) return compactSourcePathLabel(baseDir) || source || "extension";
	const path = typeof sourceInfo.path === "string" ? sourceInfo.path : "";
	if (path) return compactSourcePathLabel(path) || source || "extension";
	return source || "extension";
}

/**
 * Map registered tools to the bounded `{ source, name }` shape used by the
 * startup tools panel. When Pi reports active tool names, only those are kept;
 * an empty/absent active list keeps all registered tools so the panel is not
 * silently empty. Returns undefined when there is nothing to show.
 */
export function collectToolDetails(
	activeNames: readonly string[] | undefined,
	tools: readonly ToolInfo[] | undefined,
): { source: string; name: string }[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	const activeSet = activeNames && activeNames.length > 0 ? new Set(activeNames) : undefined;
	const details: { source: string; name: string }[] = [];
	for (const tool of tools) {
		if (typeof tool?.name !== "string" || tool.name.trim().length === 0) continue;
		if (activeSet && !activeSet.has(tool.name)) continue;
		details.push({ source: toolSourceLabel(tool.sourceInfo), name: tool.name.trim() });
	}
	return details.length > 0 ? details : undefined;
}
