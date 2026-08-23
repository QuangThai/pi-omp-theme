import type { RuntimeInstallationState } from "../app/runtime.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";
import type { CompatibilityCoordinator } from "./compatibility-coordinator.js";

export function buildOperationalState(
	config: NormalizedPiOmpThemeConfig,
	authorization: { core: boolean; productCorePatchGate?: string },
	compatibility: CompatibilityCoordinator,
	installationState?: RuntimeInstallationState,
	productCorePatchGate?: string,
): Readonly<Record<string, unknown>> {
	return {
		compatibility: {
			...compatibility.state(config),
			configuredByProduct: config.messages.enabled || config.tools.enabled,
		},
		installations: installationState ?? {
			status: config.enabled && config.statusLine.enabled ? "active" : "disabled",
			editor: config.enabled && config.editor.enabled ? "active" : "disabled",
			startup: config.enabled && config.startup.mode !== "off" ? "active" : "disabled",
		},
		provider: { status: "unavailable", recovery: "inject a capability-safe provider" },
		authorization: {
			core: authorization.core,
			...(authorization.productCorePatchGate ? { productCorePatchGate: authorization.productCorePatchGate } : {}),
			...(productCorePatchGate ? { productCorePatchGate } : {}),
		},
	};
}
