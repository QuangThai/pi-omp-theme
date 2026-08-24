import type { ConfigFilePort } from "../app/config-storage.js";
import { readScopedConfig } from "../app/config-storage.js";
import type { ConfigDiagnostic } from "../domain/config-diagnostics.js";
import { resolveConfigDetailed } from "../domain/config-normalization.js";

export interface SessionFlagReader {
	getFlag(name: string): unknown;
}
export interface SessionAuthorization {
	core: boolean;
	assistant: boolean;
	specialBlocks: boolean;
	tools: boolean;
	ascii: boolean;
}
export interface ProductPolicy {
	readonly corePatchGate: "omitted" | "allow" | "deny";
}
export interface ConfigSourceAdapter {
	setSession(cwd: string, trusted: boolean): void;
	/**
	 * Start reading the *global* configuration before the session is known.
	 *
	 * Pi paints its native frame as soon as its TUI starts and only then emits
	 * `session_start`; every await on that path is time the user watches the
	 * native chrome instead of the theme. Warming the read removes it from that
	 * path. Only the global file is read: the project file is gated on
	 * `isProjectTrusted()`, which is not known yet, and an untrusted project's
	 * settings must not be read at all — not even to be discarded.
	 */
	warm(): void;
	load(): Promise<{
		config: unknown;
		diagnostics: readonly ConfigDiagnostic[];
		sources: Readonly<Record<string, string>>;
		rawSources?: {
			defaults?: unknown;
			global?: unknown;
			project?: unknown;
			environment?: Record<string, string | undefined>;
		};
		productPolicy?: ProductPolicy;
	}>;
}

function sessionOverrides(_pi: SessionFlagReader): Record<string, unknown> {
	return {};
}

/** Product policy is deny-only: any explicit false wins; true never grants Tier C. */
export function resolveProductGate(
	global: unknown,
	project: unknown,
	session: unknown,
	projectTrusted: boolean,
): ProductPolicy {
	const values = [global, projectTrusted ? project : undefined, session];
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const compatibility = (value as Record<string, unknown>).compatibility;
		if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)) continue;
		if (!Object.hasOwn(compatibility, "allowCorePatches")) continue;
		const leaf = (compatibility as Record<string, unknown>).allowCorePatches;
		if (leaf === false) return { corePatchGate: "deny" };
	}
	return { corePatchGate: "omitted" };
}

export function readSessionAuthorization(pi: SessionFlagReader): SessionAuthorization {
	return {
		core: pi.getFlag("pi-omp-theme-core-patches") === true,
		assistant: pi.getFlag("pi-omp-theme-message-assistant") === true,
		specialBlocks: pi.getFlag("pi-omp-theme-message-special-blocks") === true,
		tools: pi.getFlag("pi-omp-theme-tools") === true,
		ascii: pi.getFlag("pi-omp-theme-ascii") === true,
	};
}

export function createConfigSourceAdapter(
	pi: SessionFlagReader,
	port: ConfigFilePort,
	paths: (cwd: string) => { globalPath: string; projectPath: string },
): ConfigSourceAdapter {
	let trusted = true;
	let currentCwd = process.cwd();
	type ScopedRead = Awaited<ReturnType<typeof readScopedConfig>>;
	let warmed: { path: string; read: Promise<ScopedRead | undefined> } | undefined;
	return {
		setSession(nextCwd, nextTrusted) {
			currentCwd = nextCwd;
			trusted = nextTrusted;
		},
		warm() {
			const { globalPath } = paths(currentCwd);
			if (warmed?.path === globalPath) return;
			// Failure is not handled here: load() falls back to a fresh read, which
			// produces the diagnostics the doctor reports.
			warmed = { path: globalPath, read: readScopedConfig(port, globalPath).catch(() => undefined) };
		},
		async load() {
			// Capture the session boundary before awaiting the warmed read. A later
			// setSession() must not change which project's file this load is allowed
			// to read or which trust value reaches config resolution.
			const loadCwd = currentCwd;
			const loadTrusted = trusted;
			const storage = paths(loadCwd);
			// A warmed read counts only for the path it was started for; a session
			// that moved cwd re-reads.
			const warmedRead = warmed?.path === storage.globalPath ? warmed.read : undefined;
			warmed = undefined;
			const global = (await warmedRead) ?? (await readScopedConfig(port, storage.globalPath));
			const project = loadTrusted ? await readScopedConfig(port, storage.projectPath) : undefined;
			const resolved = resolveConfigDetailed({
				global: global.value,
				project: project?.value,
				projectTrusted: loadTrusted,
				environment: process.env,
				session: sessionOverrides(pi),
			});
			const productPolicy = resolveProductGate(global.value, project?.value, sessionOverrides(pi), loadTrusted);
			return {
				config: resolved.config,
				diagnostics: [...global.diagnostics, ...(project?.diagnostics ?? []), ...resolved.diagnostics],
				sources: resolved.sources,
				rawSources: { global: global.value, project: project?.value, environment: process.env },
				productPolicy,
			};
		},
	};
}

export { sessionOverrides };
