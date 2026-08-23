// Simple bash command shape detection, shared by the bash tool renderer and
// the git/gh semantic classifiers.
//
// A command is "simple" when pi-omp-theme can reason about it purely from its
// token list: single line, no shell metacharacters (pipes, redirects,
// substitutions), and no `&&`/`;`/`&` outside a leading `cd X &&` chain.
// Anything ambiguous returns null so the boxed command/response shell stays
// the fallback (ADR 0005 — no approximate rendering).

/** Tokens of a classifiable command after env/prefix/cd-chain stripping. */
export interface SimpleBashCommandShape {
	/** Tokens after leading env assignments, prefix commands, and `cd X &&` chains. */
	readonly tokens: string[];
	/** Last directory from a leading `cd <dir> &&` / `cd <dir>;` chain. */
	readonly cdDir?: string;
}

const BASH_PREFIX_COMMANDS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "stdbuf", "ionice", "watch"]);
// Pipes (`|`), `;`, and `&` are excluded here: the classifier validates them
// explicitly (allowing `cd X && cmd` chains and a trailing `| head/tail`).
const BASH_SHELL_META_CHARS = new Set(["<", ">", "(", ")", "`"]);

/** Tokenize a single command line, stripping quotes. Returns null on an
 *  unterminated quote. `hasMeta` is true if any shell metacharacter appears
 *  *outside* quotes (so `grep 'a|b' f` stays classifiable). */
function tokenizeCommandLine(line: string): { tokens: string[]; hasMeta: boolean } | null {
	const tokens: string[] = [];
	let current = "";
	let inToken = false;
	let quote: string | null = null;
	let hasMeta = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i] ?? "";
		if (quote) {
			if (char === "\\" && quote === '"') {
				current += line[++i] ?? "";
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			inToken = true;
			continue;
		}
		if (char === " " || char === "\t") {
			if (inToken) {
				tokens.push(current);
				current = "";
				inToken = false;
			}
			continue;
		}
		if (BASH_SHELL_META_CHARS.has(char) || (char === "$" && (line[i + 1] ?? "") === "(")) {
			hasMeta = true;
			continue;
		}
		current += char;
		inToken = true;
	}
	if (quote) return null;
	if (inToken) tokens.push(current);
	return { tokens, hasMeta };
}

/** `head [-n N]` / `tail [-n N]` truncation pipe tail (allowed at the end). */
function isHeadOrTailTail(tokens: readonly string[]): boolean {
	if (tokens.length === 0 || (tokens[0] !== "head" && tokens[0] !== "tail")) return false;
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "-n") continue;
		if (/^\d+$/.test(token)) continue;
		if (/^-\d+$/.test(token)) continue;
		return false;
	}
	return true;
}

/**
 * Tokenize a single-line bash command and verify it is simple enough to
 * classify: no shell metacharacters (`<`, `>`, `(`, `)`, backtick, `$(`), no
 * `&&`/`;`/`&` outside a leading `cd X &&` chain, and — unless
 * `allowTrailingTruncationPipe` — no pipes at all. Returns null for anything
 * ambiguous so callers fall back to the boxed shell. Newlines and unterminated
 * quotes are rejected.
 */
export function parseSimpleBashCommand(
	command: string,
	options: { allowTrailingTruncationPipe?: boolean } = {},
): SimpleBashCommandShape | null {
	const commandText = String(command ?? "").trim();
	if (!commandText || commandText.includes("\n")) return null;
	const tokenized = tokenizeCommandLine(commandText);
	if (!tokenized || tokenized.hasMeta || tokenized.tokens.length === 0) return null;
	let tokens = tokenized.tokens;

	if (options.allowTrailingTruncationPipe) {
		// Allow a single trailing truncation pipe: `cmd | head [-n] N` / `| tail …`.
		const pipes = tokens.flatMap((token, i) => (token === "|" ? [i] : []));
		if (pipes.length > 0) {
			if (pipes.length > 1) return null;
			const last = pipes[0] ?? -1;
			if (!isHeadOrTailTail(tokens.slice(last + 1))) return null;
			tokens = tokens.slice(0, last);
		}
	} else if (tokens.includes("|")) {
		// git/gh classification keeps the pipe rule strict (ADR 0005): any pipe
		// falls back to the raw boxed shell.
		return null;
	}

	let index = 0;
	// Skip leading environment assignments (FOO=bar ...) and prefix commands.
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
	while (index < tokens.length && BASH_PREFIX_COMMANDS.has(tokens[index] ?? "")) index++;
	// `cd <dir> &&` / `cd <dir>;` chains: the last directory becomes the default
	// path when the command itself carries none.
	let cdDir: string | undefined;
	while (
		tokens[index] === "cd" &&
		index + 2 < tokens.length &&
		tokens[index + 1] !== undefined &&
		(tokens[index + 2] === "&&" || tokens[index + 2] === ";")
	) {
		cdDir = tokens[index + 1];
		index += 3;
	}
	const rest = tokens.slice(index);
	if (rest.length === 0 || rest.some((token) => token === "&&" || token === ";" || token === "&")) return null;
	return { tokens: rest, ...(cdDir !== undefined ? { cdDir } : {}) };
}
