import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	configureWorkingShimmer,
	disposeWorkingShimmer,
	installWorkingIndicator,
	startWorkingShimmer,
	stopWorkingShimmer,
	type WorkingIndicatorHost,
} from "../extension-src/omp-theme/features/working-indicator/index.js";
import { stripAnsi } from "../extension-src/omp-theme/shared/ansi.js";

const palette = () => ({ low: "#555555", mid: "#888888", high: "#ffffff", bold: false });

afterEach(() => {
	disposeWorkingShimmer();
});

test("working row uses a public widget to put its marker at transcript column zero", () => {
	let factory:
		| ((tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[]; invalidate(): void })
		| undefined;
	const visibility: boolean[] = [];
	const host: WorkingIndicatorHost = {
		theme: { fg: (_color, text) => text },
		setWorkingIndicator() {},
		setWorkingMessage() {},
		setWorkingVisible(visible) {
			visibility.push(visible);
		},
		setWidget(_key, widget) {
			factory = widget;
		},
	};

	assert.equal(installWorkingIndicator(host), true);
	configureWorkingShimmer(host, "off", palette);
	startWorkingShimmer();
	assert.equal(visibility.at(-1), false);
	assert.ok(factory);

	let renders = 0;
	const component = factory({ requestRender: () => renders++ }, {});
	const lines = component.render(32);
	assert.equal(lines[0], "");
	assert.equal(stripAnsi(lines[1] ?? "").search(/\S/u), 0);
	assert.match(stripAnsi(lines[1] ?? ""), /Working\.\.\./u);
	assert.ok(renders >= 0);

	stopWorkingShimmer();
	assert.equal(factory, undefined);
	assert.equal(visibility.at(-1), true);
});

test("working shimmer retains Pi's native message path when widget ownership is unavailable", () => {
	const messages: Array<string | undefined> = [];
	const host: WorkingIndicatorHost = {
		setWorkingIndicator() {},
		setWorkingMessage(message) {
			messages.push(message);
		},
	};

	assert.equal(installWorkingIndicator(host, true), true);
	configureWorkingShimmer(host, "off", palette);
	startWorkingShimmer();
	assert.match(stripAnsi(messages.at(-1) ?? ""), /Working\.\.\./u);
	stopWorkingShimmer();
	assert.equal(messages.at(-1), undefined);
});
