import { ENUMS, validateConfigLayer } from "../domain/config-normalization.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";
import { type ConfigFilePort, type ConfigStoragePaths, writeScopedConfig } from "./config-storage.js";
import { formatDoctorSummary } from "./doctor.js";

export type Mutation = Record<string, unknown>;
export interface CommandUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}
export interface CommandHost {
	readonly ui: CommandUi;
	readonly cwd: string;
	isProjectTrusted(): boolean;
}
export interface CommandApp {
	readonly config: NormalizedPiOmpThemeConfig;
	applySession(patch: Mutation): void;
	setProjectTrusted?(trusted: boolean): void;
	reload(): Promise<void>;
	doctor(): Readonly<Record<string, unknown>>;
}

const surfaces = new Set(["status", "editor", "startup", "messages", "tools"]);
// Sourced from the normalizer rather than restated: three separate copies of
// these lists had already drifted, and this one rejected the shipped default
// preset ("claude") outright.
const presets = ENUMS.preset ?? [];
const styles = ENUMS["editor.style"] ?? [];
const frames = ENUMS["editor.frame"] ?? [];
const startupModes = ["off", "compact", "overlay"];
const allowedPaths = new Set([
	"enabled",
	"preset",
	"placement",
	"startup.mode",
	"startup.showResources",
	"statusLine.enabled",
	"statusLine.separator",
	"statusLine.layout.left",
	"statusLine.layout.right",
	"statusLine.layout.secondary",
	"statusLine.disabledSegments",
	"statusLine.customItems",
	"statusLine.bottomMargin",
	"statusLine.contextBarWidth",
	"editor.enabled",
	"editor.style",
	"editor.frame",
	"editor.showMetadata",
	"messages.enabled",
	"messages.assistantPrefix",
	"messages.specialBlocks",
	"messages.hideThinkingLabel",
	"messages.hideInterimText",
	"tools.enabled",
	"tools.style",
	"tools.maxCollapsedLines",
	"tools.maxExpandedLines",
	"tools.dimOutput",
	"tools.showElapsed",
	"tools.collapseAfterTurn",
	"tools.collapseMutatingTools",
	"theme.nerdFonts",
	"theme.terminalBackgroundSync",
	"theme.autoApply",
	"theme.colors",
	"theme.glyphs",
	"compatibility.allowSafePatches",
	"compatibility.allowCorePatches",
	"compatibility.preferExistingEditor",
	"compatibility.preferExistingFooter",
	"debug",
]);
function validatePathValue(path: string, value: unknown): boolean {
	if (!allowedPaths.has(path)) return false;
	if (
		[
			"enabled",
			"startup.showResources",
			"statusLine.enabled",
			"editor.enabled",
			"editor.showMetadata",
			"messages.enabled",
			"messages.assistantPrefix",
			"messages.specialBlocks",
			"messages.hideThinkingLabel",
			"messages.hideInterimText",
			"tools.enabled",
			"tools.showElapsed",
			"tools.dimOutput",
			"tools.collapseAfterTurn",
			"tools.collapseMutatingTools",
			"compatibility.allowSafePatches",
			"compatibility.allowCorePatches",
			"compatibility.preferExistingEditor",
			"compatibility.preferExistingFooter",
			"debug",
		].includes(path)
	)
		return typeof value === "boolean";
	if (path === "preset") return typeof value === "string" && presets.includes(value);
	if (path === "placement") return value === "above" || value === "below";
	if (path === "startup.mode") return typeof value === "string" && startupModes.includes(value);
	if (path === "editor.style") return typeof value === "string" && styles.includes(value);
	if (path === "editor.frame") return typeof value === "string" && frames.includes(value);
	if (path === "theme.autoApply") return typeof value === "string" && value !== "";
	if (["theme.nerdFonts", "theme.terminalBackgroundSync", "statusLine.separator", "tools.style"].includes(path))
		return typeof value === "string";
	if (path === "tools.maxCollapsedLines" || path === "tools.maxExpandedLines")
		return typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (path === "statusLine.bottomMargin" || path === "statusLine.contextBarWidth")
		return typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (path.endsWith(".colors") || path.endsWith(".glyphs"))
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.values(value).every((item) => typeof item === "string")
		);
	if (path.includes("layout.") || path === "statusLine.disabledSegments")
		return Array.isArray(value) && value.every((item) => typeof item === "string");
	return (
		path === "statusLine.customItems" &&
		validateConfigLayer({ statusLine: { customItems: value } }).diagnostics.length === 0
	);
}
function validateMutation(patch: Mutation, prefix = ""): boolean {
	return Object.entries(patch).every(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		if (
			[
				"theme.colors",
				"theme.glyphs",
				"statusLine.layout.left",
				"statusLine.layout.right",
				"statusLine.layout.secondary",
				"statusLine.disabledSegments",
				"statusLine.customItems",
			].includes(path)
		)
			return validatePathValue(path, value);
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return Object.keys(value).length > 0 && validateMutation(value as Mutation, path);
		return validatePathValue(path, value);
	});
}
function sanitizeMutation(patch: Mutation): Mutation | undefined {
	return validateMutation(patch) ? patch : undefined;
}

function mutation(parts: readonly string[]): Mutation | undefined {
	if (parts[0] === "set" && parts[1] && parts[2]) {
		try {
			const value = JSON.parse(parts.slice(2).join(" ")) as unknown;
			const patch: Mutation = {};
			let cursor = patch;
			const keys = parts[1].split(".");
			for (const key of keys.slice(0, -1)) {
				const next = cursor[key];
				if (typeof next === "object" && next !== null && !Array.isArray(next)) cursor = next as Mutation;
				else {
					cursor[key] = {};
					cursor = cursor[key] as Mutation;
				}
			}
			cursor[keys.at(-1) as string] = value;
			return sanitizeMutation(patch);
		} catch {
			return undefined;
		}
	}
	const [action, value, extra] = parts;
	if (action === "on" || action === "off") return { enabled: action === "on" };
	if (action === "preset" && value && presets.includes(value)) return { preset: value };
	if (action === "placement" && (value === "above" || value === "below")) return { placement: value };
	if (action === "editor" && value && styles.includes(value) && (!extra || frames.includes(extra)))
		return { editor: { style: value, ...(extra ? { frame: extra } : {}) } };
	if (action === "startup" && value && startupModes.includes(value)) return { startup: { mode: value } };
	if (action === "surface" && value && surfaces.has(value) && (extra === "on" || extra === "off")) {
		if (value === "startup") return { startup: { mode: extra === "on" ? "compact" : "off" } };
		return { [value === "status" ? "statusLine" : value]: { enabled: extra === "on" } };
	}
	return undefined;
}

export async function executePiOmpThemeCommand(
	args: string,
	host: CommandHost,
	app: CommandApp,
	storage: { readonly port: ConfigFilePort; readonly paths: ConfigStoragePaths },
): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const [action, scope, ...rest] = parts;
	if (!action) {
		host.ui.notify(
			`pi-omp-theme preset ${app.config.preset}; status ${app.config.statusLine.enabled ? "on" : "off"}`,
			"info",
		);
		return;
	}
	if (action === "reload") {
		await app.reload();
		return;
	}
	if (action === "doctor") {
		const report = app.doctor();
		if (!scope) {
			const summary = formatDoctorSummary(report);
			host.ui.notify(summary.message, summary.type);
		} else if ((scope === "json" || scope === "--json") && rest.length === 0) {
			host.ui.notify(JSON.stringify(report), "info");
		} else {
			host.ui.notify("usage: /pi-omp-theme doctor [json]", "warning");
		}
		return;
	}
	if (action === "persist") {
		if (scope !== "global" && scope !== "project") {
			host.ui.notify("persistence requires explicit global or project scope", "warning");
			return;
		}
		if (scope === "project" && !host.isProjectTrusted()) {
			host.ui.notify("pi-omp-theme project persistence requires a trusted project", "warning");
			return;
		}
		const patch = mutation(rest);
		if (!patch) {
			host.ui.notify("invalid pi-omp-theme mutation or value", "warning");
			return;
		}
		const sanitized = sanitizeMutation(patch);
		if (!sanitized) {
			host.ui.notify("mutation contains fields that cannot be persisted", "warning");
			return;
		}
		try {
			await writeScopedConfig(
				storage.port,
				scope === "global" ? storage.paths.globalPath : storage.paths.projectPath,
				sanitized,
			);
		} catch (error) {
			host.ui.notify(
				`pi-omp-theme settings write failed: ${error instanceof Error ? error.message : "unknown error"}`,
				"error",
			);
			return;
		}
		app.applySession(patch);
		if (
			(patch.messages as Record<string, unknown> | undefined)?.enabled === true ||
			(patch.tools as Record<string, unknown> | undefined)?.enabled === true
		)
			host.ui.notify("desired Tier C state stored; awaiting session authorization", "info");
		return;
	}
	const patch = mutation(parts);
	if (patch) app.applySession(patch);
	else if (action === "preset" && !scope) {
		const selected = await host.ui.select("pi-omp-theme preset", [...presets]);
		if (selected) app.applySession({ preset: selected });
	} else host.ui.notify("invalid pi-omp-theme command or value", "warning");
}
