import type { StatusSnapshot } from "../domain/status.js";

export interface UiSnapshot extends StatusSnapshot {
	readonly revision: number;
	readonly generation: number;
}

export function createSnapshot(generation: number, revision = 0, values: StatusSnapshot = {}): UiSnapshot {
	return Object.freeze({ generation, revision, ...values });
}

export function replaceSnapshot(current: UiSnapshot, generation: number, values: StatusSnapshot): UiSnapshot {
	if (current.generation !== generation) return current;
	return createSnapshot(generation, current.revision + 1, values);
}
