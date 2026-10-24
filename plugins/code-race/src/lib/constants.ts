/**
 * constants.ts — shared defaults/well-known paths for the code-race lib.
 * Kept in one module so bun and rust mirrors stay trivially aligned.
 */
export const BUDGET_MS = 4000;
export const DEFAULT_FORGE =
	process.env.DELEND_CODERACE_FORGE ||
	'/home/toxic/pens/barn/forge/bin/forge.ts';
export const WINNER_PATH =
	process.env.DELEND_CODERACE_WINNER || '/tmp/delend-code-race-winner.json';

/** Budget, clock, and parse re-exports so consumers import from one place. */
export { Budget, Deadline } from './budget';
export type { BudgetOptions, BudgetStats } from './budget';
export { realClock, fakeClock } from './clock';
export type { MonotonicClock } from './clock';
export { redactText, runShell } from './shell';
export type { ShellRun } from './shell';
export {
	parseDuration,
	shellQuoteCmd,
	argvOf,
	splitAtDoubleDash,
} from './parse';
