import assert from "node:assert/strict";
import { test } from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { normalizeConfig, validateConfigLayer } from "../extension-src/omp-theme/domain/config-normalization.js";
import { filterExtensionWidget } from "../extension-src/omp-theme/features/widgets/index.js";
import { disposePiCompatibilityProbe, probePiCompatibility } from "../extension-src/omp-theme/pi/compatibility-probe.js";

/** Pi types the method private; the patch replaces it on the prototype. */
const nativeSetWidget = () =>
	(InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => void>).setExtensionWidget;

const MESSAGES_OFF = {
	enabled: false,
	assistantPrefix: false,
	specialBlocks: false,
	hideThinkingLabel: false,
	hideInterimText: false,
};
const TOOLS_OFF = { enabled: false, style: "compact-box", maxCollapsedLines: 4, maxExpandedLines: 50, dimOutput: false };

function recorder() {
	const calls: unknown[][] = [];
	const original = function setExtensionWidget(this: unknown, ...args: unknown[]) {
		calls.push(args);
		return "native";
	};
	return { calls, original };
}

test("widgets.hide defaults to nothing and keeps trimmed, distinct keys", () => {
	assert.deepEqual(normalizeConfig({}).widgets.hide, []);
	assert.deepEqual(normalizeConfig({ widgets: { hide: [" pi-todo ", "pi-todo", "", "other"] } }).widgets.hide, [
		"pi-todo",
		"other",
	]);
	assert.deepEqual(normalizeConfig({ widgets: { hide: "pi-todo" } }).widgets.hide, []);
});

test("widgets.hide validates as a string list", () => {
	assert.deepEqual(validateConfigLayer({ widgets: { hide: ["pi-todo"] } }).diagnostics, []);
	assert.ok(validateConfigLayer({ widgets: { hide: [1] } }).diagnostics.length > 0);
});

test("a hidden widget key never reaches Pi; other keys and clears pass through", () => {
	const { calls, original } = recorder();
	const hidden = new Set(["pi-todo"]);
	const factory = () => ({ render: () => ["plan"], invalidate() {} });
	filterExtensionWidget(original, {}, ["pi-todo", factory, { placement: "aboveEditor" }], hidden);
	filterExtensionWidget(original, {}, ["pi-todo", undefined], hidden);
	filterExtensionWidget(original, {}, ["other", factory], hidden);
	assert.deepEqual(calls[0], ["pi-todo", undefined]);
	assert.deepEqual(calls[1], ["pi-todo", undefined]);
	assert.equal(calls[2]?.[0], "other");
	assert.equal(calls[2]?.[1], factory);
});

test("the widget filter installs on InteractiveMode only when keys are hidden", () => {
	const native = nativeSetWidget();
	const off = probePiCompatibility("99.99.99", {
		config: { messages: MESSAGES_OFF, tools: TOOLS_OFF, widgets: { hide: [] }, preset: "claude" },
	});
	try {
		assert.equal(nativeSetWidget(), native);
		assert.ok(off.unsupported.some((item) => item.method === "setExtensionWidget" && item.cause === "disabled"));
	} finally {
		assert.equal(disposePiCompatibilityProbe(off).complete, true);
	}

	const on = probePiCompatibility("99.99.99", {
		config: { messages: MESSAGES_OFF, tools: TOOLS_OFF, widgets: { hide: ["pi-todo"] }, preset: "claude" },
	});
	try {
		assert.notEqual(nativeSetWidget(), native);
		assert.ok(
			on.recordSnapshots.some((record) => record.subtype === "native-extension-widget" && !record.disposed),
			"the widget surface is installed",
		);
		// The fields the native method touches; string-array content needs no TUI.
		const host = { extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(), renderWidgets() {}, ui: {} };
		const setWidget = nativeSetWidget();
		assert.ok(setWidget);
		Reflect.apply(setWidget, host, ["pi-todo", ["[ ] plan"], { placement: "aboveEditor" }]);
		Reflect.apply(setWidget, host, ["status", ["kept"], { placement: "aboveEditor" }]);
		assert.deepEqual([...host.extensionWidgetsAbove.keys()], ["status"]);
	} finally {
		assert.equal(disposePiCompatibilityProbe(on).complete, true);
	}
	assert.equal(nativeSetWidget(), native);
});
