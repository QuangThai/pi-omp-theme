import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";

/**
 * Session-start opt-in only. Pi cannot distinguish deliberately deactivated
 * tools from tools never activated, so the default must leave the set alone.
 * Opting out never removes tools owned by the user or another extension.
 */
export function activateReadOnlyTools(
	pi: ExtensionAPI,
	config: NormalizedPiOmpThemeConfig,
	ctx: ExtensionContext,
): void {
	if (!config.enabled) return;
	const flag = pi.getFlag("pi-omp-theme-readonly-tools");
	if (flag !== undefined && flag !== "true" && flag !== "false") {
		ctx.ui?.notify?.(
			"--pi-omp-theme-readonly-tools expects true or false; read-only tool activation disabled",
			"warning",
		);
		return;
	}
	if (!(flag === undefined ? config.readonlyTools : flag === "true")) return;
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = new Set(pi.getActiveTools());
	let changed = false;
	for (const name of ["grep", "find", "ls"] as const) {
		if (available.has(name) && !active.has(name)) {
			active.add(name);
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...active]);
}
