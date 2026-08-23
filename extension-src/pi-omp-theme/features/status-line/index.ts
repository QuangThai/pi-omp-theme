import { editorHostsBorderStatusAt } from "../../domain/config-normalization.js";
import type { NormalizedPiOmpThemeConfig } from "../../domain/config-types.js";
import { createBuiltinSegments, type SegmentContext, type StatusSnapshot } from "../../domain/status.js";
import { renderStatus, resolveStatusSeparator } from "../../domain/status-renderer.js";
import { type ResolvedTheme, resolveTheme } from "../../domain/theme.js";
import { fitAnsiWidth } from "../../shared/ansi.js";

export const PRIMARY_WIDGET_KEY = "pi-omp-theme.status.primary";
export const SECONDARY_WIDGET_KEY = "pi-omp-theme.status.secondary";

type WidgetPlacement = "aboveEditor" | "belowEditor";
type RenderComponent = { render(width: number): string[]; invalidate(): void; dispose?(): void };
type WidgetFactory = (tui: { requestRender?: () => void }, theme: ActivePiTheme) => RenderComponent;

/** Read-only view of Pi's footer data provider, kept out of the domain layer. */
export interface FooterDataProviderView {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}

type FooterFactory = (
	tui: { requestRender?: (force?: boolean) => void },
	// The footer renders nothing, so the theme is intentionally untyped.
	theme: unknown,
	footerData: FooterDataProviderView,
) => RenderComponent;

/** Minimal structural view of Pi's theme, kept out of the domain layer. */
export interface ActivePiTheme {
	fg?: (token: string, text: string) => string;
	colors?: Record<string, string>;
}

export interface StatusLineWidgetHost {
	setWidget(
		key: string,
		content: string[] | WidgetFactory | undefined,
		options?: { placement?: WidgetPlacement },
	): void;
	/** Replace the native Pi footer with a pi-omp-theme owned component; undefined restores it. */
	setFooter(factory: FooterFactory | undefined): void;
}

export interface StatusLineInstallation {
	readonly generation: number;
	readonly primaryKey: typeof PRIMARY_WIDGET_KEY;
	readonly secondaryKey: typeof SECONDARY_WIDGET_KEY;
	update(snapshot: StatusSnapshot): void;
	configure(config: NormalizedPiOmpThemeConfig): void;
	dispose(): void;
}

export interface StatusLineInstallOptions {
	host: StatusLineWidgetHost;
	config: NormalizedPiOmpThemeConfig;
	generation: number;
	initialSnapshot: StatusSnapshot;
	isCurrent?: () => boolean;
	/** Force a full terminal redraw (clear screen + scrollback) on the first footer mount. */
	clearOnStartup?: boolean;
}

interface Ownership {
	token: symbol;
	generation: number;
}

const ownership = new WeakMap<object, Map<string, Ownership>>();
const activeInstallations = new WeakMap<object, Map<number, StatusLineInstallation>>();

function ownerMap(host: object): Map<string, Ownership> {
	let map = ownership.get(host);
	if (!map) {
		map = new Map();
		ownership.set(host, map);
	}
	return map;
}
function installationMap(host: object): Map<number, StatusLineInstallation> {
	let map = activeInstallations.get(host);
	if (!map) {
		map = new Map();
		activeInstallations.set(host, map);
	}
	return map;
}
function safeWidget(
	host: StatusLineWidgetHost,
	key: string,
	content: string[] | WidgetFactory | undefined,
	placement?: WidgetPlacement,
): boolean {
	try {
		host.setWidget(key, content, placement ? { placement } : undefined);
		return true;
	} catch {
		return false;
	}
}
/**
 * The row yields to the editor frame only when that frame will actually host the
 * status at this width. Deciding per render (not per config) is what keeps a
 * narrow terminal from losing the status line altogether.
 */
function statusRowVisible(config: NormalizedPiOmpThemeConfig, width: number): boolean {
	return config.placement !== "border" || !editorHostsBorderStatusAt(config, width);
}
function placementFor(config: NormalizedPiOmpThemeConfig): WidgetPlacement {
	// Only an explicit "above" lifts the row; "border" falling back at a narrow
	// width lands below the editor, where the row used to live.
	return config.placement === "above" ? "aboveEditor" : "belowEditor";
}
function separatorsFor(config: NormalizedPiOmpThemeConfig, theme: ResolvedTheme): string {
	return resolveStatusSeparator(config.statusLine.separator, theme);
}

export function installStatusLine(options: StatusLineInstallOptions): StatusLineInstallation {
	const existing = installationMap(options.host).get(options.generation);
	if (existing) return existing;
	const token = Symbol("pi-omp-theme.status-line");
	const owners = ownerMap(options.host);
	let config = options.config;
	let snapshot: StatusSnapshot = options.initialSnapshot;
	let disposed = false;
	let primaryComponent: RenderComponent | undefined;
	let secondaryComponent: RenderComponent | undefined;
	let footerData: FooterDataProviderView | undefined;
	let footerOwner = false;
	let footerUnsubscribe: (() => void) | undefined;
	let clearedOnStartup = false;
	const segments = new Map(createBuiltinSegments());
	for (const item of config.statusLine.customItems) {
		if (!item.id || !item.statusKey) continue;
		segments.set(item.id, {
			id: item.id,
			defaultPriority: item.priority ?? 40,
			overflow: "secondary",
			render: ({ snapshot }: SegmentContext) => {
				const status = snapshot.extensionStatuses?.find(
					(entry: { readonly key: string; readonly value: string }) => entry.key === item.statusKey,
				);
				if (!status) return { visible: false, content: "" };
				return { visible: true, content: `${item.label ? `${item.label}:` : ""}${status.value}`, truncatable: true };
			},
		});
	}

	// Resolving the theme re-detects the glyph mode and allocates a fresh closure
	// set. The status line renders on every frame, so keep the resolution per
	// (Pi theme, config) pair — both identities change exactly when it must be redone.
	let themeCache:
		| { theme: ActivePiTheme; config: NormalizedPiOmpThemeConfig; resolved: ResolvedTheme; separator: string }
		| undefined;
	let themeVersion = 0;
	// Pi calls render() on every component of every frame, so during streaming this
	// runs at the frame rate even when nothing in the status changed. Hand back the
	// previous lines unless an input actually differs.
	const lineCache = new Map<boolean, { key: string; lines: string[] }>();
	const themeFor = (activeTheme: ActivePiTheme) => {
		if (themeCache && themeCache.theme === activeTheme && themeCache.config === config) return themeCache;
		const resolved = resolveTheme(
			activeTheme.colors || activeTheme.fg
				? {
						...(activeTheme.colors ? { colors: activeTheme.colors } : {}),
						// Call through the theme instance so `this` binds correctly inside Pi's fg().
						...(activeTheme.fg ? { fg: (color: string, text: string) => activeTheme.fg?.(color, text) ?? text } : {}),
					}
				: undefined,
			config,
		);
		themeCache = { theme: activeTheme, config, resolved, separator: separatorsFor(config, resolved) };
		themeVersion++;
		return themeCache;
	};

	const render = (activeTheme: ActivePiTheme, width: number, secondary: boolean): string[] => {
		if (width <= 0 || !config.enabled || !config.statusLine.enabled) return [];
		// Border placement: the frame draws it instead — but only while it is wide
		// enough to, so a narrow terminal still gets its status row.
		if (!statusRowVisible(config, width)) return [];
		// Border placement: the frame draws it instead — but only while it is wide
		// enough to, so a narrow terminal still gets its status row.
		if (!statusRowVisible(config, width)) return [];
		const { resolved, separator } = themeFor(activeTheme);
		const effective = effectiveSnapshot(snapshot);
		const key = `${width}|${themeVersion}|${JSON.stringify(effective)}`;
		const cached = lineCache.get(secondary);
		if (cached && cached.key === key) return cached.lines;
		const result = renderStatus(config.statusLine.layout, effective, width, {
			separator,
			segments,
			theme: resolved,
			options: {
				...Object.fromEntries(config.statusLine.disabledSegments.map((id) => [id, { disabled: true }])),
				context_bar: { width: config.statusLine.contextBarWidth },
			},
		});
		const lines = secondary ? result.lines.slice(1) : result.lines.slice(0, 1);
		// Truncate rather than drop an overlong row: a row that vanishes and returns
		// changes the dock height, and a height change makes Pi repaint far more than
		// the row itself.
		const truncated = lines.map((line) => fitAnsiWidth(line, width));
		const rendered =
			!secondary && truncated.length > 0 && config.statusLine.bottomMargin > 0
				? // Blank rows below the primary row keep the status line off the terminal edge.
					[...truncated, ...Array.from({ length: config.statusLine.bottomMargin }, () => "")]
				: truncated;
		lineCache.set(secondary, { key, lines: rendered });
		return rendered;
	};
	/** Merge authoritative native footer data (branch + extension statuses) into the snapshot. */
	const effectiveSnapshot = (input: StatusSnapshot): StatusSnapshot => {
		if (!footerData) return input;
		const statuses = footerData.getExtensionStatuses();
		const extensionStatuses = statuses.size > 0 ? [...statuses].map(([key, value]) => ({ key, value })) : undefined;
		const branch = footerData.getGitBranch();
		const git = branch && input.git ? { ...input.git, branch } : input.git;
		return {
			...input,
			...(extensionStatuses ? { extensionStatuses } : {}),
			...(git ? { git } : {}),
		};
	};
	const releaseFooterData = (): void => {
		footerUnsubscribe?.();
		footerUnsubscribe = undefined;
		footerData = undefined;
	};
	const footerFactory: FooterFactory = (tui, _theme, data) => {
		footerData = data;
		footerUnsubscribe?.();
		footerUnsubscribe = data.onBranchChange(() => {
			primaryComponent?.invalidate();
			secondaryComponent?.invalidate();
			tui.requestRender?.();
		});
		if (options.clearOnStartup && !clearedOnStartup) {
			clearedOnStartup = true;
			// Force a full redraw on the first frame: clears the screen and scrollback.
			tui.requestRender?.(true);
		}
		return {
			// The native footer is replaced by an empty component; visible status lives in widgets.
			render() {
				return [];
			},
			invalidate() {
				tui.requestRender?.();
			},
			dispose() {
				releaseFooterData();
			},
		};
	};
	const mountFooter = (): void => {
		if (disposed || options.isCurrent?.() === false) return;
		if (!config.enabled || !config.statusLine.enabled) {
			clearFooter();
			return;
		}
		try {
			options.host.setFooter(footerFactory);
			footerOwner = true;
		} catch {
			footerOwner = false;
		}
	};
	const clearFooter = (): void => {
		if (!footerOwner) return;
		footerOwner = false;
		releaseFooterData();
		try {
			options.host.setFooter(undefined);
		} catch {
			// Best-effort restore; cleanup must never throw.
		}
	};
	const factory =
		(secondary: boolean): WidgetFactory =>
		(tui, theme) => {
			const currentTheme = theme;
			const component: RenderComponent = {
				render(width) {
					const lines = render(currentTheme, width, secondary);
					return lines;
				},
				invalidate() {
					// Pi supplies a fresh theme to the factory on theme replacement. Do not retain
					// pre-rendered ANSI strings; the next render reads the current component theme.
					primaryComponent = secondary ? primaryComponent : component;
					secondaryComponent = secondary ? component : secondaryComponent;
					if (tui.requestRender) tui.requestRender();
				},
				dispose() {},
			};
			if (secondary) secondaryComponent = component;
			else primaryComponent = component;
			return component;
		};
	const claim = (key: string) => owners.set(key, { token, generation: options.generation });
	const mount = () => {
		if (disposed || options.isCurrent?.() === false) return;
		if (!config.enabled || !config.statusLine.enabled) {
			clear(PRIMARY_WIDGET_KEY);
			clear(SECONDARY_WIDGET_KEY);
			clearFooter();
			return;
		}
		if (safeWidget(options.host, PRIMARY_WIDGET_KEY, factory(false), placementFor(config))) claim(PRIMARY_WIDGET_KEY);
		if (safeWidget(options.host, SECONDARY_WIDGET_KEY, factory(true), "belowEditor")) claim(SECONDARY_WIDGET_KEY);
		mountFooter();
	};
	function clear(key: string): void {
		const current = owners.get(key);
		if (current?.token !== token || current.generation !== options.generation) return;
		if (safeWidget(options.host, key, undefined)) owners.delete(key);
	}
	const installation: StatusLineInstallation = {
		generation: options.generation,
		primaryKey: PRIMARY_WIDGET_KEY,
		secondaryKey: SECONDARY_WIDGET_KEY,
		update(next) {
			if (disposed || options.isCurrent?.() === false) return;
			snapshot = next;
			primaryComponent?.invalidate();
			secondaryComponent?.invalidate();
		},
		configure(next) {
			if (disposed || options.isCurrent?.() === false) return;
			const placementChanged = placementFor(next) !== placementFor(config);
			const enabledChanged = next.enabled !== config.enabled || next.statusLine.enabled !== config.statusLine.enabled;
			config = next;
			if (placementChanged || enabledChanged) {
				clear(PRIMARY_WIDGET_KEY);
				clear(SECONDARY_WIDGET_KEY);
				clearFooter();
				primaryComponent = undefined;
				secondaryComponent = undefined;
				mount();
			} else {
				primaryComponent?.invalidate();
				secondaryComponent?.invalidate();
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clear(PRIMARY_WIDGET_KEY);
			clear(SECONDARY_WIDGET_KEY);
			clearFooter();
			installationMap(options.host).delete(options.generation);
		},
	};
	installationMap(options.host).set(options.generation, installation);
	mount();
	return installation;
}
