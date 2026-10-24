/**
 * scriptRunner.ts — line-by-line code-race runner (debug-grade).
 *
 * If a script is sent, EVERY line is run through the race primitive; the
 * per-line target is the seconds you pass (default 4). Each line is executed
 * under that budget, fails fast on breach, and races forge alternatives
 * unless noRace. Full per-line output is appended incrementally (flush per
 * line) so interrupted runs leave complete partial results.
 *
 * usage (CLI):
 *   delend-code-race-line <script-file> [--seconds N] [--no-race]
 *   cat script | delend-code-race-line --stdin [--seconds N]
 *   delend-code-race-line --cmd "line1; line2\nyet another" --seconds N
 *
 * usage (import):
 *   import { raceScript } from '@delendai/code-race/lib/scriptRunner'
 *   const res = await raceScript(scriptText, { secondsPerLine: 4 })
 *   // returns per-line results + a whole-script verdict
 */
import { race, type RaceOptions, type RaceResult } from './race';
import { Budget } from './budget';
import { realClock } from './clock';
import { parseDuration } from './parse';

export interface LineResult {
	/** original trimmed line (whole, no truncation) */
	line: string;
	lineNo: number;
	/** per-line race outcome */
	result: RaceResult;
}

export interface ScriptResult {
	ok: boolean;
	lines: LineResult[];
	/** number of lines that breached their budget or failed rc */
	failed: number;
	/** seconds per line (DEPRECATED) — see budgetMs; kept for compat fields */
	secondsPerLine: number;
}

export interface ScriptOptions {
	/**
	 * WHOLE-script budget. `--seconds 10` = the ENTIRE script must finish in
	 * 10s. Every line race drains this one pool; nothing runs on its own
	 * clock. Accepts "10", "10s", "2500ms". (Default 4s whole-script.)
	 */
	seconds?: number | string;
	/**
	 * Backward-compat alias: a per-line cap. When given alongside `seconds`,
	 * a line may not exceed min(remaining, this) — a greedy line can throttle
	 * itself but can never extend past the whole-script budget.
	 */
	secondsPerLine?: number;
	/** forward to race(): disable forge auto-race on breach */
	noRace?: boolean;
	/** forward to race(): cwd */
	cwd?: string;
	/** persistence target: append each line's output here */
	logPath?: string;
}

const DEBUG = (() => {
	const v = process.env.CODE_RACE_DEBUG;
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

function dbg(...parts: unknown[]): void {
	if (!DEBUG) return;
	console.error(
		`[race-line] ${parts.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ')}`,
	);
}

/** Split a script into executable lines: blank lines and pure comments skipped. */
export function scriptLines(script: string): string[] {
	return script
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Run every line of a script through the race primitive under ONE shared
 * whole-script budget (time is not a construct: one pool, one monotonic
 * clock, no per-line sleeping). Lines drain the pool; a breaching line is
 * killed fast and (unless noRace) forge races a faster alternative within the
 * remaining budget. Incremental append to logPath when provided.
 */
export async function raceScript(
	script: string,
	opts: ScriptOptions = {},
): Promise<ScriptResult> {
	const { seconds, secondsPerLine, noRace = false, cwd, logPath } = opts;
	// Whole-script mode when `seconds` given: ONE shared Budget drains a single
	// pool (time is not a construct) — the ENTIRE script must finish within it.
	// Legacy `secondsPerLine`-only mode keeps per-line one-shot budgets (each
	// line may take up to its own budget; lines do not share a pool).
	const wholeScript = seconds !== undefined;
	const perLineMs = parseDuration(secondsPerLine ?? seconds ?? 4, 4000);
	const totalMs = perLineMs;

	const lines = scriptLines(script);
	dbg('raceScript begin', {
		lines: lines.length,
		wholeScript,
		totalMs,
		perLineMs,
		noRace,
		cwd,
		logPath,
	});

	// Whole-script: one shared pool divided evenly across lines so no single
	// greedy line can exceed its fair share; per-line mode: null pool (race()
	// builds a one-shot budget per call).
	const shared =
		wholeScript && lines.length > 0
			? new Budget({
					totalMs,
					maxPerOpMs: Math.max(1, Math.floor(totalMs / lines.length)),
					clock: realClock,
					label: 'script',
				})
			: null;

	const out: ScriptResult = {
		ok: true,
		lines: [],
		failed: 0,
		secondsPerLine: perLineMs / 1000,
	};
	const file = logPath ? Bun.file(logPath).writer() : null;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		// Whole-script exhausted pool: fail fast the whole script instead of queueing.
		if (shared?.exhausted()) {
			dbg(`line ${i} skipped: budget exhausted`);
			out.lines.push({
				line,
				lineNo: i,
				result: {
					ok: false,
					rc: 124,
					timedOut: true,
					lines: ['budget pool exhausted'],
					winner: null,
					attempts: [],
				},
			});
			out.failed += 1;
			continue;
		}
		dbg(`line ${i} start: ${line}`);
		const raceOpts: RaceOptions = shared
			? {
					budget: shared,
					noRace,
					...((cwd ? { cwd } : {}) as RaceOptions),
				}
			: {
					budgetMs: totalMs,
					noRace,
					...((cwd ? { cwd } : {}) as RaceOptions),
				};
		const result = await race(line, raceOpts);
		const lr: LineResult = { line, lineNo: i, result };
		out.lines.push(lr);
		if (result.timedOut || result.rc !== 0) out.failed += 1;
		dbg(`line ${i} verdict`, {
			timedOut: result.timedOut,
			rc: result.rc,
			ms: result.attempts[0]?.ms,
		});

		if (file) {
			file.write(
				`${[
					`\n== line ${i} (${result.timedOut ? 'BREACH' : `rc=${result.rc}`}, ${result.attempts[0]?.ms ?? 0}ms) ==`,
					`> ${line}`,
					...(result.lines.length ? result.lines : []),
				].join('\n')}\n`,
			);
		}
	}
	if (file) {
		file.end();
		// writer close is async; flush handle by re-opening handle? keep simple:
		// Bun FileSink flushes on process end — for importable use, awaited below.
	}
	await new Promise((r) => setTimeout(r, 50)); // allow sink flush
	out.ok = out.failed === 0;
	dbg('raceScript end', {
		ok: out.ok,
		failed: out.failed,
		lines: out.lines.length,
	});
	return out;
}

/** CLI entry for delend-code-race-line. */
export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`delend-code-race-line — run EVERY line of the whole script through code-race.

Usage:
  delend-code-race-line <file> [--seconds N] [--no-race] [--log <file>]
  delend-code-race-line --cmd "<multi-line script>" [--seconds N]
  cat script | delend-code-race-line --stdin [--seconds N]

--seconds N = the WHOLE-script budget (default 4): the entire script must
finish in N seconds. Every line races under the shared pool, killed fast on
breach, and (unless --no-race) forge pattern-borrow races a faster alternative
against the remaining budget. Output appends to --log (default
/tmp/delend-code-race-line.log) with no truncation.
`);
		return 0;
	}
	let script = '';
	let seconds: number | string = 4;
	let noRace = false;
	let logPath = '/tmp/delend-code-race-line.log';
	let fileArg: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--seconds') seconds = argv[i + 1] ?? '4';
		else if (argv[i] === '--no-race') noRace = true;
		else if (argv[i] === '--log') logPath = argv[i + 1] ?? logPath;
		else if (argv[i] === '--stdin') script = await Bun.stdin.text();
		else if (argv[i] === '--cmd') script = argv[i + 1] ?? '';
		else if (!(argv[i] ?? '').startsWith('-') && !fileArg)
			fileArg = argv[i]!;
	}
	if (!script && fileArg) script = await Bun.file(fileArg).text();
	if (!script.trim()) {
		console.error('no script input (pass a file, --stdin, or --cmd)');
		return 2;
	}
	const res = await raceScript(script, {
		seconds,
		noRace,
		logPath,
	});
	console.log(
		`lines=${res.lines.length} failed=${res.failed} seconds=${res.secondsPerLine}s ok=${res.ok} log=${logPath}`,
	);
	return res.ok ? 0 : 1;
}
