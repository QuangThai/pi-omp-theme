import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type { NormalizedPiOmpThemeConfig } from "../../domain/config-types.js";
import type { StatusSnapshot } from "../../domain/status.js";
import { type ActiveTheme, type ResolvedTheme, resolveTheme } from "../../domain/theme.js";
import { fitAnsiWidth, truncateAnsi, visibleWidth } from "../../shared/ansi.js";
import { renderWelcome, type WelcomeProvider, WELCOME_PROVIDER_SLOTS } from "./welcome.js";
import { compactLogoHeader } from "./logo.js";

export type StartupReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface StartupDetailItem {
	readonly kind: "system" | "append" | "context";
	readonly path: string;
	readonly words: number;
	readonly lines: number;
}

export interface StartupToolItem {
	readonly source: string;
	readonly name: string;
}

export interface StartupResources {
	readonly contextFiles?: number;
	readonly extensions?: number;
	readonly skills?: number;
	readonly prompts?: number;
	readonly tools?: number;
	readonly models?: number;
	readonly details?: readonly StartupDetailItem[];
	readonly toolDetails?: readonly StartupToolItem[];
	/** Recent sessions for this project, newest first. */
	readonly sessions?: readonly { name: string; timeAgo: string }[];
	readonly error?: string;
}

export interface StartupSnapshot extends StatusSnapshot {
	readonly reason: StartupReason;
	readonly project?: string | undefined;
	readonly startupProvider?: string | undefined;
	readonly resources?: StartupResources | undefined;
	readonly preset?: string | undefined;
	readonly compatibility?: string | undefined;
}

export type StartupTheme = ActiveTheme;

function activeThemeFromPi(theme: unknown): ActiveTheme {
	if (!theme || typeof theme !== "object") return {};
	const candidate = theme as { fg?: (token: string, text?: string) => string; colors?: Record<string, string> };
	return {
		...(candidate.colors ? { colors: candidate.colors } : {}),
		...(candidate.fg ? { fg: (color: string, text: string) => candidate.fg?.(color, text) ?? text } : {}),
	};
}

export interface StartupHost {
	setHeader?: (factory: ((tui: unknown, theme: unknown) => Component & { dispose?(): void }) | undefined) => void;
	setWidget?: (key: string, content: unknown, options?: unknown) => void;
	custom?: <T>(
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (value: T) => void,
		) => Component & { dispose?(): void },
		options?: { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void },
	) => Promise<T>;
	onTerminalInput?: (handler: (...args: readonly unknown[]) => unknown) => () => void;
	readonly mode?: string;
	readonly hasUI?: boolean;
	/** Optional public-adapter capability used to avoid overwriting a later header owner. */
	getHeaderFactory?: () => unknown;
}

export interface StartupInstallation {
	readonly generation: number;
	update(snapshot: StartupSnapshot): void;
	dismiss(): void;
	configure(config: NormalizedPiOmpThemeConfig): void;
	dispose(): void;
}

export interface StartupInstallOptions {
	host: StartupHost;
	config: NormalizedPiOmpThemeConfig;
	snapshot: StartupSnapshot;
	generation: number;
	requestRender?: () => void;
	timeoutMs?: number;
	isCurrent?: () => boolean;
}

export const STARTUP_WIDGET_KEY = "pi-omp-theme.startup";
const owners = new WeakMap<object, Map<string, symbol>>();

function ownerMap(host: object): Map<string, symbol> {
	let map = owners.get(host);
	if (!map) {
		map = new Map();
		owners.set(host, map);
	}
	return map;
}

function safeCall(fn: () => void): boolean {
	try {
		fn();
		return true;
	} catch {
		return false;
	}
}

function shouldShow(reason: StartupReason, mode: "off" | "compact" | "overlay"): boolean {
	if (mode === "off") return false;
	return reason === "startup" || reason === "reload" || reason === "new" || reason === "resume" || reason === "fork";
}

function overlayAllowed(reason: StartupReason): boolean {
	return reason === "startup";
}

function resourceChipRows(resources: StartupResources | undefined): { label: string; count: number }[] {
	if (!resources) return [];
	const rows: { label: string; count: number }[] = [];
	if (resources.contextFiles !== undefined) rows.push({ label: "context", count: resources.contextFiles });
	if (resources.extensions !== undefined) rows.push({ label: "extensions", count: resources.extensions });
	if (resources.skills !== undefined) rows.push({ label: "skills", count: resources.skills });
	if (resources.prompts !== undefined) rows.push({ label: "prompts", count: resources.prompts });
	if (resources.tools !== undefined) rows.push({ label: "tools", count: resources.tools });
	if (resources.models !== undefined) rows.push({ label: "models", count: resources.models });
	return rows;
}

const PANEL_SIDE_PADDING = 2;
const PANEL_MIN_WIDTH = 64;
const PANEL_OUTER_WIDTH = PANEL_SIDE_PADDING * 2 + 2;
/** Panels render only when the surface is wide enough to keep the box intact. */
const MIN_PANELS_WIDTH = PANEL_MIN_WIDTH + PANEL_OUTER_WIDTH;
const RESOURCE_ROW_GAP = "  ·  ";
const CONTEXT_KIND_RANK: Record<StartupDetailItem["kind"], number> = { system: 0, append: 1, context: 2 };

/** `◆ Resources` summary chips. */
function renderResourceChips(resolved: ResolvedTheme, resources: StartupResources | undefined): string {
	const rows = resourceChipRows(resources);
	if (rows.length === 0) return "";
	const marker = resolved.apply("accent", "◆ Resources");
	const chips = rows.map((row, index) => {
		const label = resolved.apply(index === 0 ? "text" : "muted", row.label);
		const count = resolved.apply("success", String(row.count));
		return `${label} ${count}`;
	});
	return [marker, ...chips].join(resolved.apply("dim", RESOURCE_ROW_GAP));
}

function sortedContextItems(items: readonly StartupDetailItem[]): StartupDetailItem[] {
	return [...items].sort((a, b) => (CONTEXT_KIND_RANK[a.kind] ?? 9) - (CONTEXT_KIND_RANK[b.kind] ?? 9));
}

function renderPanelBorder(resolved: ResolvedTheme, left: string, right: string, panelWidth: number): string {
	return resolved.apply("dim", `${left}${"─".repeat(panelWidth + PANEL_SIDE_PADDING * 2)}${right}`);
}

function renderPanelLine(resolved: ResolvedTheme, content: string, panelWidth: number): string {
	const sidePadding = " ".repeat(PANEL_SIDE_PADDING);
	const padding = " ".repeat(Math.max(0, panelWidth - visibleWidth(content)));
	return `${resolved.apply("dim", "│")}${sidePadding}${content}${padding}${sidePadding}${resolved.apply("dim", "│")}`;
}

/** Boxed System & Context table. */
function renderSystemContextPanel(
	resolved: ResolvedTheme,
	items: readonly StartupDetailItem[],
	minTotalWidth: number,
): string[] {
	const sorted = sortedContextItems(items);
	const titleLine = resolved.apply("accent", "System & Context");
	if (sorted.length === 0) return [];
	const typeHeader = "Type";
	const pathHeader = "Path";
	const metricLabel = "Words/Lines";
	const typeWidth = Math.max(typeHeader.length, ...sorted.map((item) => visibleWidth(item.kind)));
	const divider = resolved.apply("muted", " | ");
	const dividerWidth = visibleWidth(divider);
	const metricWidth = Math.max(metricLabel.length, ...sorted.map((item) => `${item.words}/${item.lines}`.length));
	const fixedColumnsWidth = typeWidth + dividerWidth + dividerWidth + metricWidth;
	const panelWidth = Math.max(PANEL_MIN_WIDTH, minTotalWidth - PANEL_OUTER_WIDTH, visibleWidth(titleLine));
	const pathWidth = Math.max(pathHeader.length, panelWidth - fixedColumnsWidth);
	const header = `${resolved.apply("text", typeHeader.padEnd(typeWidth))}${divider}${resolved.apply(
		"text",
		pathHeader.padEnd(pathWidth),
	)}${divider}${resolved.apply("text", metricLabel.padStart(metricWidth))}`;
	const separator = `${resolved.apply("dim", "─".repeat(typeWidth))}${divider}${resolved.apply(
		"dim",
		"─".repeat(pathWidth),
	)}${divider}${resolved.apply("dim", "─".repeat(metricWidth))}`;
	const lines = [
		renderPanelBorder(resolved, "╭", "╮", panelWidth),
		renderPanelLine(resolved, titleLine, panelWidth),
		renderPanelLine(resolved, header, panelWidth),
		renderPanelLine(resolved, separator, panelWidth),
	];
	for (const item of sorted) {
		const metric = `${item.words}/${item.lines}`;
		const typePadding = " ".repeat(Math.max(0, typeWidth - visibleWidth(item.kind)));
		const path = fitAnsiWidth(item.path, pathWidth);
		const pathPadding = " ".repeat(Math.max(0, pathWidth - visibleWidth(path)));
		const metricPadding = " ".repeat(Math.max(0, metricWidth - visibleWidth(metric)));
		lines.push(
			renderPanelLine(
				resolved,
				`${resolved.apply("text", item.kind)}${typePadding}${divider}${resolved.apply(
					"text",
					path,
				)}${pathPadding}${divider}${metricPadding}${resolved.apply("text", metric)}`,
				panelWidth,
			),
		);
	}
	lines.push(renderPanelBorder(resolved, "╰", "╯", panelWidth));
	return lines;
}

function groupToolDetails(tools: readonly StartupToolItem[]): { source: string; names: string[] }[] {
	const groups = new Map<string, Set<string>>();
	for (const tool of tools) {
		const source = tool.source.trim() || "extension";
		const name = tool.name.trim();
		if (!name) continue;
		let names = groups.get(source);
		if (!names) {
			names = new Set();
			groups.set(source, names);
		}
		names.add(name);
	}
	return [...groups.entries()]
		.map(([source, names]) => ({ source, names: [...names].sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => {
			if (a.source === "core") return -1;
			if (b.source === "core") return 1;
			return a.source.localeCompare(b.source);
		});
}

/**
 * Tool sources as welcome-card rows. Pi has no LSP servers, so the card slot
 * omp gives them carries the providers this session can reach — MCP servers
 * and the built-in core — with a sample of what each offers.
 */
function welcomeProviders(tools: readonly StartupToolItem[]): WelcomeProvider[] {
	return groupToolDetails(tools)
		.slice(0, WELCOME_PROVIDER_SLOTS)
		.map((group) => ({
			name: group.source,
			detail: group.names.slice(0, 3).join("  ") + (group.names.length > 3 ? `  +${group.names.length - 3}` : ""),
		}));
}

/** Boxed Available Tools table. */
function renderToolsPanel(resolved: ResolvedTheme, tools: readonly StartupToolItem[], minTotalWidth: number): string[] {
	const groups = groupToolDetails(tools);
	if (groups.length === 0) return [];
	const titleLine = resolved.apply("accent", "Available Tools");
	const sourceHeader = "Source";
	const countHeader = "Count";
	const toolsHeader = "Tools";
	const countWidth = Math.max(countHeader.length, ...groups.map((group) => String(group.names.length).length));
	const divider = resolved.apply("muted", " | ");
	const dividerWidth = visibleWidth(divider);
	const panelWidth = Math.max(PANEL_MIN_WIDTH, minTotalWidth - PANEL_OUTER_WIDTH, visibleWidth(titleLine));
	const availableTextWidth = Math.max(
		sourceHeader.length + toolsHeader.length,
		panelWidth - countWidth - dividerWidth * 2,
	);
	const maxSourceWidth = Math.max(sourceHeader.length, ...groups.map((group) => visibleWidth(group.source)));
	const sourceWidth = Math.min(maxSourceWidth, Math.max(sourceHeader.length, Math.floor(availableTextWidth * 0.28)));
	const toolsWidth = Math.max(toolsHeader.length, availableTextWidth - sourceWidth);
	const header = `${resolved.apply("text", sourceHeader.padEnd(sourceWidth))}${divider}${resolved.apply(
		"text",
		countHeader.padStart(countWidth),
	)}${divider}${resolved.apply("text", toolsHeader.padEnd(toolsWidth))}`;
	const separator = `${resolved.apply("dim", "─".repeat(sourceWidth))}${divider}${resolved.apply(
		"dim",
		"─".repeat(countWidth),
	)}${divider}${resolved.apply("dim", "─".repeat(toolsWidth))}`;
	const lines = [
		renderPanelBorder(resolved, "╭", "╮", panelWidth),
		renderPanelLine(resolved, titleLine, panelWidth),
		renderPanelLine(resolved, header, panelWidth),
		renderPanelLine(resolved, separator, panelWidth),
	];
	for (const group of groups) {
		const count = String(group.names.length);
		const toolList = fitAnsiWidth(group.names.join(", "), toolsWidth);
		const source = fitAnsiWidth(group.source, sourceWidth);
		const sourcePadding = " ".repeat(Math.max(0, sourceWidth - visibleWidth(source)));
		const countPadding = " ".repeat(Math.max(0, countWidth - count.length));
		lines.push(
			renderPanelLine(
				resolved,
				`${resolved.apply("text", source)}${sourcePadding}${divider}${countPadding}${resolved.apply(
					"success",
					count,
				)}${divider}${resolved.apply("text", toolList)}`,
				panelWidth,
			),
		);
	}
	lines.push(renderPanelBorder(resolved, "╰", "╯", panelWidth));
	return lines;
}

/** Left margin for the whole startup block so it does not touch the terminal edge. */
const STARTUP_INDENT = "    ";
/** Blank rows above the block, separating it from the status line / terminal top. */
const STARTUP_PADDING_TOP = 2;
/** Blank rows below the block, separating it from the editor / chat. */
const STARTUP_PADDING_BOTTOM = 2;

function styledLines(
	theme: ActiveTheme,
	config: NormalizedPiOmpThemeConfig,
	snapshot: StartupSnapshot,
	overlay: boolean,
	width: number,
): string[] {
	if (width <= 0 || config.startup.mode === "off") return [];
	const resolved = resolveTheme(theme, config);
	const lines: string[] = [];
	const indentWidth = visibleWidth(STARTUP_INDENT);
	const bodyWidth = Math.max(1, width - indentWidth);
	const indent = (content: string): string => `${STARTUP_INDENT}${content}`;

	// Breathing room above the block (separates it from the status line / terminal top).
	lines.push(...Array.from({ length: STARTUP_PADDING_TOP }, () => ""));

	// The welcome card is the whole header wherever the terminal can hold two
	// columns; the compact logo row stays as the narrow fallback.
	const card = renderWelcome(
		resolved,
		{
			label: `v${PI_VERSION}`,
			title: "Welcome back!",
			model: snapshot.model,
			provider: snapshot.startupProvider,
			providers: welcomeProviders(snapshot.resources?.toolDetails ?? []),
			sessions: snapshot.resources?.sessions ?? [],
		},
		bodyWidth,
	);
	if (card.length > 0) {
		lines.push(...card.map(indent));
	} else {
		const logoTitle = resolved.mode === "ascii" ? "pi-omp-theme" : `${resolved.glyph("pi")} pi-omp-theme`;
		lines.push(
			...compactLogoHeader(
				resolved,
				[
					resolved.apply("accent", logoTitle),
					resolved.apply("muted", "/ commands · ! bash"),
					resolved.apply("success", "● ready"),
				],
				bodyWidth,
			).map(indent),
		);
	}

	const info: string[] = [];
	if (config.startup.showResources) {
		const chips = renderResourceChips(resolved, snapshot.resources);
		if (chips) info.push(chips);
		if (snapshot.resources?.error)
			info.push(resolved.apply("muted", `resources unavailable  ·  ${snapshot.resources.error}`));
	}
	if (info.length > 0) lines.push("", ...info.map(indent));

	const expanded = overlay || config.startup.alwaysExpanded;
	if (expanded && bodyWidth >= MIN_PANELS_WIDTH && config.startup.showResources) {
		const contextItems = snapshot.resources?.details ?? [];
		const toolItems = snapshot.resources?.toolDetails ?? [];
		if (contextItems.length > 0) {
			lines.push("");
			lines.push(...renderSystemContextPanel(resolved, contextItems, bodyWidth).map(indent));
		}
		if (toolItems.length > 0) {
			lines.push("");
			lines.push(...renderToolsPanel(resolved, toolItems, bodyWidth).map(indent));
		}
	}

	// Breathing room below the block (separates it from the editor / chat).
	lines.push(...Array.from({ length: STARTUP_PADDING_BOTTOM }, () => ""));
	if (overlay) lines.push(indent(resolved.apply("dim", "enter prompt to continue  ·  esc dismiss")));

	return lines.map((line) => (visibleWidth(line) <= width ? line : truncateAnsi(line, width, "")));
}

class StartupComponent implements Component {
	private snapshot: StartupSnapshot;
	private config: NormalizedPiOmpThemeConfig;
	private readonly theme: ActiveTheme;
	private readonly overlay: boolean;
	private readonly requestRender: () => void;

	constructor(
		theme: ActiveTheme,
		config: NormalizedPiOmpThemeConfig,
		snapshot: StartupSnapshot,
		overlay: boolean,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.config = config;
		this.snapshot = snapshot;
		this.overlay = overlay;
		this.requestRender = requestRender;
	}

	setSnapshot(snapshot: StartupSnapshot): void {
		this.snapshot = snapshot;
		this.invalidate();
	}

	setConfig(config: NormalizedPiOmpThemeConfig): void {
		this.config = config;
		this.invalidate();
	}

	render(width: number): string[] {
		return styledLines(this.theme, this.config, this.snapshot, this.overlay, width);
	}

	invalidate(): void {
		this.requestRender();
	}
}

export function renderStartup(
	snapshot: StartupSnapshot,
	config: NormalizedPiOmpThemeConfig,
	theme: ActiveTheme,
	width: number,
	overlay = false,
): string[] {
	return styledLines(theme, config, snapshot, overlay, width);
}

export function installStartup(options: StartupInstallOptions): StartupInstallation | undefined {
	const { host } = options;
	if (options.config.startup.mode === "off" || !shouldShow(options.snapshot.reason, options.config.startup.mode))
		return undefined;
	if (!host.hasUI || host.mode !== "tui") return undefined;
	const token = Symbol("pi-omp-theme.startup");
	const map = ownerMap(host as object);
	let config = options.config;
	let snapshot = options.snapshot;
	let disposed = false;
	let dismissed = false;
	let headerInstalled = false;
	let installedHeaderFactory: unknown;
	let widgetInstalled = false;
	let overlayHandle: OverlayHandle | undefined;
	let removeInput: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let overlayDone: ((value: undefined) => void) | undefined;
	const components: StartupComponent[] = [];
	const timeoutMs = options.timeoutMs;
	const component = (theme: unknown, isOverlay: boolean, tui: { requestRender?: () => void }) => {
		const result = new StartupComponent(activeThemeFromPi(theme), config, snapshot, isOverlay, () => {
			tui.requestRender?.();
			options.requestRender?.();
		});
		components.push(result);
		return result;
	};
	const clearTimer = () => {
		if (timeout) clearTimeout(timeout);
		timeout = undefined;
	};
	const dismiss = () => {
		if (disposed || dismissed) return;
		dismissed = true;
		clearTimer();
		overlayHandle?.hide();
		overlayHandle = undefined;
		overlayDone?.(undefined);
		overlayDone = undefined;
	};
	const clearHeader = () => {
		if (!headerInstalled || map.get("header") !== token) return;
		const current = host.getHeaderFactory?.();
		if (host.getHeaderFactory && current !== installedHeaderFactory) return;
		if (host.setHeader) safeCall(() => host.setHeader?.(undefined));
		map.delete("header");
	};
	const clearWidget = () => {
		if (!widgetInstalled || map.get(STARTUP_WIDGET_KEY) !== token) return;
		if (host.setWidget) safeCall(() => host.setWidget?.(STARTUP_WIDGET_KEY, undefined));
		map.delete(STARTUP_WIDGET_KEY);
	};
	const mountCompact = (): boolean => {
		const factory = (tui: unknown, theme: unknown) => component(theme, false, tui as { requestRender?: () => void });
		// Pi's public `setHeader` is the intended startup-header surface ("shown at
		// startup, above chat"). Prefer it so the startup renders at the top of the
		// terminal rather than inside the editor area. The injected ownership
		// adapter, when present, still guards against overwriting a later owner;
		// the widget remains the fallback when the header API is unavailable.
		let currentHeader: unknown = Symbol("unreadable");
		const observable =
			host.getHeaderFactory &&
			safeCall(() => {
				currentHeader = host.getHeaderFactory?.();
			});
		const headerAvailable = host.setHeader !== undefined && (!observable || currentHeader === undefined);
		if (headerAvailable && safeCall(() => host.setHeader?.(factory))) {
			installedHeaderFactory = factory;
			headerInstalled = true;
			map.set("header", token);
			return true;
		}
		if (host.setWidget && safeCall(() => host.setWidget?.(STARTUP_WIDGET_KEY, factory, { placement: "aboveEditor" }))) {
			widgetInstalled = true;
			map.set(STARTUP_WIDGET_KEY, token);
			return true;
		}
		return false;
	};
	const mountOverlay = () => {
		if (!host.custom || !overlayAllowed(snapshot.reason)) {
			mountCompact();
			return;
		}
		const overlayOptions: OverlayOptions = {
			anchor: "center",
			width: "80%",
			maxHeight: "60%",
			minWidth: 40,
			visible: (width, height) => width >= 40 && height >= 8,
		};
		void host
			.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					overlayDone = done;
					return component(theme, true, tui as { requestRender?: () => void });
				},
				{ overlay: true, overlayOptions, onHandle: (handle) => (overlayHandle = handle) },
			)
			.catch(() => {
				if (!disposed && !dismissed) {
					clearTimer();
					mountCompact();
				}
			});
	};
	const installation: StartupInstallation = {
		generation: options.generation,
		update(next) {
			if (disposed || options.isCurrent?.() === false) return;
			snapshot = next;
			for (const item of components) item.setSnapshot(next);
			options.requestRender?.();
		},
		dismiss,
		configure(next) {
			if (disposed || options.isCurrent?.() === false) return;
			config = next;
			for (const item of components) item.setConfig(next);
			if (next.startup.mode === "off") {
				dismiss();
				clearHeader();
				clearWidget();
			}
			options.requestRender?.();
		},
		dispose() {
			if (disposed) return;
			dismiss();
			disposed = true;
			removeInput?.();
			removeInput = undefined;
			clearHeader();
			clearWidget();
			map.delete("installation");
		},
	};
	map.set("installation", token);
	removeInput = host.onTerminalInput?.(() => dismiss());
	if (config.startup.mode === "compact" && !mountCompact()) {
		installation.dispose();
		return undefined;
	}
	if (config.startup.mode === "overlay") mountOverlay();
	if (config.startup.mode === "overlay" && timeoutMs !== undefined && timeoutMs >= 0) {
		timeout = setTimeout(() => dismiss(), timeoutMs);
	}
	return installation;
}
