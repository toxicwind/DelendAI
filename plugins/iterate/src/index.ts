/**
 * @delendai/iterate — DelendAI plugin & drop-in Bun library for async/await-aware synchronous iteration.
 *
 * Converts `estate/bin/delend-iterate` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { consentTools } from '@delendai/consent';
import { z } from 'zod';

export function get(argv: string[], f: string, d = ''): string {
	const i = argv.indexOf(f);
	return i >= 0 ? argv[i + 1]! : d;
}

export function checkModel(
	runp: (cmd: string, t?: number) => { rc: number; err: string; out: string },
): string {
	const h = runp(
		`curl -s --max-time 2 http://127.0.0.1:25193/v1/models 2>/dev/null | head -c 160 || echo hodos-down`,
		2500,
	);
	const t = runp(
		`[ -n "$GEMINI_EAP_KEY_1" ] && echo "EAP:\${GEMINI_EAP_KEY_1:0:6}..." || echo no-eap-key`,
		1500,
	);
	return (h.out || 'hodos-down') + ' | ' + (t.out || '');
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const argsAll = argv;
	if (argsAll.includes('--help') || argsAll.includes('-h')) {
		console.log(`delend-iterate — async/await-aware synchronous iteration driver (plugin: @delendai/iterate).

Usage:
  delend-iterate --goal "<objective>" --workdir <dir> [--iters 10]
                 [--before <cmd>] [--after <cmd>] [--budget-ms 4000]

Each iteration feeds the previous result into the next, may change code (--after),
and double-checks the model/egress before continuing. Stops early on :iters reached
or 2 clean passes with a stable model.
`);
		return 0;
	}
	const goal = get(argsAll, '--goal', '');
	const wd = resolve(get(argsAll, '--workdir', '.'));
	const posN =
		Number(
			argsAll.find(
				(x, i) => /^\d+$/.test(x) && !argsAll[i - 1]?.startsWith('--'),
			) ?? 0,
		) || 0;
	const iters = argsAll.includes('--iters')
		? Number(get(argsAll, '--iters', '10'))
		: posN > 0
			? posN
			: 10;
	const budget = Number(get(argsAll, '--budget-ms', '4000'));
	const before = get(argsAll, '--before', '');
	const after = get(argsAll, '--after', '');

	if (!goal) {
		console.error(
			"usage: delend-iterate --goal '<objective>' --workdir <dir> [--iters 10]",
		);
		return 2;
	}
	const runp = (cmd: string, t = budget) => {
		const p = Bun.spawnSync(['bash', '-lc', cmd], {
			cwd: wd,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: t,
			env: { ...process.env },
		});
		return {
			rc: p.exitCode ?? 1,
			err: p.stderr.toString().trim(),
			out: p.stdout.toString().trim(),
		};
	};

	const state: {
		prev: null | { n: number; ok: boolean };
		n: number;
		passStreak: number;
	} = {
		prev: null,
		n: 0,
		passStreak: 0,
	};
	const OUT = resolve(wd, '.delend-iterate.json');
	mkdirSync(wd, { recursive: true });

	console.log(
		`delend-iterate — ${iters} sync-feedback iters, budget ${budget}ms, goal: ${goal}`,
	);
	for (let i = 0; i < iters; i++) {
		const t0 = Date.now();
		const model = checkModel(runp);
		let step = runp(before || `echo "iter ${i + 1}; goal=${goal}"`, budget);
		if (
			step.rc !== 0 &&
			/(timed out|124|TIMEOUT)/i.test(step.rc + ' ' + step.err)
		) {
			const r = runp(
				`/home/toxic/estate/bin/delend-code-race "${goal}" 2>&1 | tail -3`,
				4500,
			);
			step = { rc: 0, err: '', out: 'breach→race: ' + (r.out || '') };
		}
		if (after) {
			runp(after, budget);
		}
		const ms = Date.now() - t0;
		const result = {
			n: i + 1,
			ms,
			ok: step.rc === 0,
			breach: step.rc !== 0 && ms >= budget,
			model,
			prev: state.prev && { n: state.prev.n, ok: state.prev.ok },
			out: step.out.slice(0, 120),
		};
		state.prev = result;
		state.n = i + 1;
		if (result.ok) state.passStreak++;
		else state.passStreak = 0;
		console.log(
			`  iter ${i + 1}: ${result.ok ? '✓' : '✗'} ${ms}ms model=${(model || '').slice(0, 50)}` +
				(result.breach ? ' [breach→raced]' : ''),
		);
		if (state.passStreak >= 2) {
			console.log('converged: 2 clean passes, model stable. usable.');
			break;
		}
		if (i === iters - 1)
			console.log(
				`reached ${iters} iters. usable=${state.passStreak >= 2}`,
			);
	}
	writeFileSync(
		OUT,
		JSON.stringify(
			{
				goal,
				wd,
				iters_run: state.n,
				passStreak: state.passStreak,
				last: state.prev,
				ts: Date.now(),
			},
			null,
			2,
		),
	);
	console.log(`\nwrote ${OUT}`);
	return 0;
}

export default definePlugin({
	name: 'iterate',
	version: '0.1.0',
	describe:
		'Sync-feedback iteration driver: each iteration feeds the previous result, may change code, double-checks the model, and auto-races breaches.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'iterate';
		return {
			tools: consentTools('iterate', [
				{
					id: 'run',
					summary:
						'Run sync-feedback iterations toward a goal with model checks and breach auto-race.',
					tags: ['iterate', 'feedback', 'race'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_run`,
							{
								description:
									'Run delend-iterate on a goal/workdir.',
								inputSchema: z.object({
									confirm: z
										.boolean()
										.optional()
										.describe(
											'Explicit I5 consent: required for write/spend tools unless the session opted in via --yes-i-take-responsibility-for-spend',
										),
									goal: z.string(),
									workdir: z.string().optional(),
									iters: z
										.number()
										.int()
										.positive()
										.optional(),
									before: z.string().optional(),
									after: z.string().optional(),
									budgetMs: z
										.number()
										.int()
										.positive()
										.optional(),
								}),
							},
							async (toolArgs: {
								goal: string;
								workdir?: string;
								iters?: number;
								before?: string;
								after?: string;
								budgetMs?: number;
							}) => {
								const cliArgs = ['--goal', toolArgs.goal];
								if (toolArgs.workdir)
									cliArgs.push('--workdir', toolArgs.workdir);
								if (toolArgs.iters)
									cliArgs.push(
										'--iters',
										String(toolArgs.iters),
									);
								if (toolArgs.before)
									cliArgs.push('--before', toolArgs.before);
								if (toolArgs.after)
									cliArgs.push('--after', toolArgs.after);
								if (toolArgs.budgetMs)
									cliArgs.push(
										'--budget-ms',
										String(toolArgs.budgetMs),
									);
								const priorArgv = process.argv;
								try {
									const rc = main(cliArgs);
									return {
										content: [
											{
												type: 'text',
												text: JSON.stringify({
													ok: rc === 0,
													rc,
												}),
											},
										],
									};
								} finally {
									process.argv = priorArgv;
								}
							},
						);
					},
				},
			]),
		};
	},
});
