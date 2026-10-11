import type { AppKeybinding } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.js";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";

/**
 * Convert Pi's canonical key notation into human-facing display text.
 *
 * Pi keeps its title-cased formatter internal. Mirror that small presentation
 * rule here, in one compatibility shim, until an equivalent public API exists.
 */
export function formatKeyDisplayText(text: string, platform: NodeJS.Platform = process.platform): string {
	return text
		.split("/")
		.map((key) =>
			key
				.split("+")
				.map((part) => {
					const displayPart = platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
					return displayPart ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
				})
				.join("+"),
		)
		.join("/");
}

/** Resolve an app action to its configured, human-facing key label. */
export function displayKeyText(keybinding: AppKeybinding): string {
	try {
		return formatKeyDisplayText(getKeybindings().getKeys(keybinding).join("/"));
	} catch {
		// A missing/foreign host registry is safer without a shortcut hint than
		// with a hard-coded binding that may be wrong.
		return "";
	}
}

/** Resolve a configured action and append concise instructional copy. */
export function displayKeyHint(keybinding: AppKeybinding, description: string): string {
	const key = displayKeyText(keybinding);
	return key ? `${key} ${description}` : "";
}

/** Full expansion instruction for normal-width message and tool surfaces. */
export function toolExpandHint(): string {
	return displayKeyHint("app.tools.expand", "to expand");
}

/** Compact expansion affordance for width-constrained inline previews. */
export function toolExpandKeyText(): string {
	return displayKeyText("app.tools.expand");
}

const SGR_TAIL = /\x1b\[[0-9;]*m$/;
const SGR_ALL = /\x1b\[[0-9;]*m/g;
const FULL_RESET = /^\x1b\[0?m$/;

/** Index where the run of separator columns (spaces, `·`) and SGR codes ending `text` begins. */
function separatorStart(text: string): number {
	let index = text.length;
	while (index > 0) {
		const sgr = SGR_TAIL.exec(text.slice(0, index));
		if (sgr) {
			index -= sgr[0].length;
			continue;
		}
		const char = text[index - 1];
		if (char !== " " && char !== "·") break;
		index--;
	}
	return index;
}

/** SGR codes in effect at the end of `text`, replayed in order since the last full reset. */
function activeSgr(text: string): string {
	const codes = text.match(SGR_ALL) ?? [];
	let reset = codes.length - 1;
	while (reset >= 0 && !FULL_RESET.test(codes[reset] ?? "")) reset--;
	return codes.slice(reset + 1).join("");
}

/** `text` with its last full expand hint swapped for the bare key (`Ctrl+O`). */
export function compactExpandHint(text: string): string {
	const hint = toolExpandHint();
	const key = toolExpandKeyText();
	const at = hint && key ? text.lastIndexOf(hint) : -1;
	return at < 0 ? text : `${text.slice(0, at)}${key}${text.slice(at + hint.length)}`;
}

/**
 * Fit a row that ends with the expand hint into `width` columns without
 * cutting the hint off: the hint shrinks to its bare key (`Ctrl+O`) first,
 * then the text in front of it gives way. Rows that already fit, or carry no
 * trailing hint, come back unchanged for the caller to truncate as usual.
 */
export function fitExpandHint(row: string, width: number, ellipsis = "…"): string {
	const max = Math.floor(width);
	if (max <= 0 || safeVisibleWidth(row) <= max) return row;
	const hint = toolExpandHint();
	const key = toolExpandKeyText();
	const at = hint ? row.lastIndexOf(hint) : -1;
	if (at < 0 || !key) return row;
	const after = row.slice(at + hint.length);
	if (stripAnsi(after).trim() !== "") return row;
	const compact = compactExpandHint(row);
	if (safeVisibleWidth(compact) <= max) return compact;
	const before = row.slice(0, at);
	const cut = separatorStart(before);
	const head = before.slice(0, cut);
	if (stripAnsi(head).trim() === "") return row;
	const separator = before.slice(cut);
	const room = max - safeVisibleWidth(separator) - safeVisibleWidth(key);
	if (room < 1) return row;
	return `${safeTruncateToWidth(head, room, ellipsis)}${activeSgr(head)}${separator}${key}${after}`;
}
