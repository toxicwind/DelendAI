/**
 * parse.ts — shared duration + argv parsing and lossless shell quoting.
 *
 * `--seconds 10` and `10s` are the same duration. A script line, or the real
 * command run-fast passes to us after a breach, must survive a `bash -c`
 * round-trip: arg boundaries, `-c` programs, inline env, globs and quotes all
 * preserved. This module holds those two concerns so no caller re-implements
 * them or falls back to a lossy `.split(/\s+/)`.
 */

/** Parse a duration like "10s", "2500ms", "5" (seconds), or a bare number. */
export function parseDuration(
	input: string | number,
	fallbackMs: number,
): number {
	if (typeof input === 'number') return Math.max(0, Math.round(input * 1000));
	const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(String(input));
	if (!m) return fallbackMs;
	const n = Number(m[1]);
	switch ((m[2] ?? 's').toLowerCase()) {
		case 'ms':
			return Math.max(0, Math.round(n));
		case 'm':
			return Math.max(0, Math.round(n * 60_000));
		default:
			return Math.max(0, Math.round(n * 1000));
	}
}

const SAFE_CHARS_RE = /^[A-Za-z0-9_./:=-]+$/;

/** Losslessly quote an argv array into one re-runnable shell line. */
export function shellQuoteCmd(args: readonly string[]): string {
	return args
		.map((a) =>
			SAFE_CHARS_RE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
		)
		.join(' ');
}

/**
 * Split a command line into argv WITHOUT losing quoting. Falls back to a
 * whitespace split only for lines with no quotes. Used only where a true argv
 * is needed (never for execution, which always goes through `bash -c`).
 */
export function argvOf(cmdLine: string): string[] {
	// If no shell metacharacters or quotes, a plain whitespace split is exact.
	if (!/['"\\$\x60;&|<>()*?]/.test(cmdLine)) {
		return cmdLine.split(/\s+/).filter(Boolean);
	}
	// Puny shlex: single/double-quote aware whitespace tokenizer.
	const out: string[] = [];
	const re = /'[^']*'|"[^"]*"|\S+/g;
	for (const m of cmdLine.match(re) ?? []) {
		let t = m;
		if (
			(t.startsWith('"') && t.endsWith('"')) ||
			(t.startsWith("'") && t.endsWith("'"))
		) {
			t = t.slice(1, -1);
		}
		out.push(t);
	}
	return out;
}

/**
 * CLI `--`-delimiter handling: everything after `--` is treated verbatim.
 * Returns { before, command } where `command` is the tail slice.
 */
export function splitAtDoubleDash(args: string[]): {
	before: string[];
	command: string[];
} {
	const i = args.indexOf('--');
	if (i < 0) return { before: args, command: [] };
	return { before: args.slice(0, i), command: args.slice(i + 1) };
}
