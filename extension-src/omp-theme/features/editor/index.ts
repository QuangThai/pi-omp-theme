import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
// Width goes through the fast path in render-budget: Pi's own visibleWidth runs
// grapheme segmentation and emoji regexes per call, which dominates the per-frame
// cost on long messages. The fast path answers plain SGR + ASCII directly and
// falls back to Pi's for anything else, so the measure stays identical.
import { safeVisibleWidth as visibleWidth } from "../../shared/render-budget.js";
import type { NormalizedPiOmpThemeConfig } from "../../domain/config-types.js";
import { contextPercent, createBuiltinSegments, type StatusSnapshot, type ThinkingLevel } from "../../domain/status.js";
import { editorHostsBorderStatusAt } from "../../domain/config-normalization.js";
import { renderStatus, resolveStatusSeparator } from "../../domain/status-renderer.js";
import type { ResolvedTheme } from "../../domain/theme.js";
import { resolveTheme } from "../../domain/theme.js";
import { stripAnsi, truncateAnsi } from "../../shared/ansi.js";

export const EDITOR_DIAGNOSTIC_KEY = "pi-omp-theme.editor";
type SetEditorComponent = NonNullable<ExtensionUIContext["setEditorComponent"]>;
type EditorFactory = NonNullable<Parameters<SetEditorComponent>[0]>;
type Tui = Parameters<EditorFactory>[0];
type PiEditorTheme = Parameters<EditorFactory>[1];
type Keybindings = Parameters<EditorFactory>[2];
type EditorHost = Pick<ExtensionUIContext, "setEditorComponent"> & {
	getEditorComponent?: () => EditorFactory | undefined;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	/** Full Pi theme; provides thinking-level border colors when available. */
	readonly theme?: {
		getThinkingBorderColor?: (level: ThinkingLevel) => (str: string) => string;
		/** Pi's semantic colouring; needed to paint the status hosted in the border. */
		fg?(color: string, text: string): string;
		colors?: Record<string, string>;
	};
};

export interface EditorInstallation {
	readonly generation: number;
	readonly installedFactory: EditorFactory;
	readonly previousFactory: EditorFactory | undefined;
	readonly preservedPrevious: boolean;
	update(snapshot: StatusSnapshot): void;
	configure(config: NormalizedPiOmpThemeConfig): void;
	dispose(): void;
}

interface EditorOptions {
	config: NormalizedPiOmpThemeConfig;
	snapshot: StatusSnapshot;
	theme: PiEditorTheme;
	/** Full Pi theme for thinking-level border colors (optional; falls back to borderColor). */
	fullTheme?: {
		getThinkingBorderColor?: (level: ThinkingLevel) => (str: string) => string;
		fg?(color: string, text: string): string;
		colors?: Record<string, string>;
	};
	onSnapshot: (snapshot: StatusSnapshot) => void;
}

const widthOf = visibleWidth;

/** Theme tokens a session accent may pick from; all are defined by every theme. */

/** 224000 -> 224K, matching the status line's own token formatting. */
function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}K`;
	return String(value);
}

/** Where a speculative compaction pass starts, and where auto-compaction fires. */
const CONTEXT_SPECULATION_PERCENT = 70;
const CONTEXT_COMPACTION_PERCENT = 90;

const SESSION_ACCENT_TOKENS = ["accent", "success", "warning", "cost", "cache", "contextHigh", "gitClean"] as const;

/** Same tiers the status line uses, so the gauge and the percentage agree. */
function contextGaugeToken(percent: number): "contextLow" | "contextMedium" | "contextHigh" | "contextCritical" {
	if (percent >= 90) return "contextCritical";
	if (percent >= 70) return "contextHigh";
	if (percent >= 50) return "contextMedium";
	return "contextLow";
}


function widthSafe(value: string, width: number): string {
	if (width <= 0) return "";
	const fitted = widthOf(value) > width ? truncateAnsi(value, width, "") : value;
	const current = widthOf(fitted);
	return current < width ? fitted + " ".repeat(width - current) : fitted;
}

/**
 * Drop the side glyphs a row was already wrapped in, so the closing corners can
 * take their place without the row measuring two cells too wide.
 */
function stripSideBorders(line: string): string {
	const plain = stripAnsi(line);
	if (!plain.startsWith("│") || !plain.endsWith("│")) return line;
	return line.replace(/^(\x1b\[[0-9;]*m)*│/, "").replace(/│((\x1b\[[0-9;]*m)*)$/, "$1");
}

function isNativeBorderLine(line: string): boolean {
	const stripped = stripAnsi(line);
	return /^─{2,}$/.test(stripped) || /^─── [↑↓] \d+ more /.test(stripped);
}

/**
 * Remove `count` leading visible characters from an ANSI-rendered editor line,
 * preserving escape sequences (CSI/OSC/APC/DCS) verbatim. Used to hide the
 * bash-mode `!` prefix; the CURSOR_MARKER and cursor-block sequences pass
 * through unchanged so hardware-cursor placement stays aligned.
 */
function stripLeadingVisibleChars(line: string, count: number): string {
	if (count <= 0 || line.length === 0) return line;
	let output = "";
	let stripped = 0;
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === "\x1b") {
			const start = index;
			index++;
			const intro = line[index];
			if (intro === "[") {
				index++;
				while (index < line.length) {
					const byte = line[index] ?? "";
					index++;
					if (byte >= "@" && byte <= "~") break;
				}
			} else if (intro === "]" || intro === "_" || intro === "^" || intro === "P") {
				index++;
				while (index < line.length) {
					const byte = line[index] ?? "";
					if (byte === "\x1b" && line[index + 1] === "\\") {
						index += 2;
						break;
					}
					index++;
					if (byte === "\x07") break;
				}
			} else if (intro !== undefined) {
				index++;
			}
			output += line.slice(start, index);
			continue;
		}
		if (stripped < count) {
			stripped++;
			index++;
			continue;
		}
		output += char;
		index++;
	}
	return output;
}

/**
 * Full palette for status content drawn inside the frame. semanticTheme() only
 * answers border tokens — everything else resolves to no colour there, which is
 * why the hosted status rendered nearly monochrome.
 */
function statusLineTheme(
	full: EditorOptions["fullTheme"],
	config: NormalizedPiOmpThemeConfig,
): ResolvedTheme {
	return resolveTheme(
		full?.fg || full?.colors
			? {
					...(full.colors ? { colors: full.colors } : {}),
					...(full.fg ? { fg: (color: string, text: string) => full.fg?.(color, text) ?? text } : {}),
				}
			: undefined,
		config,
	);
}

function semanticTheme(theme: PiEditorTheme, config: NormalizedPiOmpThemeConfig): ResolvedTheme {
	const editorTheme = theme;
	return resolveTheme(
		{
			fg: (token) => {
				if (token === "borderActive" || token.startsWith("thinking")) return editorTheme.borderColor("");
				return "";
			},
		},
		config,
	);
}

/**
 * A thin CustomEditor treatment: all text, cursor, paste, autocomplete, history,
 * and keybinding state remains owned by Pi's editor implementation.
 */
export class StyledEditor extends CustomEditor implements EditorComponent {
	private config: NormalizedPiOmpThemeConfig;
	private snapshot: StatusSnapshot;
	private readonly piTheme: PiEditorTheme;
	private readonly fullTheme: EditorOptions["fullTheme"];
	private readonly onSnapshot: (snapshot: StatusSnapshot) => void;
	private semantic: ResolvedTheme;
	private statusTheme: ResolvedTheme;
	private disposed = false;

	constructor(tui: Tui, theme: PiEditorTheme, keybindings: Keybindings, options: EditorOptions) {
		super(tui, theme, keybindings);
		this.config = options.config;
		this.snapshot = options.snapshot;
		this.piTheme = theme;
		this.fullTheme = options.fullTheme;
		this.onSnapshot = options.onSnapshot;
		this.semantic = semanticTheme(theme, options.config);
		this.statusTheme = statusLineTheme(options.fullTheme, options.config);
		this.setPaddingX(0);
	}

	update(snapshot: StatusSnapshot): void {
		if (this.disposed) return;
		this.snapshot = snapshot;
		this.invalidate();
	}

	configure(config: NormalizedPiOmpThemeConfig): void {
		if (this.disposed) return;
		this.config = config;
		this.semantic = semanticTheme(this.piTheme, config);
		this.statusTheme = statusLineTheme(this.fullTheme, config);
		this.invalidate();
	}

	override handleInput(data: string): void {
		if (this.disposed) return;
		super.handleInput(data);
		this.onSnapshot({ ...this.snapshot });
	}

	override invalidate(): void {
		super.invalidate();
		this.semantic = semanticTheme(this.piTheme, this.config);
		this.statusTheme = statusLineTheme(this.fullTheme, this.config);
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const style = this.styleFor(width);
		// Only the autocomplete and native paths lay the input out at the full width;
		// the framed styles re-render at the inner width below. Rendering both costs a
		// full text layout per frame and throws one of them away.
		// Autocomplete (slash menu / @-mentions) restructure: Pi draws the
		// suggestions after its own bottom border, which pushes the below-editor
		// widgets (status line) down. Re-frame the native output so the dropdown
		// lives INSIDE the input box, keeping the footer directly below the input.
		// Native layout: [top border, text lines, bottom border, dropdown lines...].
		if ((this as unknown as { autocompleteState?: unknown }).autocompleteState) {
			const nativeLines = super.render(width);
			const prompt = this.prompt(width);
			const padding = this.paddingFor(width, style);
			const promptWidth = widthOf(prompt) + 1;
			const prefix = `${" ".repeat(padding)}${prompt} `;
			const continuation = " ".repeat(padding + promptWidth);
			const borderIndex = nativeLines.slice(1).findIndex((line) => isNativeBorderLine(line));
			const split = borderIndex >= 0 ? borderIndex + 1 : nativeLines.length;
			const body = nativeLines.slice(1, split);
			const dropdown = nativeLines.slice(split);
			const border = this.borderFor();
			const kind = this.frameKind(style);
			const renderWidth = width - (kind === "rounded" ? 2 : 0);
			const status = kind === "rounded" ? this.borderStatus(renderWidth, width) : undefined;
			const sideColor =
				kind === "rounded"
					? status && !this.isBashMode()
						? (glyph: string) => this.statusTheme.apply("separator", glyph)
						: this.borderColorFor()
					: undefined;
			const wrap = (line: string) =>
				kind === "rounded" && sideColor ? `${sideColor("│")}${line}${sideColor("│")}` : line;
			const bashHidden = this.bashHiddenCount();
			const renderedBody = body.map((line, index) => {
				const source = index === 0 && bashHidden > 0 ? stripLeadingVisibleChars(line, bashHidden) : line;
				return wrap(widthSafe(`${index === 0 ? prefix : continuation}${source}`, renderWidth));
			});
			// Pi draws the rule between the input and its suggestions in its own
			// border colour. Inside a frame that is deliberately quiet that rule is
			// the one bright line in the box, so it is repainted to match the chrome
			// around it rather than competing with the suggestions.
			const quietRule = (glyph: string) => this.statusTheme.apply("separator", glyph);
			const dropdownLines = dropdown.map((line) =>
				isNativeBorderLine(line)
					? wrap(quietRule("─".repeat(Math.max(0, renderWidth))))
					: wrap(widthSafe(line, renderWidth)),
			);
			if (kind === "rounded") {
				// The suggestion menu is content, not a different mode: omp only lets a
				// *standalone* status bar yield its row to the menu, and the box shape
				// keeps its status in the top border throughout
				// (status-line/component.ts — the autocomplete probe guards the bottom
				// bar only). Rebuilding a plain frame here dropped the status and grew
				// a bottom rule the shape does not have.
				const inner = Math.max(0, width - 2);
				const quiet = (glyph: string) => this.statusTheme.apply("separator", glyph);
				const top = status ? `${quiet("╭")}${status}${quiet("╮")}` : border(`╭${"─".repeat(inner)}╮`);
				const rows = [...renderedBody, ...dropdownLines];
				if (!status) return [top, ...rows, border(`╰${"─".repeat(inner)}╯`)];
				const closed = rows.map((line, index) =>
					index === rows.length - 1
						? `${quiet("╰")}${widthSafe(stripSideBorders(line), inner)}${quiet("╯")}`
						: line,
				);
				return [top, ...closed];
			}
			return [border("─".repeat(width)), ...renderedBody, ...dropdownLines, border("─".repeat(width))];
		}
		if (style === "native") return super.render(width).map((line) => widthSafe(line, width));

		const prompt = this.prompt(width);
		const promptWidth = widthOf(prompt) + 1;
		const padding = this.paddingFor(width, style);
		const kind = this.frameKind(style);
		const sideReserve = kind === "rounded" ? 2 : 0;
		const renderWidth = Math.max(1, width - sideReserve);
		const innerWidth = Math.max(1, renderWidth - promptWidth - padding * 2);
		const innerLines = super.render(innerWidth);
		if (innerLines.length === 0) return [];

		const body = innerLines.slice(1, -1);
		const prefix = `${" ".repeat(padding)}${prompt} `;
		const continuation = " ".repeat(padding + promptWidth);
		const hint = this.config.editor.hint;
		const showHint = hint !== "" && this.getText() === "";
		const bashHidden = this.bashHiddenCount();
		const renderedBody = body.map((line, index) => {
			const lead = index === 0 ? prefix : continuation;
			const source = index === 0 && bashHidden > 0 ? stripLeadingVisibleChars(line, bashHidden) : line;
			let content = `${lead}${source}`;
			// Empty-input hint: the cursor block (first cell of the native empty
			// line) stays at the input position, the dim hint trails it. The native
			// line is pre-padded to renderWidth with literal spaces; drop them from
			// the raw end (safe: no ANSI follows the padding) before appending the
			// hint, or the hint is truncated away by widthSafe. Typing any character
			// makes the text non-empty and the hint disappears.
			if (showHint && index === 0 && line) {
				let end = content.length;
				while (end > 0 && content[end - 1] === " ") end--;
				if (end < content.length) content = content.slice(0, end);
				content += this.semantic.apply("hint", hint);
			}
			return widthSafe(content, renderWidth);
		});
		const metadata = this.metadata(width, style);
		const framed = this.frame(width, style, renderedBody, metadata);
		return framed.map((line) => widthSafe(line, width));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.invalidate();
	}

	private prompt(width?: number): string {
		if (this.isBashMode()) {
			// Bash mode (`!` prefix): the prompt glyph becomes the bash icon and the
			// leading `!` is hidden from the input text. The glyph takes the live
			// border color (pi sets editor.borderColor to the bashMode color).
			const glyph = this.semantic.glyph("bashPrompt");
			return this.borderColor(glyph);
		}
		const configured = this.config.theme.glyphs.prompt;
		if (configured) return configured;
		// A frame carrying the status already marks where input begins, so omp's
		// box shape spends no cell on a prompt glyph
		// (tui/components/composer/box.ts — `defaultPromptGutter: undefined`).
		// Only its borderless/claude/rule shapes keep one.
		if (width !== undefined && editorHostsBorderStatusAt(this.config, width)) return "";
		return this.semantic.mode === "ascii" ? ">" : "❯";
	}

	/** Pi's bash mode: the input starts with `!` after optional whitespace. */
	private isBashMode(): boolean {
		return this.getText().trimStart().startsWith("!");
	}

	/**
	 * Number of leading `!` characters to hide from the displayed input while
	 * bash mode is active. Characters under the cursor are never hidden, so the
	 * native cursor block stays visible when the cursor sits on a `!`.
	 */
	private bashHiddenCount(): number {
		const text = this.getText();
		let index = 0;
		while (index < text.length && (text[index] === " " || text[index] === "\t")) index++;
		const runStart = index;
		while (index < text.length && text[index] === "!") index++;
		const run = index - runStart;
		if (run === 0) return 0;
		const cursor = this.getCursor();
		const position = cursor.line === 0 ? cursor.col : Number.POSITIVE_INFINITY;
		return Math.min(run, Math.max(0, position - runStart));
	}

	private styleFor(width: number): "compact" | "boxed" | "dock" | "native" {
		if (width < 20) return "native";
		if (["compact", "boxed", "dock", "native"].includes(this.config.editor.style)) {
			if (this.config.editor.style === "native") return "native";
			if (width < 40 && this.config.editor.style !== "compact") return "compact";
			return this.config.editor.style as "compact" | "boxed" | "dock";
		}
		return "compact";
	}

	/**
	 * Resolve the frame treatment for a style: horizontal bars for compact,
	 * full-width bars for boxed, an outlined box for dock, and a rounded box
	 * with side borders (`╭─╮ │ │ ╰─╯`) for `frame: "rounded"`.
	 */
	private frameKind(
		style: "compact" | "boxed" | "dock" | "native",
	): "compact" | "boxed" | "outline" | "rounded" | "claude" | "native" {
		const frame = this.config.editor.frame;
		if (style === "compact" || frame === "line" || frame === "solid") return "compact";
		if (style === "boxed") return "boxed";
		if (frame === "native") return "native";
		if (frame === "claude") return "claude";
		if (frame === "rounded") return "rounded";
		return "outline";
	}

	private paddingFor(width: number, style: "compact" | "boxed" | "dock" | "native"): number {
		if (width < 50) return 0;
		return style === "boxed" ? 2 : style === "dock" ? 1 : 1;
	}

	private borderFor(): (line: string) => string {
		return (line: string) => this.borderColorFor()(line);
	}

	/** Raw border color function (thinking-synced) WITHOUT full-width padding, for single glyphs. */
	/**
	 * Colour a named session's frame from its own name, so two windows on the same
	 * project are told apart at a glance. Drawn from the theme's own tokens rather
	 * than a free hue, so it can never land off-palette, and only for sessions the
	 * user actually named — an unnamed session keeps the thinking-level signal.
	 */
	private sessionAccentFor(): ((line: string) => string) | undefined {
		if (!this.config.theme.sessionAccent) return undefined;
		const name = this.snapshot.sessionName;
		if (!name) return undefined;
		let hash = 2166136261;
		for (const ch of name) {
			hash ^= ch.charCodeAt(0);
			hash = Math.imul(hash, 16777619) >>> 0;
		}
		const token = SESSION_ACCENT_TOKENS[hash % SESSION_ACCENT_TOKENS.length] ?? "accent";
		return (line: string) => this.statusTheme.apply(token, line);
	}

	/**
	 * Right-aligned label closing the frame: the figures behind the gauge the top
	 * border draws. Only shown when the border hosts the status, so a plain frame
	 * stays plain.
	 */
	private borderFooter(span: number, terminalWidth: number): string | undefined {
		if (!editorHostsBorderStatusAt(this.config, terminalWidth)) return undefined;
		const inner = span;
		const percent = contextPercent(this.snapshot.context ?? {});
		if (percent === undefined) return undefined;
		const theme = this.statusTheme;
		const window = this.snapshot.context?.windowTokens;
		const used = this.snapshot.context?.currentTokens;
		const label = `${theme.apply(contextGaugeToken(percent), `${Math.round(percent)}%`)}${
			window !== undefined && used !== undefined
				? ` ${theme.apply("separator", "·")} ${theme.apply("muted", `${formatTokenCount(used)}/${formatTokenCount(window)}`)}`
				: ""
		}`;
		const labelWidth = widthOf(label);
		const dashes = inner - labelWidth - 4;
		if (dashes < 4) return undefined;
		return `${theme.apply("separator", "─".repeat(dashes))} ${label} ${theme.apply("separator", "─")}`;
	}

	private borderColorFor(): (line: string) => string {
		// While bash mode is active pi keeps editor.borderColor set to the
		// bashMode color (its native updateEditorBorderColor path); prefer it over
		// the thinking-level color so the whole frame switches to the bash color.
		if (this.isBashMode()) return this.borderColor;
		const accent = this.sessionAccentFor();
		if (accent) return accent;
		const level = this.snapshot.thinkingLevel;
		const thinking = this.fullTheme?.getThinkingBorderColor?.(level ?? "off");
		return thinking ?? this.piTheme.borderColor;
	}

	/**
	 * Status line drawn into the rounded top border, omp-style: the left group sits
	 * after the corner, the right group before it, and the run between them becomes
	 * the context gauge (used portion tinted). Returns undefined when the border is
	 * too narrow to hold anything useful, so the caller keeps a plain rule.
	 */
	private borderStatus(span: number, terminalWidth: number): string | undefined {
		if (!editorHostsBorderStatusAt(this.config, terminalWidth)) return undefined;
		const inner = span;
		const theme = this.statusTheme;
		const result = renderStatus(this.config.statusLine.layout, this.snapshot, inner, {
			separator: resolveStatusSeparator(this.config.statusLine.separator, theme),
			segments: createBuiltinSegments(),
			theme,
			options: { context_bar: { disabled: true }, context_pct: { disabled: true } },
		});
		const left = result.left;
		const right = result.right;
		if (!left && !right) return undefined;

		const lead = left ? `${theme.apply("separator", "─")} ${left} ` : theme.apply("separator", "─");
		const tail = right ? ` ${right} ${theme.apply("separator", "─")}` : theme.apply("separator", "─");
		const gap = inner - widthOf(lead) - widthOf(tail);
		if (gap < 4) return undefined;

		const percent = contextPercent(this.snapshot.context ?? {});
		if (percent === undefined) return `${lead}${theme.apply("separator", "─".repeat(gap))}${tail}`;
		return `${lead}${this.contextGauge(gap, percent)}${tail}`;
	}

	/**
	 * The context gauge that spans the rest of the top border.
	 *
	 * Mirrors omp's `#buildContextGaugeFill` (status-line/component.ts): the used
	 * portion is filled, the reading rides at the fill boundary, the window size
	 * sits at the right end, and two ticks mark where compaction becomes
	 * relevant — `╎` where speculative compaction starts and `┃` where auto
	 * compaction fires. Labels and ticks are painted into the cells rather than
	 * inserted, so the bar's width never changes with its content.
	 */
	private contextGauge(gap: number, percent: number): string {
		const theme = this.statusTheme;
		const clamped = Math.max(0, Math.min(100, percent));
		const fillToken = contextGaugeToken(clamped);
		const window = this.snapshot.context?.windowTokens;

		// Reserve the window label at the right end, then scale the bar to what is
		// left so the fill and the ticks never run under it.
		const windowLabel = window === undefined ? "" : formatTokenCount(window);
		const reading = `${Math.round(clamped)}%`;
		const canLabel = gap >= reading.length + windowLabel.length + 4;
		const windowStart = canLabel && windowLabel ? gap - windowLabel.length - 1 : -1;
		const scale = windowStart >= 0 ? windowStart : gap;

		const used = Math.min(scale, Math.max(1, Math.round((clamped / 100) * scale)));
		const cellFor = (value: number) => Math.min(scale - 1, Math.max(0, Math.round((value / 100) * scale)));
		// Same tiers the status line reads context by, so bar and text agree.
		const thresholdIndex = scale >= 8 ? cellFor(CONTEXT_COMPACTION_PERCENT) : -1;
		let speculationIndex = scale >= 8 ? cellFor(CONTEXT_SPECULATION_PERCENT) : -1;
		if (speculationIndex === thresholdIndex) speculationIndex = -1;

		// Place the reading just past the fill, stepping aside from either tick.
		let readingStart = -1;
		if (canLabel) {
			const maxStart = scale - reading.length - 1;
			const preferred = Math.min(maxStart, Math.max(1, used));
			const clashes = (start: number) => {
				const end = start + reading.length;
				return (
					(thresholdIndex >= start && thresholdIndex < end) || (speculationIndex >= start && speculationIndex < end)
				);
			};
			for (let distance = 0; distance <= maxStart; distance++) {
				const left = preferred - distance;
				if (left >= 1 && !clashes(left)) {
					readingStart = left;
					break;
				}
				const right = preferred + distance;
				if (distance > 0 && right <= maxStart && !clashes(right)) {
					readingStart = right;
					break;
				}
			}
		}

		let out = "";
		type GaugeToken = ReturnType<typeof contextGaugeToken> | "separator" | "muted";
		for (let index = 0; index < gap; index++) {
			let token: GaugeToken = index < used ? fillToken : "separator";
			let glyph = "─";
			if (readingStart >= 0 && index >= readingStart && index < readingStart + reading.length) {
				token = fillToken;
				glyph = reading.charAt(index - readingStart);
			} else if (index === thresholdIndex) {
				token = fillToken;
				glyph = "┃";
			} else if (index === speculationIndex) {
				token = "muted";
				glyph = "╎";
			} else if (windowStart >= 0 && index >= windowStart && index < windowStart + windowLabel.length) {
				token = "muted";
				glyph = windowLabel.charAt(index - windowStart);
			}
			out += theme.apply(token, glyph);
		}
		return out;
	}

	private frame(
		width: number,
		style: "compact" | "boxed" | "dock" | "native",
		body: string[],
		metadata: string[],
	): string[] {
		const border = this.borderFor();
		const kind = this.frameKind(style);
		if (kind === "compact") {
			// Match Pi's native editor: a horizontal border above and below the input.
			return [border("─".repeat(width)), ...body, border("─".repeat(width)), ...metadata];
		}
		if (kind === "boxed") {
			const glyph = this.config.editor.frame === "halfblock" ? "▀" : "━";
			return [border(glyph.repeat(width)), ...body, border(glyph.repeat(width)), ...metadata];
		}
		if (kind === "claude") {
			// omp's Claude Code composer: two full-width rules and nothing else. The
			// rules carry the thinking level as colour, and the status lives on its own
			// row below them — deliberately not inside the rules.
			return [border("─".repeat(width)), ...body, border("─".repeat(width)), ...metadata];
		}
		if (kind === "native") return body;
		const inner = Math.max(0, width - 2);
		if (kind === "rounded") {
			// Rounded box with vertical side borders: `╭─╮ / │ text │ / ╰─╯`.
			// Body lines were rendered at width - 2; re-fit defensively, then wrap.
			// Side glyphs use the raw border color (no full-width padding, unlike border()).
			// When the frame hosts the status, the thinking level is already spelled out
			// inside it (`◒ high`), so tinting the frame as well only fights the
			// segments for attention. Bash mode still tints: that is a mode, not a level.
			const hosting = this.borderStatus(inner, width) !== undefined;
			const sideColor =
				hosting && !this.isBashMode()
					? (glyph: string) => this.statusTheme.apply("separator", glyph)
					: this.borderColorFor();
			const side = (line: string) => `${sideColor("│")}${widthSafe(line, inner)}${sideColor("│")}`;
			const status = this.borderStatus(inner, width);
			// A frame hosting the status is chrome: corners take the same quiet colour
			// as the rule so the segments inside are what carry colour.
			const quiet = (glyph: string) => this.statusTheme.apply("separator", glyph);
			const top = status ? `${quiet("╭")}${status}${quiet("╮")}` : border(`╭${"─".repeat(inner)}╮`);
			if (status) {
				// omp's box composer is two rows total: it merges the closing corners
				// into the last content row (`╰ text ╯`) rather than spending a whole
				// row on a rule, so the prompt sits directly under the status
				// (packages/tui/src/components/composer/box.ts — renderBottom returns
				// undefined). A separate bottom rule would also repeat the context
				// reading the gauge above already carries.
				const rows = body.length > 0 ? body : [""];
				const framed = rows.map((line, index) =>
					index === rows.length - 1
						? `${quiet("╰")}${widthSafe(line, inner)}${quiet("╯")}`
						: `${sideColor("│")}${widthSafe(line, inner)}${sideColor("│")}`,
				);
				return [top, ...framed, ...metadata];
			}
			const footer = this.borderFooter(inner, width);
			const bottom = footer ? `${quiet("╰")}${footer}${quiet("╯")}` : border(`╰${"─".repeat(inner)}╯`);
			return [top, ...body.map(side), bottom, ...metadata];
		}
		const outlineStatus = this.borderStatus(inner, width);
		const quietOutline = (glyph: string) => this.statusTheme.apply("separator", glyph);
		const outlineTop = outlineStatus
			? `${quietOutline("┌")}${outlineStatus}${quietOutline("┐")}`
			: border(`┌${"─".repeat(inner)}┐`);
		const outlineFooter = this.borderFooter(inner, width);
		const outlineBottom = outlineFooter
			? `${quietOutline("└")}${outlineFooter}${quietOutline("┘")}`
			: border(`└${"─".repeat(inner)}┘`);
		return [outlineTop, ...body, outlineBottom, ...metadata];
	}

	private metadata(width: number, style: "compact" | "boxed" | "dock" | "native"): string[] {
		if (!this.config.editor.showMetadata || width < 60) return [];
		const percent = contextPercent(this.snapshot.context ?? {});
		if (percent === undefined) return [];
		const label = `ctx ${Math.round(percent)}%`;
		return [this.piTheme.borderColor(` ${style === "boxed" ? "· " : ""}${label}`)];
	}
}

export function installEditor(options: {
	host: EditorHost;
	config: NormalizedPiOmpThemeConfig;
	generation: number;
	initialSnapshot: StatusSnapshot;
	isCurrent?: () => boolean;
}): EditorInstallation | undefined {
	if (!options.host.setEditorComponent) return undefined;
	const previous = options.host.getEditorComponent?.();
	if (previous && options.config.compatibility.preferExistingEditor) {
		return {
			generation: options.generation,
			installedFactory: previous,
			previousFactory: previous,
			preservedPrevious: true,
			update() {},
			configure() {},
			dispose() {},
		};
	}
	let config = options.config;
	let snapshot = options.initialSnapshot;
	let disposed = false;
	const components = new Set<StyledEditor>();
	const factory = ((tui: Tui, theme: PiEditorTheme, keybindings: Keybindings) => {
		const editor = new StyledEditor(tui, theme, keybindings, {
			config,
			snapshot,
			theme,
			...(options.host.theme ? { fullTheme: options.host.theme } : {}),
			onSnapshot: (next) => {
				if (!disposed && options.isCurrent?.() !== false) snapshot = next;
			},
		});
		components.add(editor);
		return editor;
	}) as EditorFactory;
	try {
		options.host.setEditorComponent(factory);
	} catch {
		options.host.notify?.("pi-omp-theme editor unavailable; keeping the native editor", "warning");
		return undefined;
	}
	return {
		generation: options.generation,
		installedFactory: factory,
		previousFactory: previous,
		preservedPrevious: false,
		update(next) {
			if (disposed || options.isCurrent?.() === false) return;
			snapshot = next;
			for (const component of components) component.update(next);
		},
		configure(next) {
			if (disposed || options.isCurrent?.() === false) return;
			config = next;
			for (const component of components) component.configure(next);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const component of components) component.dispose();
			components.clear();
			if (options.host.getEditorComponent?.() === factory) {
				options.host.setEditorComponent(previous);
			}
		},
	};
}
