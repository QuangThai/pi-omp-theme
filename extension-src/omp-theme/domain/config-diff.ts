import type { NormalizedPiOmpThemeConfig } from "./config-types.js";

export type ConfigImpact = "none" | "status" | "editor" | "startup" | "compatibility" | "all";

export interface ConfigDiff {
	readonly changed: readonly string[];
	readonly impacts: readonly ConfigImpact[];
}

export function diffConfig(previous: NormalizedPiOmpThemeConfig, next: NormalizedPiOmpThemeConfig): ConfigDiff {
	const changed: string[] = [];
	const impacts = new Set<ConfigImpact>();
	const compare = (key: string, before: unknown, after: unknown, impact: ConfigImpact) => {
		if (JSON.stringify(before) === JSON.stringify(after)) return;
		changed.push(key);
		impacts.add(impact);
	};
	compare("enabled", previous.enabled, next.enabled, "all");
	compare("statusLine", previous.statusLine, next.statusLine, "status");
	compare("placement", previous.placement, next.placement, "status");
	compare("editor", previous.editor, next.editor, "editor");
	compare("startup", previous.startup, next.startup, "startup");
	compare("messages", previous.messages, next.messages, "compatibility");
	compare("tools", previous.tools, next.tools, "compatibility");
	compare("theme", previous.theme, next.theme, "all");
	compare("compatibility", previous.compatibility, next.compatibility, "compatibility");
	if (impacts.has("all"))
		return Object.freeze({ changed: Object.freeze(changed), impacts: Object.freeze(["all"] as const) });
	return Object.freeze({ changed: Object.freeze(changed), impacts: Object.freeze([...impacts]) });
}
