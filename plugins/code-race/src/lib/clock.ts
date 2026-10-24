/**
 * clock.ts — time as a unit, injected, never assumed.
 *
 * Every deadline/race in code-race derives from ONE monotonic clock passed in
 * (real `performance.now()` by default), never from wall-clock drift or
 * re-reads inside a hot loop. This makes budgets deterministic and testable:
 * a fake clock drives a full script run with zero real sleeps.
 */

export interface MonotonicClock {
	readonly now: () => number;
}

/**
 * Spec-compliant monotonic clock present in both bun and node. `Date.now()` is
 * deliberately NOT used: it is wall-clock and can jump (NTP, suspend, user),
 * which would corrupt a deadline that must only ever move forward.
 */
export const realClock: MonotonicClock = {
	now: () => globalThis.performance?.now?.(),
};

/** A fake monotonic clock for tests/arch: advance() pushes time forward. */
export function fakeClock(startMs = 0): MonotonicClock & {
	readonly advance: (ms: number) => void;
} {
	let t = startMs;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}
