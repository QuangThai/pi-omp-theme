export const PI_OMP_THEME_SCHEMA_VERSION = 1 as const;

/** "border" draws the status into the editor's top border instead of a row. */
export type Placement = "above" | "below" | "border";
export type NerdFontsMode = "auto" | "on" | "off";
/** Sweep style for the working-message shimmer. */
export type ShimmerMode = "classic" | "kitt" | "off";
/**
 * How much frame a tool block draws around itself: "boxed" frames, "light" keeps
 * the boxed layout without the frame, "inline" is the Claude Code transcript
 * (`● Tool(args)` header and a `⎿` result gutter).
 */
export type ToolChrome = "boxed" | "light" | "inline";
export type ToggleMode = "auto" | "on" | "off";
export type PresetName =
	| "default"
	| "minimal"
	| "compact"
	| "full"
	| "ascii"
	| "native"
	| "claude"
	| "claude-code"
	| "omp";
export type EditorStyle = "compact" | "boxed" | "dock" | "native";
export type EditorFrame = "auto" | "halfblock" | "line" | "solid" | "outline" | "rounded" | "claude" | "native";

export interface StatusCustomItemConfig {
	id: string;
	statusKey: string;
	label?: string;
	priority?: number;
	placement?: "left" | "right" | "secondary";
}

export interface PiOmpThemeConfig {
	enabled?: boolean;
	/** Opt in to adding grep/find/ls at session start; never removes active tools. */
	readonlyTools?: boolean;
	preset?: string;
	placement?: string;
	startup?: { mode?: string; showResources?: boolean; alwaysExpanded?: boolean };
	statusLine?: {
		enabled?: boolean;
		separator?: string;
		layout?: { left?: string[]; right?: string[]; secondary?: string[] };
		disabledSegments?: string[];
		customItems?: StatusCustomItemConfig[];
		/** Blank rows reserved below the primary status row (0 disables). */
		bottomMargin?: number;
		/** Context progress-bar cell count (default 10). */
		contextBarWidth?: number;
	};
	editor?: { enabled?: boolean; style?: string; frame?: string; showMetadata?: boolean; hint?: string };
	messages?: {
		enabled?: boolean;
		assistantPrefix?: boolean;
		specialBlocks?: boolean;
		hideThinkingLabel?: boolean;
		hideInterimText?: boolean;
		/** Mark each assistant text block with a `●` and hang its lines under it. */
		assistantMarker?: boolean;
		/** Show hidden thinking as one `● Thought for 6s` line instead of no trace. */
		thinkingSummary?: boolean;
		/** Follow Pi's interrupted-turn notice with `· What should the agent do instead?`. */
		interruptHint?: boolean;
	};
	tools?: {
		enabled?: boolean;
		style?: string;
		maxCollapsedLines?: number;
		maxExpandedLines?: number;
		dimOutput?: boolean;
		showElapsed?: boolean;
		/** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
		collapseAfterTurn?: boolean;
		batchQuietCalls?: boolean;
		chrome?: string;
		/** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
		collapseMutatingTools?: boolean;
		/** Inline edits open with `Updated <path> with 2 additions and 1 removal`. */
		editSummary?: boolean;
	};
	theme?: {
		nerdFonts?: string;
		shimmer?: string;
		/** Show the run's elapsed time on the working row (`Working… (14s · …)`). */
		workingElapsed?: boolean;
		/** Show the run's output tokens on the working row (`↓ 1.2k tokens`). */
		workingTokens?: boolean;
		cacheHighlight?: boolean;
		sessionAccent?: boolean;
		terminalBackgroundSync?: string;
		/** Pi theme name auto-applied at TUI session start ("off" disables; default "titanium"). */
		autoApply?: string;
		colors?: Record<string, unknown>;
		glyphs?: Record<string, unknown>;
	};
	widgets?: {
		/** Extension widget keys kept off screen (for example `pi-todo`). */
		hide?: string[];
	};
	compatibility?: {
		allowSafePatches?: boolean;
		allowCorePatches?: boolean;
		preferExistingEditor?: boolean;
		preferExistingFooter?: boolean;
	};
	debug?: boolean;
	schemaVersion?: number;
}

export interface NormalizedPiOmpThemeConfig {
	readonly schemaVersion: typeof PI_OMP_THEME_SCHEMA_VERSION;
	readonly enabled: boolean;
	readonly readonlyTools: boolean;
	readonly preset: PresetName;
	readonly placement: Placement;
	readonly startup: {
		mode: "off" | "compact" | "overlay";
		showResources: boolean;
		alwaysExpanded: boolean;
	};
	readonly statusLine: {
		enabled: boolean;
		separator: string;
		layout: { left: readonly string[]; right: readonly string[]; secondary: readonly string[] };
		disabledSegments: readonly string[];
		customItems: readonly StatusCustomItemConfig[];
		/** Blank rows reserved below the primary status row (0 disables). */
		bottomMargin: number;
		/** Context progress-bar cell count. */
		contextBarWidth: number;
	};
	readonly editor: { enabled: boolean; style: EditorStyle; frame: EditorFrame; showMetadata: boolean; hint: string };
	readonly messages: {
		enabled: boolean;
		assistantPrefix: boolean;
		specialBlocks: boolean;
		hideThinkingLabel: boolean;
		hideInterimText: boolean;
		/** Mark each assistant text block with a `●` and hang its lines under it. */
		assistantMarker: boolean;
		/** Show hidden thinking as one `● Thought for 6s` line instead of no trace. */
		thinkingSummary: boolean;
		/** Follow Pi's interrupted-turn notice with `· What should the agent do instead?`. */
		interruptHint: boolean;
	};
	readonly tools: {
		enabled: boolean;
		style: string;
		maxCollapsedLines: number;
		maxExpandedLines: number;
		dimOutput: boolean;
		showElapsed: boolean;
		/** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
		collapseAfterTurn: boolean;
		/** Group back-to-back read/ls/find calls into one panel. */
		batchQuietCalls: boolean;
		/** "boxed" draws a full frame per tool; "light" keeps the layout without it; "inline" is the Claude Code transcript. */
		chrome: ToolChrome;
		/** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
		collapseMutatingTools: boolean;
		/** Inline edits open with `Updated <path> with 2 additions and 1 removal`. */
		editSummary: boolean;
	};
	readonly theme: {
		nerdFonts: NerdFontsMode;
		/** Working-message sweep: "classic" cosine band, "kitt" scanner, "off" static. */
		shimmer: ShimmerMode;
		/** Show the run's elapsed time on the working row. */
		workingElapsed: boolean;
		/** Show the run's output tokens on the working row. */
		workingTokens: boolean;
		/** Memoize Pi's syntax highlighting across streaming deltas. */
		cacheHighlight: boolean;
		/** Tint a named session's editor border with a colour derived from its name. */
		sessionAccent: boolean;
		terminalBackgroundSync: ToggleMode;
		/** Pi theme name auto-applied at TUI session start; "off" disables the surface. */
		autoApply: string;
		colors: Readonly<Record<string, string>>;
		glyphs: Readonly<Record<string, string>>;
	};
	readonly widgets: {
		/** Extension widget keys kept off screen; their extensions keep running. */
		hide: readonly string[];
	};
	readonly compatibility: {
		allowSafePatches: boolean;
		allowCorePatches: boolean;
		preferExistingEditor: boolean;
		preferExistingFooter: boolean;
	};
	/** Internal provenance marker; never serialized or accepted as a command field. */
	readonly productCorePatchesExplicit?: boolean;
	readonly debug: boolean;
}

export interface ConfigSources {
	defaults?: unknown;
	global?: unknown;
	project?: unknown;
	environment?: Record<string, string | undefined>;
	session?: unknown;
	projectTrusted?: boolean;
}
