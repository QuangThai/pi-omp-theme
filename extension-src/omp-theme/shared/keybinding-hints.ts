import type { AppKeybinding } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

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
