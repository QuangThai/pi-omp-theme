import type { CommandApp, CommandHost } from "./command-service.js";
import { executePiOmpThemeCommand } from "./command-service.js";
import type { ConfigFilePort, ConfigStoragePaths } from "./config-storage.js";

export function runCommand(
	args: string,
	host: CommandHost,
	app: CommandApp,
	storage: { readonly port: ConfigFilePort; readonly paths: ConfigStoragePaths },
): Promise<void> {
	return executePiOmpThemeCommand(args, host, app, storage);
}
