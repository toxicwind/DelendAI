/**
 * @delendai/rig-c2 — DelendAI plugin & drop-in Bun library for forever-loop C2 rig diagnostics.
 *
 * Converts `estate/bin/delend-rig-c2` (bash) into a first-class DelendAI plugin
 * (`definePlugin`) and importable Bun library.
 */
import {
	readFileSync,
	statSync,
	existsSync,
	readdirSync,
	mkdirSync,
	symlinkSync,
	lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

const ORACLE = '/home/toxic/estate/ranch/squawk/oracle';
const LEDGER = `${ORACLE}/ledger/ledger.jsonl`;
const ORACLE_WORK = '/home/toxic/estate/ranch/squawk/oracle/work';
const LOOP =
	'/home/toxic/estate/ranch/estate-brain/agents/forever-loop/run-loop.ts';
const SYNCLD_O = '/home/toxic/estate/agents/weaver/bin/market-loop.ts';
const SYNCLD_N =
	'/home/toxic/estate/ranch/estate-brain/agents/weaver/bin/market-loop.ts';

function run(cmd: string[], timeoutMs = 15000) {
	const p = Bun.spawnSync(cmd, {
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs,
		env: { ...process.env },
	});
	return {
		rc: p.exitCode ?? 1,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

export function cmdLedger(lines: string[]): void {
	lines.push('=== Ledger Settlement Stats ===');
	const windowSec = 600;
	const now = Math.floor(Date.now() / 1000);
	const bidders = new Set<string>();
	const events: any[] = [];
	try {
		for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				const bidder = (r.winner || r.bidder || '').replace(
					'bidder-',
					'',
				);
				if (bidder) bidders.add(bidder);
				events.push(r);
			} catch {
				/* skip malformed */
			}
		}
	} catch {
		lines.push('  ledger unreadable');
		return;
	}
	const failures = new Map<
		string,
		{ count: number; tasks: Set<string>; totalMs: number }
	>();
	for (const e of events) {
		if (
			e.event === 'settled' &&
			(e.success === false || e.settle_reason === 'no-result')
		) {
			const winner = (e.winner || '').replace('bidder-', '');
			if (!winner) continue;
			const ts = e.ts || 0;
			if (now - ts < windowSec) {
				const f = failures.get(winner) || {
					count: 0,
					tasks: new Set<string>(),
					totalMs: 0,
				};
				f.count += 1;
				f.tasks.add(e.task_id || '');
				f.totalMs += e.duration_ms || 0;
				failures.set(winner, f);
			}
		}
	}
	lines.push(
		`Window: ${windowSec}s | Bidders observed: ${[...bidders].sort().join(', ')}`,
	);
	for (const [bid, f] of [...failures.entries()].sort()) {
		const status = f.count >= 3 ? 'FLAILING' : 'warning';
		lines.push(
			`  ${bid}: ${status} - ${f.count} failures, ${f.tasks.size} unique tasks, ${(f.totalMs / 1000).toFixed(0)}s wasted`,
		);
	}
	if (!failures.size) lines.push('  No recent failures detected.');
}

export function cmdWorkdir(lines: string[]): void {
	lines.push('=== Workdir Status ===');
	const now = Date.now();
	for (const name of [
		'finch',
		'forge',
		'raccoon',
		'scout',
		'vesper',
		'warden',
	]) {
		const td = join(ORACLE_WORK, name);
		if (!existsSync(td)) {
			lines.push(`  ${name}: NO WORK DIR`);
			continue;
		}
		let dirs: string[] = [];
		try {
			dirs = readdirSync(td).filter((d) => d.startsWith('task-'));
		} catch {
			dirs = [];
		}
		dirs.sort((a, b) => {
			try {
				return (
					statSync(join(td, b)).mtimeMs -
					statSync(join(td, a)).mtimeMs
				);
			} catch {
				return 0;
			}
		});
		if (!dirs.length) {
			lines.push(`  ${name}: no task dirs`);
			continue;
		}
		const latest = dirs[0]!;
		let age = -1;
		try {
			age = (now - statSync(join(td, latest)).mtimeMs) / 1000;
		} catch {
			/* ignore */
		}
		const inv: string[] = [];
		const settledFile = join(td, latest, 'settled.json');
		if (existsSync(settledFile)) {
			try {
				const s = JSON.parse(readFileSync(settledFile, 'utf8'));
				inv.push(`settled(${s.success ?? '?'})`);
			} catch {
				/* ignore */
			}
		}
		if (existsSync(join(td, latest, 'corral-invocation.txt')))
			inv.push('corral');
		if (existsSync(join(td, latest, 'ralph-invocation.txt')))
			inv.push('ralph');
		lines.push(
			`  ${name}: ${dirs.length} tasks, latest=${latest} (${Math.round(age)}s ago) [${inv.join(', ') || 'no-invocations'}]`,
		);
	}
}

export function cmdSymlink(lines: string[]): void {
	lines.push('=== Market-loop Symlink ===');
	try {
		if (lstatSync(SYNCLD_O).isSymbolicLink()) {
			lines.push(
				`  OK: ${SYNCLD_O} -> ${run(['readlink', SYNCLD_O]).out.trim() || '(broken)'}`,
			);
			return;
		}
	} catch {
		/* not a symlink or missing */
	}
	if (existsSync(SYNCLD_O)) {
		lines.push(`  EXISTS (not symlink): ${SYNCLD_O}`);
	} else if (existsSync(SYNCLD_N)) {
		lines.push(`  MISSING: ${SYNCLD_O} (real: ${SYNCLD_N})`);
		try {
			mkdirSync(join(SYNCLD_O, '..'), { recursive: true });
			symlinkSync(SYNCLD_N, SYNCLD_O);
			lines.push(`  Fixed: ${SYNCLD_O} -> ${SYNCLD_N}`);
		} catch (e: any) {
			lines.push(
				`  FIX FAILED: ${String((e as Error).message || e).slice(0, 120)}`,
			);
		}
	} else {
		lines.push(
			`  BROKEN: ${SYNCLD_O} missing, ${SYNCLD_N} not found either`,
		);
	}
}

export function main(argv = process.argv.slice(2)): number {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`Usage: delend-rig-c2 [--once] [--dry] [--ledger] [--workdir] [--symlink] [--help] (plugin: @delendai/rig-c2)

Flags:
  --once       Single-tick mode (pass through to run-loop.ts)
  --dry        Dry-run mode (pass through to run-loop.ts)
  --ledger     Show recent ledger settlement stats
  --workdir    Show workdir status per bidder
  --symlink    Check/fix the market-loop symlink
  --help       Show this help
`);
		return 0;
	}
	const flags = argv.filter((a) =>
		['--once', '--dry', '--ledger', '--workdir', '--symlink'].includes(a),
	);
	const lines: string[] = [];
	if (flags.includes('--ledger')) cmdLedger(lines);
	if (flags.includes('--workdir')) cmdWorkdir(lines);
	if (flags.includes('--symlink')) cmdSymlink(lines);
	if (lines.length) console.log(lines.join('\n'));
	if (flags.length === 0) {
		console.log('Running forever-loop tick...');
		const r = run(['/home/toxic/.bun/bin/bun', LOOP, '--once']);
		process.stdout.write(r.out);
		process.stderr.write(r.err);
		return r.rc;
	}
	return 0;
}

export default definePlugin({
	name: 'rig-c2',
	version: '0.1.0',
	describe:
		'Forever-loop C2 rig diagnostics: ledger settlement stats, workdir status per bidder, market-loop symlink check/fix, loop tick launch.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'rig_c2';
		return {
			tools: [
				{
					id: 'diagnose',
					summary:
						'C2 rig diagnostics: ledger, workdir, symlink check/fix, or run a loop tick.',
					tags: ['rig', 'c2', 'diagnostics'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_diagnose`,
							{
								description:
									'Run C2 rig diagnostics (ledger/workdir/symlink) or a loop tick.',
								inputSchema: z.object({
									ledger: z.boolean().optional(),
									workdir: z.boolean().optional(),
									symlink: z.boolean().optional(),
									once: z.boolean().optional(),
									dry: z.boolean().optional(),
								}),
							},
							async (toolArgs: {
								ledger?: boolean;
								workdir?: boolean;
								symlink?: boolean;
								once?: boolean;
								dry?: boolean;
							}) => {
								const flags: string[] = [];
								if (toolArgs.ledger) flags.push('--ledger');
								if (toolArgs.workdir) flags.push('--workdir');
								if (toolArgs.symlink) flags.push('--symlink');
								if (toolArgs.once) flags.push('--once');
								if (toolArgs.dry) flags.push('--dry');
								const lines: string[] = [];
								const origLog = console.log;
								const origError = console.error;
								console.log = (...a) => lines.push(a.join(' '));
								console.error = (...a) =>
									lines.push('ERROR: ' + a.join(' '));
								let rc: number;
								try {
									rc = main(flags);
								} finally {
									console.log = origLog;
									console.error = origError;
								}
								return {
									content: [
										{
											type: 'text',
											text: JSON.stringify({
												ok: rc === 0,
												rc,
												output: lines.join('\n'),
											}),
										},
									],
								};
							},
						);
					},
				},
			],
		};
	},
});
