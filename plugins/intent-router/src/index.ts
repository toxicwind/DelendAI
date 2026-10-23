/**
 * @delendai/intent-router — DelendAI plugin & drop-in Bun library for the zero* fast-intent router.
 *
 * Converts `estate/bin/delend-route` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { definePlugin } from '@delendai/core/plugin';
import { consentTools } from '@delendai/consent';
import { z } from 'zod';

const BIN = '/home/toxic/estate/bin';

export const ROUTES: Record<string, string[]> = {
	'delend-gh': [
		'global github',
		'upstream',
		'foreign repo',
		'not toxicwind',
		'clone.*audit',
		'any org',
		'clone that',
	],
	'delend-branch-audit-for-main': [
		'branch',
		'audit branches',
		'merged',
		'diverged',
		'ahead of main',
		'reconcile.*main',
		'clean.*main',
	],
	'delend-code-race': [
		'breach',
		'timed',
		'timeout',
		'too slow',
		'sub-4s',
		'at 4s',
		'4s',
		'4 sec',
		'race.*faster',
		'slow command',
		'faster alt',
	],
	'delend-experimental': [
		'emergen',
		'conjecture',
		'3 parallel',
		'divergent',
		'whoa',
		'experimental fwd',
		'self-heal',
	],
	'delend-iterate': [
		'iterate',
		'10x',
		'feeds.*previous',
		'model-checked',
		'sync-feedback',
		'--iters',
	],
	'delend-oracle': [
		'oracle',
		'market',
		'intake',
		'bid',
		'find more',
		'task.*award',
		'delend-oracle',
	],
	'delend-quick': [
		'checkpoint',
		'publish work-ref',
		'work-ref',
		'delendai',
		'commit.*guard',
		'shared-checkout',
	],
	'delend-stash-optimize': ['stash', 'stash-optimize', 'stacked unit'],
	'delend-working-dirty': [
		'dirty tree',
		'working tree',
		'uncommitted',
		'check.*dirty',
	],
	'delend-forge-audit': [
		'forge.*audit',
		'pattern audit',
		'borrow.*audit',
		'ast-grep.*claim',
	],
	'delend-model-race': [
		'model',
		'which model',
		'eap',
		'theta',
		'hodos',
		'provider.*race',
	],
};

export function classify(txt: string): { name: string; match: string } | null {
	const t = txt.toLowerCase();
	for (const [name, pats] of Object.entries(ROUTES)) {
		for (const p of pats) {
			if (new RegExp(p, 'i').test(t)) return { name, match: p };
		}
	}
	return null;
}

export async function routeWhere(q: string): Promise<string> {
	const has = (s: string) => q.includes(s);
	const lines: string[] = [];
	if (has('port') || /\b25\d{3}\b/.test(q)) {
		const port =
			q.match(/25\d{3}/)?.[0] ||
			(has('hodos')
				? '25193'
				: has('squawk')
					? '25147'
					: has('feed')
						? '25135'
						: has('gatehouse')
							? '25127'
							: has('oracle')
								? '25151'
								: has('mbx')
									? '25148'
									: has('ranch-ui')
										? '25218'
										: has('doorbell')
											? '25217'
											: null);
		if (port) {
			const svc = has('hodos')
				? 'hodos model-proxy'
				: has('squawk')
					? 'squawk-ws fleet'
					: has('feed')
						? 'squawk-feed'
						: has('gatehouse')
							? 'gatehouse mcp'
							: has('oracle')
								? 'oracle-market'
								: has('mbx')
									? 'mbx build-cache'
									: has('ranch-ui')
										? 'ranch-ui dashboard'
										: has('doorbell')
											? 'doorbell oauth-entry'
											: null;
			lines.push(
				`port ${port}: ${svc ? `→ route to: ${svc} (${port})` : 'in 25xxx range'}`,
			);
		}
	}
	if (has('zero')) {
		if (has('pcie') || has('copy'))
			lines.push(
				'  zero-* → true-zero-copy-pcie-streaming (PCIe GPU skill)',
			);
		else
			lines.push(
				'  zero-* → zero-transport (libzero_transport.so, SPSC ring; see docs/zero-primitives-register.md)',
			);
	}
	const dm = q.match(/daemon\s+([\w-]+)/);
	if (dm) {
		const cmd = `/home/toxic/estate/pitchfork.d/${dm[1]!.replace(/^estate\//, '')}.toml`;
		try {
			const { existsSync } = await import('node:fs');
			lines.push(
				`daemon ${dm[1]}: config ${cmd} exists=${existsSync(cmd)} → route to pitchfork ${cmd}`,
			);
		} catch {
			lines.push(`daemon ${dm[1]}: config ${cmd}`);
		}
	}
	if (has('delend')) {
		const which = Object.keys(ROUTES).find((n) =>
			q.includes(n.replace('delend-', '')),
		);
		lines.push(
			which ? `primitive → ${which}` : 'primitive → delend-route --list',
		);
	}
	return lines.length
		? lines.join('\n')
		: `--where: no match for "${q}" (try: port 25148 / daemon squawk-ws / zero / hodos / delend)`;
}

export function main(argv = process.argv.slice(2)): number {
	const flags = argv;
	if (flags.includes('--help') || flags.includes('-h')) {
		console.log(`delend-route — the zero* fast-intent router for delend (plugin: @delendai/intent-router).

Usage:
  delend-route "<incoming instruction>"          # classify + print the routed plan
  delend-route --run "<instruction>"             # also execute the routed primitive
  delend-route --list                            # show the route table
  delend-route --where '<port|daemon|zero|25xxx>'  # route to a LIVE estate resource

Fast-understands an incoming instruction and dispatches it to the correct delend-*
primitive, first-valid-wins, sub-4s.
`);
		return 0;
	}
	const run = flags.includes('--run');
	const list = flags.includes('--list');
	const arg = flags.filter((x) => !x.startsWith('--')).join(' ');

	if (list) {
		console.log('=== delend-route table ===');
		for (const [name, pats] of Object.entries(ROUTES))
			console.log(`  ${name}  <~ ${pats.join(' | ')}`);
		console.log('\n-- resources (estate source-of-truth routing) --');
		console.log(
			"  delend-route --where '<port|daemon|zero|25xxx>'  -> routes to the LIVE resource",
		);
		return 0;
	}

	if (flags.includes('--where')) {
		const q = flags[flags.indexOf('--where') + 1] || '';
		routeWhere(q).then((out) => {
			console.log(out);
		});
		return 0;
	}

	if (!arg) {
		console.error(
			"usage: delend-route ['<instruction>'|--run '<instruction>'|--list]",
		);
		return 2;
	}
	const r = classify(arg);
	if (!r) {
		console.log(
			`delend-route: NO MATCH for "${arg}" — try --list, or hand it to delend-experimental.`,
		);
		return 1;
	}
	console.log(`delend-route "${arg}" -> ${r.name} (matched: ${r.match})`);
	if (run) {
		const p = Bun.spawnSync(
			['bun', BIN + '/' + r.name, ...arg.split(' ')],
			{
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 20000,
				env: { ...process.env },
			},
		);
		console.log(
			(p.stdout.toString() || p.stderr.toString() || '').slice(0, 1500),
		);
		return p.exitCode ?? 1;
	}
	return 0;
}

export default definePlugin({
	name: 'intent-router',
	version: '0.1.0',
	describe:
		'Fast-intent router: classifies an instruction to the right delend-* primitive, with --run dispatch and --where live-resource routing.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'intent';
		return {
			tools: consentTools('intent-router', [
				{
					id: 'classify',
					summary:
						'Classify an incoming instruction to the correct delend-* primitive.',
					tags: ['router', 'intent', 'classify'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_classify`,
							{
								description:
									'Classify an instruction to a delend-* primitive.',
								inputSchema: z.object({
									instruction: z.string(),
								}),
							},
							async (toolArgs: { instruction: string }) => {
								const r = classify(toolArgs.instruction);
								if (!r) {
									return {
										content: [
											{
												type: 'text',
												text: JSON.stringify({
													match: null,
													hint: 'try --list, or hand it to experimental',
												}),
											},
										],
									};
								}
								return {
									content: [
										{
											type: 'text',
											text: JSON.stringify({
												match: {
													name: r.name,
													pattern: r.match,
												},
											}),
										},
									],
								};
							},
						);
					},
				},
				{
					id: 'where',
					summary:
						'Route a port/daemon/zero/delend query to the live estate resource.',
					tags: ['router', 'resources', 'ports'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_where`,
							{
								description:
									'Route a resource query to the live estate resource.',
								inputSchema: z.object({
									query: z.string(),
								}),
							},
							async (toolArgs: { query: string }) => {
								const out = await routeWhere(toolArgs.query);
								return {
									content: [{ type: 'text', text: out }],
								};
							},
						);
					},
				},
				{
					id: 'run',
					summary:
						'Classify and execute the routed delend-* primitive.',
					tags: ['router', 'execute'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_run`,
							{
								description:
									'Classify and execute the routed primitive on an instruction.',
								inputSchema: z.object({
									confirm: z
										.boolean()
										.optional()
										.describe(
											'Explicit I5 consent: required for write/spend tools unless the session opted in via --yes-i-take-responsibility-for-spend',
										),
									instruction: z.string(),
								}),
							},
							async (toolArgs: { instruction: string }) => {
								const priorArgv = process.argv;
								try {
									const rc = main([
										'--run',
										toolArgs.instruction,
									]);
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
