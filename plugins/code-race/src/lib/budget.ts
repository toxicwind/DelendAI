/**
 * budget.ts — a single, monotonic-clock budget pool shared across a whole run.
 *
 * Architecture: "time is not a construct." A script's `--seconds 10` means the
 * WHOLE run has 10s. Each line race CHARGES that one pool; there is no separate
 * per-line clock and no `sleep`-based polling anywhere. The budget is a
 * shareable object so a parent script can mint a child budget for an include
 * and both deduct from the same total. The wall clock is injected and
 * monotonic; nothing assumes elapsed time about the host.
 */
import type { MonotonicClock } from './clock';

export interface BudgetStats {
	totalMs: number;
	spentMs: number;
	remainingMs: number;
	exhausted: boolean;
}

export interface BudgetOptions {
	totalMs: number;
	/** per-operation hard cap so one greedy line can't eat the whole pool */
	maxPerOpMs?: number;
	/** monotonic clock; defaults to performance.now via the real clock module */
	clock?: MonotonicClock;
	/** user-visible label (for traces) */
	label?: string;
}

/**
 * Deadline model: an absolute monotonic timestamp that a running op must not
 * exceed. Derived ONCE from a budget (never re-read `Date.now()` inside a hot
 * loop), so a deadline never drifts. Exposes `now()`/`isExpired()` so it
 * satisfies the shell executor's clock interface directly.
 */
export class Deadline {
	readonly clock: MonotonicClock;
	readonly offsetMs: number;
	#deadline: number;
	constructor(clock: MonotonicClock, offsetMs: number) {
		this.clock = clock;
		this.offsetMs = offsetMs;
		this.#deadline = clock.now() + offsetMs;
	}
	/** current injected monotonic time */
	now(): number {
		return this.clock.now();
	}
	/** ms remaining from the injected clock until this deadline */
	remaining(): number {
		const r = this.#deadline - this.clock.now();
		return r > 0 ? r : 0;
	}
	/** true once the injected monotonic clock has passed this deadline */
	isExpired(): boolean {
		return this.clock.now() >= this.#deadline;
	}
}

export class Budget {
	readonly totalMs: number;
	readonly maxPerOpMs: number;
	readonly clock: MonotonicClock;
	readonly label: string;
	#spentMs = 0;
	#origin: number;

	constructor(opts: BudgetOptions) {
		this.totalMs = Math.max(0, opts.totalMs);
		this.maxPerOpMs =
			opts.maxPerOpMs !== undefined
				? Math.max(0, opts.maxPerOpMs)
				: Math.max(0, this.totalMs); // default: no cap → whole pool
		this.clock = opts.clock ?? realClock();
		this.label = opts.label ?? 'budget';
		this.#origin = this.clock.now();
	}

	/** ms already charged against the pool. */
	spentMs(): number {
		return Math.min(this.#spentMs, this.totalMs);
	}

	/** remaining budget, floored at 0. */
	remainingMs(): number {
		return Math.max(0, this.totalMs - this.spentMs());
	}

	exhausted(): boolean {
		return this.spentMs() >= this.totalMs;
	}

	/** Share this budget as a child pool (drains the same total on spend). */
	child(label?: string): Budget {
		return new Budget({
			totalMs: this.totalMs,
			maxPerOpMs: this.maxPerOpMs,
			clock: this.clock,
			label: label ?? `${this.label}.child`,
		});
	}

	/**
	 * The absolute deadline for the NEXT operation: it may spend the minimum of
	 * whatever this budget still allows and this budget's per-op cap, never
	 * past the total deadline.
	 */
	deadlineForOp(): Deadline {
		const allowed = Math.min(this.remainingMs(), this.maxPerOpMs);
		return new Deadline(this.clock, allowed);
	}

	/**
	 * Charge an operation's measured duration (monotonic) against the pool.
	 * Non-negative; a charge beyond remaining is floored to the pool.
	 */
	charge(measuredMs: number): void {
		if (Number.isFinite(measuredMs) && measuredMs > 0) {
			this.#spentMs += measuredMs;
			if (this.#spentMs > this.totalMs) this.#spentMs = this.totalMs;
		}
	}

	/** The budget's lifetime is bounded by the injected clock since origin. */
	remainingOfLifetime(): number {
		const lifetimeUsed = this.clock.now() - this.#origin;
		return Math.max(0, this.totalMs - lifetimeUsed);
	}

	stats(): BudgetStats {
		return {
			totalMs: this.totalMs,
			spentMs: this.spentMs(),
			remainingMs: this.remainingMs(),
			exhausted: this.exhausted(),
		};
	}
}

/**
 * Inject the real monotonic clock. `performance.now()` is monotonic in bun AND
 * node (both expose a spec-compliant global), so it is the correct base — never
 * wall-clock `Date.now()` diamond-drift inside a deadline race.
 */
function realClock(): MonotonicClock {
	return {
		now: () => globalThis.performance?.now?.(),
	};
}
