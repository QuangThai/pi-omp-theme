export interface Disposable {
	dispose(): void | Promise<void>;
}

export class DisposableStore implements Disposable {
	private readonly items: Disposable[] = [];
	private disposed = false;
	add<T extends Disposable>(item: T): T {
		if (this.disposed) {
			void item.dispose();
			return item;
		}
		this.items.push(item);
		return item;
	}
	addCallback(callback: () => void | Promise<void>): void {
		this.add({ dispose: callback });
	}
	get size(): number {
		return this.items.length;
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (let i = this.items.length - 1; i >= 0; i--) await this.items[i]?.dispose();
		this.items.length = 0;
	}
}
