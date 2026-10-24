import { describe, expect, it } from 'bun:test';
import { raceScript, main } from '../src/lib/scriptRunner.ts';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpdirWith(name: string): string {
	const d = mkdtempSync(join(tmpdir(), name));
	return d;
}

describe('raceScript()', () => {
	it('runs every line under budget, ok=true when all pass', async () => {
		const r = await raceScript('echo one\necho two\n', {
			secondsPerLine: 2,
			noRace: true,
		});
		expect(r.lines.length).toBe(2);
		expect(r.failed).toBe(0);
		expect(r.ok).toBe(true);
	});

	it('counts a breach as failed and continues to next line', async () => {
		const r = await raceScript('echo fast\nsleep 3\necho after\n', {
			secondsPerLine: 1,
			noRace: true,
		});
		expect(r.lines.length).toBe(3);
		expect(r.failed).toBe(1);
		expect(r.ok).toBe(false);
	});

	it('skips blank lines', async () => {
		const r = await raceScript('\n\necho only\n', {
			secondsPerLine: 2,
			noRace: true,
		});
		expect(r.lines.length).toBe(1);
		expect(r.ok).toBe(true);
	});

	it('writes an incremental log when logPath given', async () => {
		const dir = tmpdirWith('race-script-');
		const log = join(dir, 'out.log');
		const r = await raceScript('echo one\n', {
			secondsPerLine: 2,
			noRace: true,
			logPath: log,
		});
		expect(existsSync(log)).toBe(true);
		const content = readFileSync(log, 'utf8');
		expect(content).toContain('one');
		expect(r.ok).toBe(true);
	});

	it('default secondsPerLine is 4 (4000ms budget)', async () => {
		const r = await raceScript('true\n', { noRace: true });
		expect(r.lines.length).toBe(1);
		expect(r.ok).toBe(true);
	});

	it('empty string yields ok with zero lines', async () => {
		const r = await raceScript('', { secondsPerLine: 2, noRace: true });
		expect(r.lines.length).toBe(0);
		expect(r.ok).toBe(true);
	});
});

describe('main() CLI', () => {
	it('rejects no input with usage exit code 2', async () => {
		const rc = await main([]);
		expect(rc).toBe(2);
	});

	it('runs a file argument and exits 0 on success', async () => {
		const dir = tmpdirWith('race-cli-');
		const f = join(dir, 's.sh');
		writeFileSync(f, 'echo cli-ok\n');
		const rc = await main([
			f,
			'--seconds',
			'2',
			'--no-race',
			'--log',
			join(dir, 'cli.log'),
		]);
		expect(rc).toBe(0);
	});

	it('exits 1 when a line breaches', async () => {
		const dir = tmpdirWith('race-cli-fail-');
		const f = join(dir, 'f.sh');
		writeFileSync(f, 'echo fast\nsleep 3\n');
		const rc = await main([f, '--seconds', '1', '--no-race']);
		expect(rc).toBe(1);
	});

	it('supports --stdin', async () => {
		const dir = tmpdirWith('race-cli-in-');
		const f = join(dir, 'in.sh');
		writeFileSync(f, 'echo stdio\n');
		const rc = await main([f, '--stdin', '--seconds', '2', '--no-race']);
		expect(rc).toBe(0);
	});
});
