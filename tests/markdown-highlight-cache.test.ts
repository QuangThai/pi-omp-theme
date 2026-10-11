import assert from "node:assert/strict";
import { test } from "node:test";
import {
	markdownHighlightCacheSize,
	resetMarkdownHighlightCache,
	withCachedHighlight,
} from "../extension-src/omp-theme/features/messages/markdown-highlight-cache.js";

/**
 * A highlighter shaped like Pi's: `bash` is registered at startup, `text` and
 * `yaml` only once `loaded` flips (Pi loads the remaining grammars in the
 * background), and anything unregistered renders as plain code-block lines.
 */
function fakeHighlighter() {
	const state = { loaded: false, calls: 0 };
	const highlightCode = (code: string, lang?: string): string[] => {
		state.calls++;
		const registered = lang === "bash" || (state.loaded && (lang === "text" || lang === "yaml"));
		return code.split("\n").map((line) => (registered ? `<${lang}>${line}` : `<plain>${line}`));
	};
	const theme = withCachedHighlight({ highlightCode }) as { highlightCode: (code: string, lang?: string) => string[] };
	return { state, highlight: theme.highlightCode };
}

test("a block highlighted before its grammar loads is highlighted after it loads", () => {
	resetMarkdownHighlightCache();
	const { state, highlight } = fakeHighlighter();
	assert.deepEqual(highlight("a: 1", "yaml"), ["<plain>a: 1"]);
	assert.deepEqual(highlight("x", "text"), ["<plain>x"]);
	state.loaded = true;
	assert.deepEqual(highlight("a: 1", "yaml"), ["<yaml>a: 1"]);
	assert.deepEqual(highlight("x", "text"), ["<text>x"]);
});

test("highlighted blocks and blocks without a language are still served from the cache", () => {
	resetMarkdownHighlightCache();
	const { state, highlight } = fakeHighlighter();
	assert.deepEqual(highlight("echo hi\nls", "bash"), ["<bash>echo hi", "<bash>ls"]);
	assert.deepEqual(highlight("no language"), ["<plain>no language"]);
	const after = state.calls;
	for (let index = 0; index < 5; index++) {
		assert.deepEqual(highlight("echo hi\nls", "bash"), ["<bash>echo hi", "<bash>ls"]);
		assert.deepEqual(highlight("no language"), ["<plain>no language"]);
	}
	assert.equal(state.calls, after, "settled blocks must not be re-highlighted");
	assert.equal(markdownHighlightCacheSize(), 2);
});

test("a language that never loads keeps rendering as plain code-block text", () => {
	resetMarkdownHighlightCache();
	const { highlight } = fakeHighlighter();
	for (let index = 0; index < 3; index++) assert.deepEqual(highlight("x", "klingon"), ["<plain>x"]);
	assert.equal(markdownHighlightCacheSize(), 0);
});
