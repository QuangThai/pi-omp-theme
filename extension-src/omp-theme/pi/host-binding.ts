import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

/**
 * Host binding: whether this extension's `@earendil-works/pi-coding-agent`
 * import is the very module instance the running Pi uses.
 *
 * Pi loads extensions through jiti, which tries a native `import()` for ESM
 * `.js`/`.mjs` entries before falling back to its transpiling loader — and only
 * the transpiling loader applies Pi's aliases that map `@earendil-works/*` to
 * the host's own modules. When a `.js` entry sits next to a resolvable
 * `node_modules/@earendil-works/pi-coding-agent` (a local checkout installed
 * with `pi install <dir>`), the native import succeeds and binds the extension
 * to a *second* copy of Pi: every prototype patch then lands on classes the TUI
 * never instantiates and silently does nothing. The shipped entry is `.ts` for
 * exactly this reason (jiti always transpiles `.ts`); this probe is the
 * guardrail that turns any recurrence into an explicit diagnostic instead of a
 * silent no-op.
 */
export type HostBindingStatus = "bound" | "foreign" | "unknown";

export interface HostBinding {
	readonly status: HostBindingStatus;
	/** Package root of the Pi process hosting this extension, when it could be located. */
	readonly hostPackage?: string;
	/** Package root this extension's own `@earendil-works/pi-coding-agent` import resolved to, when known. */
	readonly extensionPackage?: string;
	readonly reason: string;
}

const PI_PACKAGE_NAMES: ReadonlySet<string> = new Set([
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
]);

/** Walk upward from `start` to the nearest package.json that names a Pi coding-agent package. */
function findPiPackageRoot(start: string, readFile: (path: string) => string): string | undefined {
	let directory = start;
	for (;;) {
		try {
			const parsed = JSON.parse(readFile(join(directory, "package.json"))) as { name?: unknown };
			if (typeof parsed.name === "string" && PI_PACKAGE_NAMES.has(parsed.name)) return directory;
		} catch {
			// Not a package root (or unreadable); keep walking.
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/** Entry file of a Pi package root: `exports["."].import` first, then `main`. */
function piPackageEntry(root: string, readFile: (path: string) => string): string | undefined {
	try {
		const parsed = JSON.parse(readFile(join(root, "package.json"))) as {
			main?: unknown;
			exports?: Record<string, unknown> | string;
		};
		const dot = typeof parsed.exports === "object" && parsed.exports !== null ? parsed.exports["."] : undefined;
		const fromExports =
			typeof dot === "string"
				? dot
				: dot && typeof dot === "object"
					? ((dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default)
					: undefined;
		const entry = typeof fromExports === "string" ? fromExports : parsed.main;
		return typeof entry === "string" ? resolve(root, entry) : undefined;
	} catch {
		return undefined;
	}
}

export interface HostBindingProbeOptions {
	/** The script Node started with (`process.argv[1]`); undefined means "not a Node script". */
	argv1?: string | undefined;
	readFile?: (path: string) => string;
	/** Resolve this extension's own view of the Pi package entry (for diagnostics only). */
	resolveExtensionEntry?: () => string;
	/** Import a module by absolute path; returns its namespace. */
	importModule?: (path: string) => Promise<Record<string, unknown>>;
	/** The class this extension imported; compared by identity with the host's export. */
	extensionAssistantMessageComponent?: unknown;
}

export async function probeHostBinding(options: HostBindingProbeOptions = {}): Promise<HostBinding> {
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const importModule =
		options.importModule ??
		((path: string) => import(pathToFileURL(path).href) as Promise<Record<string, unknown>>);
	const ours = Object.hasOwn(options, "extensionAssistantMessageComponent")
		? options.extensionAssistantMessageComponent
		: AssistantMessageComponent;
	const extensionPackage = (() => {
		try {
			const entry =
				options.resolveExtensionEntry?.() ??
				fileURLToPath(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")));
			return findPiPackageRoot(dirname(entry), readFile);
		} catch {
			return undefined;
		}
	})();
	const withExtension = extensionPackage ? { extensionPackage } : {};
	const argv1 = Object.hasOwn(options, "argv1") ? options.argv1 : process.argv[1];
	if (typeof argv1 !== "string" || argv1.length === 0 || !isAbsolute(argv1)) {
		return { status: "unknown", ...withExtension, reason: "host entry script is not an absolute path" };
	}
	const hostPackage = findPiPackageRoot(dirname(resolve(argv1)), readFile);
	if (!hostPackage) {
		return { status: "unknown", ...withExtension, reason: "host entry script is not inside a Pi package" };
	}
	const hostEntry = piPackageEntry(hostPackage, readFile);
	if (!hostEntry) {
		return { status: "unknown", hostPackage, ...withExtension, reason: "host package declares no entry" };
	}
	let host: Record<string, unknown>;
	try {
		host = await importModule(hostEntry);
	} catch (error) {
		return {
			status: "unknown",
			hostPackage,
			...withExtension,
			reason: `host entry import failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const theirs = host.AssistantMessageComponent;
	if (typeof theirs !== "function" || typeof ours !== "function") {
		return { status: "unknown", hostPackage, ...withExtension, reason: "host entry exports no comparable surface" };
	}
	if (theirs === ours) {
		return { status: "bound", hostPackage, ...withExtension, reason: "extension shares the host's Pi modules" };
	}
	return {
		status: "foreign",
		hostPackage,
		...withExtension,
		reason: "extension imported a second copy of @earendil-works/pi-coding-agent; Pi never renders through it",
	};
}

/** One-line, actionable explanation for the session notice and the doctor. */
export function describeForeignHostBinding(binding: HostBinding): string {
	const where = binding.extensionPackage ? ` (${binding.extensionPackage})` : "";
	const host = binding.hostPackage ? ` while Pi runs ${binding.hostPackage}` : "";
	return (
		`pi-omp-theme is bound to a second copy of @earendil-works/pi-coding-agent${where}${host}; ` +
		"message/tool decorations stay native. Load the extension through Pi's loader " +
		"(the packaged .ts entry) or reinstall with `pi install npm:@nguyenquangthai/pi-omp-theme`."
	);
}
