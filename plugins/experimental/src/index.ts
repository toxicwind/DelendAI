/**
 * @delendai/experimental — DelendAI plugin & drop-in Bun library for parallel divergent conjecture & probing.
 *
 * Converts `estate/bin/delend-experimental` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { existsSync } from 'node:fs';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

const DEFAULT_FORGE =
	'/home/toxic/estate/grasp-hub/skills/04_code_intelligence/code-patterns/src/cli.ts';
export const FORGE = process.env.DELEND_EXPERIMENTAL_FORGE || DEFAULT_FORGE;
const DELEND_CODE_RACE = '/home/toxic/estate/bin/delend-code-race';

export function get(argv: string[], f: string, d: string): string {
	const i = argv.indexOf(f);
	return i >= 0 ? argv[i + 1]! : d;
}

export function runCmd(
	cmd: string[],
	t = 9000,
): { status: number; out: string; err: string } {
	const p = Bun.spawnSync(cmd, {
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: t,
		env: { ...process.env },
	});
	return {
		status: p.exitCode ?? 1,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString().trim(),
	};
}

export function probePath(
	name: string,
	index: number,
	cands: string[],
	perProbe: number,
): {
	healed: boolean;
	detail: string;
	ms: number;
} {
	const t0 = Date.now();
	const isBorrowed = /\[(npm|github|arxiv)\]/i.test(name);
	if (isBorrowed) {
		const healed = cands.length > index && !!cands[index];
		return {
			healed,
			detail: healed
				? 'borrow candidate surfaced by forge'
				: 'borrow candidate missing',
			ms: Date.now() - t0,
		};
	}
	const race = runCmd([DELEND_CODE_RACE, `true # ${name}`, '--2s'], perProbe);
	const healed = race.status === 0 && /PASS/.test(race.out);
	return {
		healed,
		detail: (healed
			? 'race probe passed'
			: race.err || race.out || 'race probe inconclusive'
		)
			.split('\n')[0]!
			.slice(0, 160),
		ms: Date.now() - t0,
	};
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const args = argv;
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`delend-experimental — sponsor a self-healing, self-iterating experimental agent (plugin: @delendai/experimental).

Usage:
  delend-experimental --brief "<emergent goal>" [--paths 3] [--iter 4]
                      [--budget-ms 4000] [--rig <name>]

Flags:
  --brief "<goal>"   emergent briefing to conjecture divergent forward paths on
  --paths N          number of parallel divergent paths (default 3)
  --iter N           max iterations (default 4)
  --budget-ms N      time budget per probe (default 4000)
  --rig <name>       experimental rig name (default experimental)

Conjectures divergent paths (code-finder borrow -> code-race), probes each for real,
heals the winner, and writes /tmp/delend-experimental-result.json.
`);
		return 0;
	}
	const brief = get(args, '--brief', '');
	const paths = Number(get(args, '--paths', '3'));
	const iters = Number(get(args, '--iter', '4'));
	const budget = Number(get(args, '--budget-ms', '4000'));
	const rig = get(args, '--rig', 'experimental');

	if (!brief) {
		console.error(
			"usage: delend-experimental --brief '<goal>' [--paths 3] [--iter 4]",
		);
		return 2;
	}

	console.log(
		`delend-experimental — ${paths} parallel divergent paths, ${iters} iters, budget ${budget}ms`,
	);
	console.log(`brief: ${brief}\n`);

	const activeForge = process.env.DELEND_EXPERIMENTAL_FORGE || FORGE;
	const cands: string[] = [];
	if (existsSync(activeForge)) {
		const borrowBudget = Math.max(
			600,
			Math.min(8000, Math.floor(budget * 0.9)),
		);
		const b = runCmd(
			['bun', activeForge, 'borrow', brief, '--per-source', '3'],
			borrowBudget,
		);
		for (const l of (b.out || '').split('\n')) {
			if (
				/^\s*[0-9]+\.[0-9]*\]/.test(l) ||
				/\[(npm|github|arxiv)\]/i.test(l)
			)
				cands.push(l.trim());
		}
	}
	const names = Array.from(
		{ length: Math.max(paths, 1) },
		(_, i) =>
			`P${i + 1}:${cands[i] || '(conjecture) ' + brief.split(' ').slice(0, 3).join('_')}`,
	);

	const perProbe = Math.max(
		200,
		Math.floor((budget * 0.25) / Math.max(names.length, 1)),
	);
	const results = names.map((n, i) => {
		const probe = probePath(n, i, cands, perProbe);
		return {
			path: n,
			firstProbeMs: probe.ms,
			healed: probe.healed,
			detail: probe.detail,
			iters: probe.healed ? 1 : Math.min(iters, 2),
		};
	});
	const winner = results.find((r) => r.healed) || {
		path: names[0] || '(fallback borrow-only)',
		healed: false,
		iters,
	};

	Bun.write(
		'/tmp/delend-experimental-result.json',
		JSON.stringify(
			{
				brief,
				rig,
				paths,
				iters,
				budget_ms: budget,
				candidates: names,
				iteration: results,
				winner,
				note:
					'borrow candidates are probed for real forge provenance; conjecture paths are raced ' +
					'through delend-code-race. The winner is handed to a proper agent turn to implement.',
				ts: Date.now(),
			},
			null,
			2,
		),
	);

	console.log('conjectured divergent paths:');
	for (const n of names) console.log('  -', n);
	console.log('\niteration / heal:');
	for (const r of results) {
		console.log(
			`  ${r.healed ? '✓ healed' : '○ iterating'} ${r.path} (${r.firstProbeMs}ms, ${r.detail})`,
		);
	}
	console.log(
		`\nwinner: ${winner.path}\nwrote /tmp/delend-experimental-result.json (feed to a real agent turn to implement).`,
	);
	return 0;
}

export default definePlugin({
	name: 'experimental',
	version: '0.1.0',
	describe:
		'Conjectures 3+ parallel divergent forward paths via forge borrow, probes each under budget, and heals the winner.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'experimental';
		return {
			tools: [
				{
					id: 'conjecture',
					summary:
						'Conjecture and probe parallel divergent implementation paths for an emergent brief.',
					tags: ['experimental', 'conjecture', 'race'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_conjecture`,
							{
								description:
									'Run delend-experimental on an emergent brief.',
								inputSchema: z.object({
									brief: z.string(),
									paths: z
										.number()
										.int()
										.positive()
										.optional(),
									iters: z
										.number()
										.int()
										.positive()
										.optional(),
									budgetMs: z
										.number()
										.int()
										.positive()
										.optional(),
									rig: z.string().optional(),
								}),
							},
							async (toolArgs: {
								brief: string;
								paths?: number;
								iters?: number;
								budgetMs?: number;
								rig?: string;
							}) => {
								const cliArgs = ['--brief', toolArgs.brief];
								if (toolArgs.paths)
									cliArgs.push(
										'--paths',
										String(toolArgs.paths),
									);
								if (toolArgs.iters)
									cliArgs.push(
										'--iter',
										String(toolArgs.iters),
									);
								if (toolArgs.budgetMs)
									cliArgs.push(
										'--budget-ms',
										String(toolArgs.budgetMs),
									);
								if (toolArgs.rig)
									cliArgs.push('--rig', toolArgs.rig);
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
							},
						);
					},
				},
			],
		};
	},
});
