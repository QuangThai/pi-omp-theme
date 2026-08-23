import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConfigFilePort, ConfigStoragePaths } from "../app/config-storage.js";

const locks = new Map<string, Promise<void>>();

function serialize(path: string, operation: () => Promise<void>): Promise<void> {
	const previous = locks.get(path) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	locks.set(path, current);
	return current.finally(() => {
		if (locks.get(path) === current) locks.delete(path);
	});
}

export interface ConfigHostFs {
	readonly mkdir?: typeof mkdir;
	readonly readFile?: typeof readFile;
	readonly rename?: typeof rename;
	readonly unlink?: typeof unlink;
	readonly writeFile?: typeof writeFile;
}

export function createPiConfigFilePort(fs: ConfigHostFs = {}): ConfigFilePort {
	const fsMkdir = fs.mkdir ?? mkdir;
	const fsReadFile = fs.readFile ?? readFile;
	const fsRename = fs.rename ?? rename;
	const fsUnlink = fs.unlink ?? unlink;
	const fsWriteFile = fs.writeFile ?? writeFile;
	return {
		read: (path) => fsReadFile(path, "utf8"),
		writeAtomic: async (path, content) =>
			serialize(path, async () => {
				await fsMkdir(dirname(path), { recursive: true });
				const temporary = `${path}.pi-omp-theme-${process.pid}-${Date.now()}.tmp`;
				try {
					await fsWriteFile(temporary, content, { mode: 0o600 });
					await fsRename(temporary, path);
				} finally {
					await fsUnlink(temporary).catch(() => undefined);
				}
			}),
	};
}

export function defaultStoragePaths(cwd: string, overrides: Partial<ConfigStoragePaths> = {}): ConfigStoragePaths {
	return {
		globalPath: overrides.globalPath ?? join(getAgentDir(), "settings.json"),
		projectPath: overrides.projectPath ?? join(cwd, CONFIG_DIR_NAME, "settings.json"),
	};
}
