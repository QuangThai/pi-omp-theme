// Theme extras reader.
//
// Reads extension-specific "extras" plus raw theme vars/export values from the
// active theme's JSON file on disk. Pi does not expose all of these raw values
// through the theme object, so we locate and parse the file directly.
//
// pi-omp-theme constraint: no filesystem I/O inside render. The cache is populated
// by `syncThemeExtras(theme, force)` at session start and on theme change; the
// render-facing `getThemeExtra`/`getThemePageBackground`/`getThemeVarBackground`
// read cached values only and return "" (graceful fallback) when unavailable.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHexColor } from "../shared/ansi.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

export const THEME_EXTRA_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
	assistantPrefix: "•",
	assistantPrefixColor: "",
	dividerChar: "─",
	dividerColor: "",
	showDivider: "true",
	quoteStyle: "false",
	quoteChar: "┆",
	quoteColor: "",
	inputBorderColor: "",
	bashPromptColor: "",
	tagBgColor: "",
	parensTextColor: "",
	parensBracketColor: "",
	slashSelectedColor: "",
	slashCommandColor: "",
	slashDescriptionColor: "",
	slashHintColor: "",
	userBoxBorderColor: "",
	gitInsertionColor: "#2ea043",
	gitDeletionColor: "#f85149",
});

let cachedExtras: Record<string, string | boolean> | null = null;
let cachedVars: Record<string, string> | null = null;
let cachedColors: Record<string, string> | null = null;
let cachedThemeExport: Record<string, string> | null = null;
let cachedThemeName: string | null = null;

type ThemeDiscovery = {
	extras: Record<string, string | boolean> | null;
	vars: Record<string, string> | null;
	colors: Record<string, string> | null;
	themeExport: Record<string, string> | null;
};

function themeDiscoveryFromContent(content: unknown): ThemeDiscovery | null {
	if (!content || typeof content !== "object") return null;
	const record = content as Record<string, unknown>;
	const extras =
		record.extras && typeof record.extras === "object" ? (record.extras as Record<string, string | boolean>) : null;
	const vars = record.vars && typeof record.vars === "object" ? (record.vars as Record<string, string>) : null;
	const colors = record.colors && typeof record.colors === "object" ? (record.colors as Record<string, string>) : null;
	const themeExport =
		record.export && typeof record.export === "object" ? (record.export as Record<string, string>) : null;
	return extras || vars || colors || themeExport ? { extras, vars, colors, themeExport } : null;
}

function readThemeDiscoveryFromPath(filePath: string): ThemeDiscovery | null {
	try {
		if (!filePath || !existsSync(filePath)) return null;
		const content = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		return themeDiscoveryFromContent(content);
	} catch {
		return null;
	}
}

function resolveThemeSourcePath(theme: unknown): string {
	if (!theme || typeof theme !== "object") return "";
	const record = theme as Record<string, unknown>;
	if (typeof record.sourcePath === "string") return record.sourcePath;
	const definition =
		record.definition && typeof record.definition === "object"
			? (record.definition as Record<string, unknown>)
			: undefined;
	return typeof definition?.sourcePath === "string" ? definition.sourcePath : "";
}

function addThemeDir(searchDirs: Set<string>, dir: string): void {
	if (existsSync(dir)) searchDirs.add(dir);
}

function addBundledThemeDirs(searchDirs: Set<string>): void {
	for (const root of [extensionDir, process.cwd()]) {
		for (const scope of ["@earendil-works", "@mariozechner"]) {
			addThemeDir(
				searchDirs,
				resolve(root, "node_modules", scope, "pi-coding-agent", "dist", "modes", "interactive", "theme"),
			);
			addThemeDir(searchDirs, resolve(root, "node_modules", scope, "pi-coding-agent", "dist", "theme"));
		}
	}
}

function collectThemeDirs(root: string, searchDirs: Set<string>, maxDepth = 4): void {
	if (maxDepth < 0 || !existsSync(root)) return;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const dir = join(root, entry.name);
			if (entry.name === "themes") {
				searchDirs.add(dir);
				continue;
			}
			collectThemeDirs(dir, searchDirs, maxDepth - 1);
		}
	} catch {
		// best effort discovery only
	}
}

function readSettingsPackagePaths(settingsPath: string): string[] {
	if (!existsSync(settingsPath)) return [];
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		const entries = [
			...(Array.isArray(settings.packages) ? settings.packages : []),
			...(Array.isArray(settings.extensions) ? settings.extensions : []),
		];
		return entries
			.map((entry) =>
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object"
						? String((entry as Record<string, unknown>).source ?? "")
						: "",
			)
			.filter((entry) => entry && !entry.startsWith("npm:") && !entry.startsWith("git:"));
	} catch {
		return [];
	}
}

/** Scan known theme directories for a JSON file whose "name" matches themeName. */
function discoverThemeExtras(themeName: string): ThemeDiscovery | null {
	const searchDirs = new Set<string>();

	addThemeDir(searchDirs, join(homedir(), ".pi", "agent", "themes"));
	addThemeDir(searchDirs, resolve(process.cwd(), ".pi", "themes"));
	addBundledThemeDirs(searchDirs);
	collectThemeDirs(join(homedir(), ".pi", "agent", "git"), searchDirs);
	collectThemeDirs(resolve(process.cwd(), ".pi", "git"), searchDirs);

	const localPackagePaths = [
		...readSettingsPackagePaths(join(homedir(), ".pi", "agent", "settings.json")),
		...readSettingsPackagePaths(resolve(process.cwd(), ".pi", "settings.json")),
	];
	for (const packagePath of localPackagePaths) {
		addThemeDir(searchDirs, resolve(process.cwd(), packagePath, "themes"));
	}

	for (const dir of searchDirs) {
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const filePath = join(dir, file);
				try {
					const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
					if (content?.name === themeName) {
						const result = themeDiscoveryFromContent(content);
						if (result) return result;
					}
				} catch {
					// skip unparsable theme files
				}
			}
		} catch {
			// skip unreadable directories
		}
	}

	return null;
}

function resolveThemeName(theme: unknown): string | null {
	if (!theme || typeof theme !== "object") return null;
	const record = theme as Record<string, unknown>;
	const definition =
		record.definition && typeof record.definition === "object"
			? (record.definition as Record<string, unknown>)
			: undefined;
	if (typeof definition?.name === "string") return definition.name;
	if (typeof record.name === "string") return record.name;
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			if (typeof settings.theme === "string") return settings.theme;
		}
	} catch {
		// fall through
	}
	return null;
}

function readThemeToken(name: string): string {
	const varValue = cachedVars && typeof cachedVars[name] === "string" ? cachedVars[name] : "";
	if (varValue) return varValue;
	return cachedColors && typeof cachedColors[name] === "string" ? cachedColors[name] : "";
}

function resolveThemeColorToken(value: string): string {
	let resolved = value;
	const seen = new Set<string>();
	for (let depth = 0; depth < 8; depth++) {
		if (!resolved) return "";
		if (isHexColor(resolved)) return resolved;
		if (seen.has(resolved)) return "";
		seen.add(resolved);

		const next = readThemeToken(resolved);
		if (!next) return "";
		resolved = next;
	}
	return "";
}

function resolveThemeExtraValue(key: string, value: string): string {
	if (!key.endsWith("Color")) return value;
	return resolveThemeColorToken(value) || value;
}

function resolveThemeExportColor(key: string): string {
	if (!cachedThemeExport) return "";
	const value = cachedThemeExport[key];
	if (typeof value !== "string" || !value) return "";
	const resolved = cachedVars && typeof cachedVars[value] === "string" ? cachedVars[value] : value;
	return isHexColor(resolved) ? resolved : "";
}

/** Populate the extras cache from a theme (session start / theme change only). */
export function setFullTheme(theme: unknown, force = false): void {
	const themeName = resolveThemeName(theme);
	const sourcePath = resolveThemeSourcePath(theme);
	if (!themeName && !sourcePath) return;

	const cacheKey = sourcePath || themeName;
	if (
		!force &&
		cacheKey === cachedThemeName &&
		(cachedExtras !== null || cachedVars !== null || cachedColors !== null || cachedThemeExport !== null)
	)
		return;

	cachedThemeName = cacheKey;
	const result = readThemeDiscoveryFromPath(sourcePath) ?? (themeName ? discoverThemeExtras(themeName) : null);
	cachedExtras = result?.extras ?? null;
	cachedVars = result?.vars ?? null;
	cachedColors = result?.colors ?? null;
	cachedThemeExport = result?.themeExport ?? null;
}

export function resetThemeExtrasCache(): void {
	cachedExtras = null;
	cachedVars = null;
	cachedColors = null;
	cachedThemeExport = null;
	cachedThemeName = null;
}

/** Resolve a theme-extra key from the cache; "" when unavailable (graceful fallback). */
export function getThemeExtra(_theme: unknown, key: string): string {
	const extraValue = cachedExtras?.[key];
	if (typeof extraValue === "string" || typeof extraValue === "boolean") {
		return resolveThemeExtraValue(key, String(extraValue));
	}
	return resolveThemeExtraValue(key, THEME_EXTRA_DEFAULTS[key] ?? "");
}

export function getThemePageBackground(_theme: unknown): string {
	const directBg = cachedVars && typeof cachedVars.bg === "string" ? cachedVars.bg : "";
	if (isHexColor(directBg)) return directBg;
	return resolveThemeExportColor("pageBg");
}

export function getThemeVarBackground(_theme: unknown, varName: string): string {
	const value = cachedVars && typeof cachedVars[varName] === "string" ? cachedVars[varName] : "";
	const resolved = cachedVars && value && typeof cachedVars[value] === "string" ? cachedVars[value] : value;
	return isHexColor(resolved) ? resolved : "";
}
