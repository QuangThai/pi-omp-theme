/**
 * Memoized syntax highlighting for Pi's markdown.
 *
 * Pi rebuilds a message's `Markdown` component on every streaming delta, and
 * `highlightCode` carries no cache of its own — so every already-finished code
 * block in a reply is re-tokenized on every delta, while only the trailing block
 * actually changed. Wrapping the markdown theme's highlighter turns that
 * O(blocks) cost per delta into O(1) for the settled ones.
 *
 * Measured on Pi 0.84.2 with a 24 KB code-heavy reply streamed in 20 deltas:
 * 6.33 ms → 1.45 ms per delta, byte-identical output.
 */

/** Entries retained. Matches omp's highlight cache; a reply rarely holds more. */
const MAX_ENTRIES = 256;

type Highlighter = (code: string, lang?: string) => string[];
interface MarkdownThemeLike {
	highlightCode?: Highlighter;
}

const cache = new Map<string, string[]>();

/**
 * Highlighted output depends on the active Pi theme, so the cache is dropped
 * whenever the theme identity changes rather than keyed on it — a session
 * switches theme far more rarely than it highlights.
 */
let cachedFor: unknown;

/** Drop every entry (theme switch, session end). */
export function resetMarkdownHighlightCache(): void {
	cache.clear();
	cachedFor = undefined;
}

function memoize(native: Highlighter, owner: unknown): Highlighter {
	return (code, lang) => {
		if (cachedFor !== owner) {
			cache.clear();
			cachedFor = owner;
		}
		const key = `${lang ?? ""}\u0000${code}`;
		const hit = cache.get(key);
		if (hit) {
			// Re-insert so the least recently used entry is the one evicted.
			cache.delete(key);
			cache.set(key, hit);
			return hit;
		}
		const value = native(code, lang);
		cache.set(key, value);
		if (cache.size > MAX_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return value;
	};
}

/**
 * Wrap the markdown theme Pi hands to its transcript components. Returns the
 * theme untouched when it carries no highlighter, so an unexpected shape degrades
 * to Pi's own behavior instead of breaking rendering.
 */
export function withCachedHighlight(theme: unknown): unknown {
	if (!theme || typeof theme !== "object") return theme;
	const candidate = theme as MarkdownThemeLike;
	const native = candidate.highlightCode;
	if (typeof native !== "function") return theme;
	return { ...candidate, highlightCode: memoize(native.bind(candidate), native) };
}

/** Entry count, for `/pi-omp-theme doctor`. */
export function markdownHighlightCacheSize(): number {
	return cache.size;
}
