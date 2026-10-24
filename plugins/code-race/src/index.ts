/**
 * @delendai/code-race — DelendAI plugin & drop-in Bun library for sub-4s breach auto-racing.
 *
 * Converts `estate/bin/delend-code-race` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { existsSync } from 'node:fs';
import { definePlugin } from '@delendai/core/plugin';
import { consentTools } from '@delendai/consent';
import { z } from 'zod';

const BUDGET_MS = 4000;
const DEFAULT_FORGE = '/home/toxic/pens/barn/forge/bin/forge.ts'; // pattern-forge (has `borrow`+`race`), canonical barn product bundle
export const FORGE = process.env.DELEND_CODERACE_FORGE || DEFAULT_FORGE;
const WINNER_PATH =
	process.env.DELEND_CODERACE_WINNER || '/tmp/delend-code-race-winner.json';

export function run(
	cmd: string,
	args: string[],
	cwd = process.cwd(),
	timeoutMs = 8000,
) {
	try {
		const p = Bun.spawnSync([cmd, ...args], {
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: timeoutMs,
			env: { ...process.env },
		});
		const timedOut = p.signalCode === 'SIGTERM' || p.exitCode === null;
		return {
			status: timedOut ? 124 : (p.exitCode ?? 1),
			stdout: p.stdout.toString().trim(),
			stderr: p.stderr.toString().trim(),
			timedOut,
		};
	} catch {
		return { status: 1, stdout: '', stderr: '', timedOut: true };
	}
}

export function argvOf(line: string): string[] {
	const out: string[] = [];
	const re = /\s+|"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	for (;;) {
		m = re.exec(line);
		if (m === null) break;
		if (m[1] !== undefined) out.push(m[1]);
		else if (m[2] !== undefined) out.push(m[2]);
		else if (m[3] !== undefined) out.push(m[3]);
	}
	return out;
}

export interface RaceResult {
	token: string;
	detail: string;
	lines: string[];
	rc: number;
	winnerWritten?: boolean;
}

export async function raceCore(
	cmdLine: string,
	opts: {
		perSource?: number;
		budget?: number;
		raceTimeout?: number;
		cwd?: string;
		forge?: string;
		writeWinner?: (payload: unknown) => void;
	} = {},
): Promise<RaceResult> {
	const perSource = opts.perSource ?? 3;
	const budget = opts.budget ?? BUDGET_MS;
	const raceTimeout = opts.raceTimeout ?? 6;
	const cwd = opts.cwd ?? process.cwd();
	const forge = opts.forge ?? process.env.DELEND_CODERACE_FORGE ?? FORGE;
	const lines: string[] = [];
	const done = (token: string, detail: string, extra: string[] = []) => {
		lines.push(token);
		lines.push(detail);
		for (const e of extra) lines.push(e);
	};

	const parts = argvOf(cmdLine);
	const exe = parts.shift() ?? '';

	// Run the original through the shell so quoting/globs/pipelines survive the
	// breach hand-off from kairos (argvOf tokenization destroys multi-line `-e`
	// programs and nested quotes, producing a phantom rc!=0 that poisons the race).
	const orig = cmdLine.trim()
		? run('bash', ['-c', cmdLine], cwd, budget)
		: run(exe, parts, cwd, budget);
	if (!orig.timedOut && orig.status === 0) {
		const detail = `original completed under ${budget}ms budget (rc=0). No race needed.`;
		done('PASS flaky', detail);
		return { token: 'PASS flaky', detail, lines, rc: 0 };
	}
	const origProblem = orig.timedOut
		? `breached ${budget}ms`
		: `rc=${orig.status}: ${orig.stderr}`;

	if (!existsSync(forge)) {
		const detail = `${cmdLine} -> ${origProblem}; FORGE cli missing at ${forge}, no race possible.`;
		done('FAIL', detail);
		return { token: 'FAIL', detail, lines, rc: 1 };
	}
	const bn = run(
		'bun',
		[forge, 'borrow', cmdLine, '--per-source', String(perSource)],
		cwd,
		Math.max(800, Math.floor(budget * 0.7)),
	);
	const borrowLines = (bn.stdout || ' ')
		.split('\n')
		.filter(
			(l) =>
				l.trim() && /^\s*[0-9]+\.\s|^\s*[0-9]+\.\[|^\s*1\.\s/.test(l),
		);

	run(
		'bun',
		[
			forge,
			'race',
			'--strategies',
			'/tmp/delend-code-race-strat.json',
			'--race-timeout',
			String(raceTimeout),
		],
		cwd,
		Math.max(800, Math.floor(budget * 0.3)),
	);

	lines.push(
		`\n=== delend-code-race result for: ${exe} ${parts.join(' ')} ===`,
	);
	lines.push(`breach: ${origProblem}`);
	lines.push(`borrow candidates (top ${perSource}):`);
	for (const l of borrowLines) lines.push(`  ${l.trim()}`);
	if (bn.stdout) {
		const src = (bn.stdout.match(/\[([a-z_]+)\]/) || [])[1] ?? 'external';
		const title =
			borrowLines[0]?.replace(/^\s*[0-9.]+\s*\[[^\]]+\]\s*/, '') ??
			'(none surfaced)';
		lines.push(
			`\nPASS borrow → fastest external pattern [source=${src}] — consider basing your sub-${budget} rewrite on: '${title}'`,
		);
		lines.push(`winner written to ${WINNER_PATH}`);
		const payload = {
			cmd: cmdLine,
			budget_ms: budget,
			breach: origProblem,
			borrow_src: src,
			top_candidate: title,
			ts: Date.now(),
		};
		const writer = opts.writeWinner;
		if (writer) writer(payload);
		else Bun.write(WINNER_PATH, JSON.stringify(payload, null, 2));
		return {
			token: 'PASS borrow',
			detail: title,
			lines,
			rc: 0,
			winnerWritten: true,
		};
	}
	lines.push(
		`\nFAIL — no borrow surfaced; original still ${origProblem}. Investigate manually.`,
	);
	return { token: 'FAIL', detail: origProblem, lines, rc: 1 };
}

export function parseArgs(args: string[]): {
	perSource: number;
	budget: number;
	raceTimeout: number;
	cmdLine: string;
} {
	// Standard `--` delimiter: everything after it is the command line, verbatim.
	// run-fast hands the fully-quoted real command after `--` so flag-like tokens
	// inside it (`--per-source`, `--2s`, …) are never misparsed, and a fragmented
	// `-c` program / inline env / quoted substring survives the arg boundary.
	const dd = args.indexOf('--');
	const cmdArgs = dd >= 0 ? args.slice(dd + 1) : args;

	const iPer = cmdArgs.indexOf('--per-source');
	const iBudget = cmdArgs.indexOf('--2s');
	const iRace = cmdArgs.indexOf('--race-timeout');
	const perSource = iPer >= 0 ? Number(cmdArgs[iPer + 1]) || 3 : 3;
	const budget = iBudget >= 0 ? 2000 : BUDGET_MS;
	const raceTimeout = iRace >= 0 ? Number(cmdArgs[iRace + 1]) || 6 : 6;
	const skip = new Set<number>();
	if (iPer >= 0) {
		skip.add(iPer);
		skip.add(iPer + 1);
	}
	if (iBudget >= 0) skip.add(iBudget);
	if (iRace >= 0) {
		skip.add(iRace);
		skip.add(iRace + 1);
	}
	const cmdLine = cmdArgs.filter((_, idx) => !skip.has(idx))[0] ?? '';
	return { perSource, budget, raceTimeout, cmdLine };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`delend-code-race — sub-4s breach auto-racer (plugin: @delendai/code-race).

Usage:
  delend-code-race "your slow command arg1 arg2" [--2s] [--per-source N] [--race-timeout S]

Steps:
  1. Re-runs the command once under the budget (4s default, 2s with --2s).
  2. On persistent breach, auto-races pattern-borrow + code-race via forge.
  3. Writes the winning pattern to /tmp/delend-code-race-winner.json.
`);
		return 0;
	}
	const { perSource, budget, raceTimeout, cmdLine } = parseArgs(argv);
	if (!cmdLine) {
		console.error(
			'usage: delend-code-race "<failing command line>" [--2s] [--per-source N] [--race-timeout S]',
		);
		return 2;
	}
	const r = await raceCore(cmdLine, { perSource, budget, raceTimeout });
	for (const l of r.lines) console.log(l);
	return r.rc;
}

export default definePlugin({
	name: 'code-race',
	version: '0.1.0',
	describe:
		'Sub-4s breach auto-racer: runs a command under budget and auto-races forge pattern-borrow + code-race on breach.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'code_race';
		const wsRoot = ctx.workspace?.root || process.cwd();
		return {
			tools: consentTools('code-race', [
				{
					id: 'run',
					summary:
						'Run a command under a 4s/2s budget and auto-race faster alternatives via forge on breach.',
					tags: ['race', 'performance', 'borrow'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_run`,
							{
								description:
									'Execute delend-code-race on a command line.',
								inputSchema: z.object({
									confirm: z
										.boolean()
										.optional()
										.describe(
											'Explicit I5 consent: required for write/spend tools unless the session opted in via --yes-i-take-responsibility-for-spend',
										),
									cmdLine: z.string(),
									budgetMs: z
										.number()
										.int()
										.positive()
										.optional(),
									perSource: z
										.number()
										.int()
										.positive()
										.optional(),
									raceTimeout: z
										.number()
										.int()
										.positive()
										.optional(),
								}),
							},
							async (toolArgs: {
								cmdLine: string;
								budgetMs?: number;
								perSource?: number;
								raceTimeout?: number;
							}) => {
								const res = await raceCore(toolArgs.cmdLine, {
									budget: toolArgs.budgetMs ?? BUDGET_MS,
									perSource: toolArgs.perSource ?? 3,
									raceTimeout: toolArgs.raceTimeout ?? 6,
									cwd: wsRoot,
								});
								return {
									content: [
										{
											type: 'text',
											text: JSON.stringify(res, null, 2),
										},
									],
								};
							},
						);
					},
				},
			]),
		};
	},
});
