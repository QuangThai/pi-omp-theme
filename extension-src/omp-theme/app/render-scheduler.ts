export type UpdateClass = "immediate" | "coalesced" | "deferred" | "delayed-retry";
export interface SchedulerHost {
	requestRender(): void;
}

export class RenderScheduler {
	private stopped = false;
	private immediateQueued = false;
	private coalescedTimer: ReturnType<typeof setTimeout> | undefined;
	private deferredTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly host: SchedulerHost,
		private readonly generation: number,
		private readonly isCurrent: (generation: number) => boolean = (current) => current === this.generation,
	) {}
	schedule(kind: UpdateClass): void {
		if (this.stopped || !this.isCurrent(this.generation)) return;
		if (kind === "immediate") {
			if (this.immediateQueued) return;
			this.immediateQueued = true;
			queueMicrotask(() => {
				this.immediateQueued = false;
				this.render();
			});
			return;
		}
		const target = kind === "coalesced" ? "coalescedTimer" : kind === "deferred" ? "deferredTimer" : "retryTimer";
		if (this[target] !== undefined) return;
		const delay = kind === "coalesced" ? 16 : kind === "deferred" ? 50 : 100;
		this[target] = setTimeout(() => {
			this[target] = undefined;
			this.render();
		}, delay);
	}
	private render(): void {
		if (!this.stopped && this.isCurrent(this.generation)) this.host.requestRender();
	}
	cancel(): void {
		this.stopped = true;
		if (this.coalescedTimer !== undefined) clearTimeout(this.coalescedTimer);
		if (this.deferredTimer !== undefined) clearTimeout(this.deferredTimer);
		if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
		this.coalescedTimer = undefined;
		this.deferredTimer = undefined;
		this.retryTimer = undefined;
	}
}
