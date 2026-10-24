/**
 * race.ts — importable per-line command-race primitive.
 *
 * Built on the modular core:
 *   clock.ts   — monotonic, injected time unit
 *   budget.ts  — one shared budget pool (whole-script semantics)
 *   shell.ts   — shell-accurate execution with monotonic hard-kill + redaction
 *   parse.ts   — duration + argv parsing, lossless quoting
 *
 * `race(line, budget)` runs one LINE of a script under the budget's deadline,
 * fails fast on breach, and (unless noRace) races forge alternatives. Output
 * is redacted before it can leak. DEBUG grade: every step emits `[race]` to
 * stderr when CODE_RACE_DEBUG is truthy.
 */
import { realClock } from './clock';
import type { MonotonicClock } from './clock';
import { Budget } from './budget';
import type { Deadline } from './budget';
import { runShell } from './shell';
import { existsSync } from 'node:fs';
import { DEFAULT_FORGE, WINNER_PATH, BUDGET_MS } from './constants';

export interface RaceOptions {
	/** hard budget in ms; or pass a shared Budget to enforce whole-script pools */
	budgetMs?: number;
	/** shared budget pool; when given, derives the deadline from the pool */
	budget?: Budget;
	/** pattern-borrow per-source results to race on breach (default 3) */
	perSource?: number;
	/** forge code-race timeout seconds (default 6) */
	raceTimeout?: number;
	/** working directory for the command (default process.cwd()) */
	cwd?: string;
	/** disable auto-race; just run under budget (default false) */
	noRace?: boolean;
	/** custom forge binary path */
	forge?: string;
	/** injected monotonic clock (default real performance.now) */
	clock?: MonotonicClock;
}

export interface RaceAttempt {
	kind: 'budget' | 'winner' | 'poll';
	ms: number;
	rc: number;
	timedOut?: boolean;
	cmd?: string;
}

export interface RaceResult {
	ok: boolean;
	rc: number;
	timedOut: boolean;
	lines: string[];
	winner: string | null;
	attempts: RaceAttempt[];
}

export const RACE_JSON_SCHEMA =
	'{"ok":bool,"rc":int,"timedOut":bool,"lines":[str],"winner":str|null,"attempts":[{"kind":str,"ms":int,"rc":int,"timedOut":bool,"cmd":str}]}';

const DEBUG = (() => {
	const v = process.env.CODE_RACE_DEBUG;
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

function dbg(...parts: unknown[]): void {
	if (!DEBUG) return;
	const line = parts
		.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p)))
		.join(' ');
	console.error(`[race] ${line}`);
}

/** Derive the effective per-op deadline from opts (budget pool wins). */
function resolveDeadline(opts: RaceOptions): {
	budget: Budget;
	deadline: Deadline;
	clock: MonotonicClock;
	/** true when a caller-provided shared pool is in play (whole-script mode) */
	shared: boolean;
} {
	if (opts.budget) {
		return {
			budget: opts.budget,
			deadline: opts.budget.deadlineForOp(),
			clock: opts.budget.clock,
			shared: true,
		};
	}
	const ms = opts.budgetMs ?? BUDGET_MS;
	// Per-op one-shot pool when no shared script budget is given. Time is a
	// measured unit: derive the deadline from the injected monotonic clock,
	// never from a repeated wall-clock read.
	const clock: MonotonicClock = opts.clock ?? realClock;
	const budget = new Budget({ totalMs: ms, clock, label: 'one-op' });
	return { budget, deadline: budget.deadlineForOp(), clock, shared: false };
}

/**
 * Race ONE command line under the budget, fail fast on breach, and on breach
 * race faster alternatives through forge pattern-borrow (unless noRace).
 */
export async function race(
	cmdLine: string,
	opts: RaceOptions = {},
): Promise<RaceResult> {
	const { budget, deadline, clock, shared } = resolveDeadline(opts);
	const {
		perSource = 3,
		raceTimeout = 6,
		cwd = process.cwd(),
		noRace = false,
		forge = DEFAULT_FORGE,
	} = opts;

	const attempts: RaceAttempt[] = [];

	dbg('race begin', {
		cmdLine,
		budgetMs: budget.totalMs,
		perSource,
		raceTimeout,
		cwd,
		noRace,
		forge,
	});

	// Zero budget = immediate breach: nothing can run within 0ms. Skip the exec
	// entirely so a 0-budget caller gets a deterministic, unconditional timeout.
	if (budget.totalMs === 0) {
		const breach: RaceResult = {
			ok: false,
			rc: 124,
			timedOut: true,
			lines: [
				noRace ? 'budget breached (noRace)' : 'budget pool exhausted',
			],
			winner: null,
			attempts: [],
		};
		dbg('race end (zero budget)', breach);
		return breach;
	}

	// 1. budget run (fail fast; shell-accurate; monotonic hard kill)
	const r = await runShell(cmdLine, deadline, cwd);
	attempts.push({
		kind: 'budget',
		ms: r.ms,
		rc: r.rc,
		timedOut: r.timedOut,
		cmd: cmdLine,
	});
	budget.charge(r.ms);

	const out: RaceResult = {
		ok: !r.timedOut && r.rc === 0,
		rc: r.rc,
		timedOut: r.timedOut,
		lines: r.lines,
		winner: null,
		attempts,
	};
	dbg('budget verdict', {
		timedOut: r.timedOut,
		rc: r.rc,
		ms: r.ms,
		ok: out.ok,
	});
	if (!r.timedOut) {
		dbg('race end (fast)', out);
		return out; // finished inside budget
	}

	// 2. breach -> auto-race through forge. A SHARED (whole-script) pool that is
	// exhausted can't fund a forge race, so stop there. A one-shot per-call
	// budget still races forge: the whole point is to find a faster alternative.
	if (noRace || (shared && budget.exhausted())) {
		const stopped: RaceResult = {
			ok: false,
			rc: 124,
			timedOut: true,
			lines: [
				noRace ? 'budget breached (noRace)' : 'budget pool exhausted',
			],
			winner: null,
			attempts,
		};
		dbg('race end (noRace/exhausted)', stopped);
		return stopped;
	}

	// Forge gets its OWN bounded budget (raceTimeout seconds), never the already-
	// spent op deadline — the whole point is to give pattern-borrow room to find a
	// faster alternative. In whole-script mode the pool's *remaining* still caps it.
	const forgeMs = Math.max(
		1,
		Math.min(
			raceTimeout * 1000,
			shared ? budget.remainingMs() : raceTimeout * 1000,
		),
	);
	const forgeBudget = new Budget({
		totalMs: forgeMs,
		clock,
		label: 'forge-race',
	});
	const raced = await runShell(
		`bun run ${forge} borrow '${cmdLine.replace(/'/g, `'\\''`)}' --per-source ${perSource}`,
		forgeBudget.deadlineForOp(),
		cwd,
	);
	attempts.push({
		kind: 'winner',
		ms: raced.ms,
		rc: raced.rc,
		cmd: `bun run ${forge} borrow ${cmdLine}`,
	});
	budget.charge(raced.ms);

	let winner: string | null = null;
	try {
		// Platform-neutral winner check (bun AND node).
		if (existsSync(WINNER_PATH)) winner = WINNER_PATH;
	} catch {
		winner = null;
	}

	const racedOut: RaceResult = {
		ok: raced.rc === 0,
		rc: raced.rc,
		timedOut: false,
		lines: raced.lines,
		winner,
		attempts,
	};
	dbg('race end (raced)', racedOut);
	return racedOut;
}

/** JSON-line contract for cross-language wrappers; prints the result once. */
export async function raceJson(
	cmdLine: string,
	opts: RaceOptions = {},
): Promise<string> {
	const r = await race(cmdLine, opts);
	const s = JSON.stringify(r);
	dbg('raceJson full:', s);
	return s;
}

export default race;
