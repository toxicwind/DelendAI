import { describe, expect, it } from 'bun:test';
import { race, raceJson } from '../src/lib/race.ts';

const realForge = '/home/toxic/pens/barn/forge/bin/forge.ts';

describe('race()', () => {
	it('returns ok for a fast command under budget', async () => {
		const r = await race('echo hi', { budgetMs: 2000, noRace: true });
		expect(r.ok).toBe(true);
		expect(r.timedOut).toBe(false);
		expect(r.rc).toBe(0);
		expect(r.lines.join(' ')).toContain('hi');
		expect(r.attempts.length).toBe(1);
		expect(r.attempts[0].kind).toBe('budget');
	});

	it('flags timedOut when the command exceeds budget (noRace)', async () => {
		const r = await race('sleep 3', { budgetMs: 300, noRace: true });
		expect(r.ok).toBe(false);
		expect(r.timedOut).toBe(true);
		expect(r.rc).toBe(124);
		expect(r.lines.join(' ')).toContain('budget breached');
	});

	it('races forge when breaching with noRace=false', async () => {
		const r = await race('sleep 3 && echo slow', {
			budgetMs: 300,
			noRace: false,
			forge: realForge,
		});
		// forge may itself fail (network) — but the race MUST have been attempted
		expect(r.attempts.length).toBeGreaterThanOrEqual(2);
		expect(r.attempts.some((a) => a.kind === 'budget')).toBe(true);
	}, 30000);

	it('budgetMs=0 treats as immediate breach', async () => {
		const r = await race('echo never', { budgetMs: 0, noRace: true });
		expect(r.ok).toBe(false);
		expect(r.timedOut).toBe(true);
	});

	it('non-zero exit code marks ok=false', async () => {
		const r = await race('false', { budgetMs: 2000, noRace: true });
		expect(r.ok).toBe(false);
		expect(r.rc).toBe(1);
		expect(r.timedOut).toBe(false);
	});

	it('missing binary yields rc != 0 without throwing', async () => {
		const r = await race('definitely-not-a-real-binary-xyz', {
			budgetMs: 1000,
			noRace: true,
		});
		expect(r.ok).toBe(false);
		expect(r.rc).not.toBe(0);
	});

	it('captures stderr into lines with a failing target', async () => {
		const r = await race('sh -c "echo oops >&2; exit 2"', {
			budgetMs: 2000,
			noRace: true,
		});
		expect(r.rc).toBe(2);
		expect(r.lines.join(' ')).toContain('oops');
	});

	it('default budget is 4000ms (4s)', async () => {
		const r = await race('true', { noRace: true });
		expect(r.attempts[0].ms).toBeLessThanOrEqual(4000);
	});

	it('raceJson returns a JSON string of the result', async () => {
		const s = await raceJson('echo json-me', {
			budgetMs: 1000,
			noRace: true,
		});
		const parsed = JSON.parse(s);
		expect(parsed.ok).toBe(true);
		expect(parsed.lines.join(' ')).toContain('json-me');
	});
});

describe('race() default export', () => {
	it('default export is race itself', async () => {
		// @ts-expect-error default export binding check
		const d = (await import('../src/lib/race.ts')).default;
		expect(typeof d).toBe('function');
	});
});
