export type CompatibilitySubtype =
	| "native-assistant-message"
	| "native-compaction-message"
	| "native-branch-message"
	| "native-skill-message"
	| "native-custom-message"
	| "tool-call-renderer"
	| "tool-result-renderer"
	| "native-bash-execution"
	| "native-markdown-theme";

type CompatibilityShape = "supported" | "unsupported" | "conflict" | "installed" | "skipped";

export interface CompatibilityRecord {
	feature: "messages" | "tools";
	subtype: CompatibilitySubtype;
	target: object;
	owner: object;
	method: PropertyKey;
	originalIdentity: unknown;
	originalDescriptor?: PropertyDescriptor;
	installedIdentity?: unknown;
	piVersion: string;
	compatibilityBasis: string;
	shape: CompatibilityShape;
	diagnostic?: string | undefined;
	generation: number;
	disposed: boolean;
	disposer: () => void;
}

export interface InstallResult {
	status: "installed" | "already-installed" | "skipped";
	record: CompatibilityRecord;
	reason?: string | undefined;
}

const recordsByOwner = new WeakMap<object, Map<PropertyKey, CompatibilityRecord>>();
let generation = 0;
let registryTestHooks: {
	afterWrite?: () => void;
	defineProperty?: (target: object, key: PropertyKey, descriptor: PropertyDescriptor) => boolean;
} = {};
export function __setCompatibilityRegistryTestHooks(hooks: typeof registryTestHooks): () => void {
	const previous = registryTestHooks;
	registryTestHooks = hooks;
	return () => {
		registryTestHooks = previous;
	};
}

function ownerRecords(owner: object): Map<PropertyKey, CompatibilityRecord> {
	let records = recordsByOwner.get(owner);
	if (!records) {
		records = new Map();
		recordsByOwner.set(owner, records);
	}
	return records;
}

export function currentGeneration(): number {
	return generation;
}
export function nextGeneration(): number {
	return ++generation;
}
export function getCompatibilityRecords(owner: object): readonly CompatibilityRecord[] {
	return [...(recordsByOwner.get(owner)?.values() ?? [])];
}

function safeRead(target: object, method: PropertyKey): unknown {
	try {
		return Reflect.get(target, method);
	} catch {
		return undefined;
	}
}

function skippedRecord(options: {
	feature: CompatibilityRecord["feature"];
	subtype: CompatibilitySubtype;
	target: object;
	method: PropertyKey;
	piVersion: string;
	compatibilityBasis: string;
	shape: CompatibilityShape;
	diagnostic: string;
	generation: number;
	originalIdentity?: unknown;
}): CompatibilityRecord {
	return {
		...options,
		owner: options.target,
		originalIdentity: Object.hasOwn(options, "originalIdentity")
			? options.originalIdentity
			: safeRead(options.target, options.method),
		disposed: true,
		disposer: () => {},
	};
}

function descriptorMatches(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
	if (!actual || !expected) return actual === expected;
	return (
		actual.value === expected.value &&
		actual.get === expected.get &&
		actual.set === expected.set &&
		actual.writable === expected.writable &&
		actual.enumerable === expected.enumerable &&
		actual.configurable === expected.configurable
	);
}

function restoreExact(record: CompatibilityRecord): { ok: boolean; diagnostic?: string } {
	try {
		const current = Object.getOwnPropertyDescriptor(record.target, record.method);
		const installed = current?.value === record.installedIdentity;
		if (!installed) return { ok: false, diagnostic: "current owner changed; native/later owner preserved" };
		const defineProperty = registryTestHooks.defineProperty ?? Reflect.defineProperty;
		const wrote = record.originalDescriptor
			? defineProperty(record.target, record.method, record.originalDescriptor)
			: Reflect.deleteProperty(record.target, record.method);
		if (!wrote) return { ok: false, diagnostic: "exact descriptor restoration was rejected" };
		if (!descriptorMatches(Object.getOwnPropertyDescriptor(record.target, record.method), record.originalDescriptor))
			return { ok: false, diagnostic: "post-restore descriptor validation failed" };
		return { ok: true };
	} catch (error) {
		return { ok: false, diagnostic: `restore failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function inspectCurrent(
	target: object,
	method: PropertyKey,
): { current?: unknown; descriptor?: PropertyDescriptor; error?: string } {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(target, method);
		return {
			current: descriptor && "value" in descriptor ? descriptor.value : undefined,
			...(descriptor ? { descriptor } : {}),
		};
	} catch (error) {
		return { error: `cannot inspect target: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function skippedResult(
	options: Parameters<typeof installDelegatingPatch>[0],
	shape: CompatibilityShape,
	reason: string,
	originalIdentity?: unknown,
): InstallResult {
	return {
		status: "skipped",
		reason,
		record: skippedRecord({ ...options, shape, diagnostic: reason, originalIdentity }),
	};
}

function expectedIdentityMatches(options: Parameters<typeof installDelegatingPatch>[0], current: unknown): boolean {
	const expected =
		options.hasExpectedIdentity === true ||
		(options.hasExpectedIdentity === undefined && options.expectedIdentity !== undefined);
	return !expected || current === options.expectedIdentity;
}

function validateInstall(
	options: Parameters<typeof installDelegatingPatch>[0],
	current: unknown,
	existing: CompatibilityRecord | undefined,
	ownDescriptor: PropertyDescriptor | undefined,
): InstallResult | undefined {
	if (!options.shape) return skippedResult(options, "unsupported", options.diagnostic ?? "unsupported shape", current);
	const conflict = existing && activeConflict(existing, current, options.generation);
	if (conflict) return conflict;
	if (options.kind === "add-method") {
		// Additive install: the slot must be unowned (the method is inherited); the
		// delegate receives the inherited native function as its fallback identity.
		if (current !== undefined || ownDescriptor !== undefined)
			return skippedResult(options, "conflict", "target already owns the additive method", current);
		return undefined;
	}
	if (typeof current !== "function")
		return skippedResult(
			options,
			ownDescriptor ? "unsupported" : "skipped",
			"target property is not callable",
			current,
		);
	if (!expectedIdentityMatches(options, current))
		return skippedResult(options, "conflict", "current owner is not the captured pristine native identity", current);
	return undefined;
}

function activeConflict(
	existing: CompatibilityRecord,
	current: unknown,
	generation: number,
): InstallResult | undefined {
	if (existing.disposed) return undefined;
	if (existing.installedIdentity === current && existing.generation === generation)
		return { status: "already-installed", record: existing };
	const reason =
		existing.installedIdentity === current
			? "active wrapper belongs to a different generation"
			: "owner changed after pi-omp-theme installation";
	return {
		status: "skipped",
		reason,
		record: skippedRecord({
			feature: existing.feature,
			subtype: existing.subtype,
			target: existing.target,
			method: existing.method,
			piVersion: existing.piVersion,
			compatibilityBasis: existing.compatibilityBasis,
			shape: "conflict",
			diagnostic: reason,
			generation,
			originalIdentity: current,
		}),
	};
}

export function installDelegatingPatch(options: {
	feature: CompatibilityRecord["feature"];
	subtype: CompatibilitySubtype;
	target: object;
	method: PropertyKey;
	piVersion: string;
	compatibilityBasis: string;
	shape: boolean;
	generation: number;
	expectedIdentity?: unknown;
	hasExpectedIdentity?: boolean;
	diagnostic?: string | undefined;
	/** "add-method" installs a new own method on the prototype (nothing may already own the slot); the delegate receives the inherited native function as the fallback. */
	kind?: "method" | "add-method";
	delegate: (original: unknown, thisArg: object, args: unknown[]) => unknown;
}): InstallResult {
	const { target, method } = options;
	const inspection = inspectCurrent(target, method);
	if (inspection.error) return skippedResult(options, "skipped", inspection.error);
	const current = inspection.current;
	const records = ownerRecords(target);
	const validation = validateInstall(options, current, records.get(method), inspection.descriptor);
	if (validation) return validation;
	const originalDescriptor = Object.getOwnPropertyDescriptor(target, method);
	// Additive installs have no current owner; the captured inherited native
	// function (expectedIdentity) is both the fallback and the delegate's original.
	const originalIdentity = options.kind === "add-method" ? options.expectedIdentity : current;
	let active = true;
	const installed = function (this: object, ...args: unknown[]): unknown {
		if (!active) return Reflect.apply(originalIdentity as (...values: unknown[]) => unknown, this, args);
		return options.delegate(originalIdentity, this, args);
	};
	const record: CompatibilityRecord = {
		feature: options.feature,
		subtype: options.subtype,
		target,
		owner: target,
		method,
		originalIdentity,
		...(originalDescriptor ? { originalDescriptor } : {}),
		installedIdentity: installed,
		piVersion: options.piVersion,
		compatibilityBasis: options.compatibilityBasis,
		shape: "installed",
		diagnostic: options.diagnostic,
		generation: options.generation,
		disposed: false,
		disposer: () => {},
	};
	try {
		Object.defineProperty(installed, "__piOmpThemeCompatibilityRecord", { value: record, configurable: false });
		// Additive installs have no original descriptor; write a fresh writable,
		// configurable, non-enumerable own method so the slot stays reversible.
		const descriptor = originalDescriptor
			? { ...originalDescriptor, value: installed }
			: { value: installed, writable: true, enumerable: false, configurable: true };
		const wrote = Reflect.defineProperty(target, method, descriptor);
		registryTestHooks.afterWrite?.();
		const currentDescriptor = Object.getOwnPropertyDescriptor(target, method);
		if (!wrote) return skippedResult(options, "skipped", "installation write was rejected");
		if (!descriptorMatches(currentDescriptor, descriptor)) {
			if (currentDescriptor?.value === installed) {
				const rollback = restoreExact({ ...record, installedIdentity: installed });
				if (!rollback.ok) {
					record.diagnostic = rollback.diagnostic;
					records.set(method, record);
					return { status: "skipped", reason: rollback.diagnostic, record };
				}
			}
			const reason =
				currentDescriptor?.value === installed
					? "wrapper-owned descriptor mismatch rolled back"
					: "later owner preserved after post-write mismatch";
			return {
				status: "skipped",
				reason,
				record: skippedRecord({
					...options,
					shape: "conflict",
					diagnostic: reason,
					originalIdentity: currentDescriptor?.value,
				}),
			};
		}
		records.set(method, record);
		record.disposer = () => {
			if (record.disposed) return;
			const restored = restoreExact(record);
			if (!restored.ok) {
				record.diagnostic = restored.diagnostic;
				return;
			}
			active = false;
			record.disposed = true;
			records.delete(method);
		};
		return { status: "installed", record };
	} catch (error) {
		const currentDescriptor = Object.getOwnPropertyDescriptor(target, method);
		const rollback =
			currentDescriptor?.value === installed ? restoreExact({ ...record, installedIdentity: installed }) : { ok: true };
		const reason = `installation rolled back (${rollback.diagnostic ?? "ok"}): ${error instanceof Error ? error.message : String(error)}`;
		if (currentDescriptor?.value === installed && !rollback.ok) {
			record.diagnostic = reason;
			records.set(method, record);
			record.disposer = () => {
				if (record.disposed) return;
				const retry = restoreExact(record);
				if (!retry.ok) {
					record.diagnostic = retry.diagnostic;
					return;
				}
				active = false;
				record.disposed = true;
				records.delete(method);
			};
			return { status: "installed", reason, record };
		}
		return { status: "skipped", reason, record: skippedRecord({ ...options, shape: "skipped", diagnostic: reason }) };
	}
}
