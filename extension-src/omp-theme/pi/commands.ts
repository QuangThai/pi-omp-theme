import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandApp } from "../app/command-service.js";
import { runCommand } from "../app/commands.js";
import { createPiConfigFilePort, defaultStoragePaths } from "./config-host.js";

export function registerPiOmpThemeCommand(pi: ExtensionAPI, app: CommandApp): void {
	pi.registerCommand("pi-omp-theme", {
		description: "Configure pi-omp-theme for this session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cwd = ctx.cwd ?? process.cwd();
			await runCommand(args, { ui: ctx.ui, cwd, isProjectTrusted: ctx.isProjectTrusted }, app, {
				port: createPiConfigFilePort(),
				paths: defaultStoragePaths(cwd),
			});
		},
	});
}
