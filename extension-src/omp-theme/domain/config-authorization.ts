import type { NormalizedPiOmpThemeConfig } from "./config-types.js";

export interface TierCAuthorizationInput {
	readonly coreFlag: boolean;
	readonly surfaceFlag: boolean;
	readonly surface: "messages" | "tools" | "assistantMessage" | "specialBlocks";
	readonly config: NormalizedPiOmpThemeConfig;
}

/**
 * Tier C surface authorization is session-bound to the core/surface flags and
 * normalized config; runtime compatibility is decided per-surface by the probe's
 * identity (fingerprint) check, never by a hard-pinned Pi version.
 */
export function isTierCAuthorized(input: TierCAuthorizationInput): boolean {
	if (!input.coreFlag || !input.surfaceFlag || !input.config.enabled) return false;
	if (input.surface === "tools") return input.config.tools.enabled;
	if (input.surface === "assistantMessage")
		return input.config.messages.enabled && input.config.messages.assistantPrefix;
	if (input.surface === "specialBlocks") return input.config.messages.enabled && input.config.messages.specialBlocks;
	return input.config.messages.enabled;
}
