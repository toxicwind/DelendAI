/**
 * @delendai/forge-audit — DelendAI plugin & drop-in Bun library for the attestation audit.
 *
 * Converts `estate/bin/delend-forge-audit` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

const here = dirname(new URL(import.meta.url).pathname);
export const FORGE =
	process.env.DELEND_AUDIT_FORGE ||
	'/home/toxic/estate/grasp-hub/skills/04_code_intelligence/code-patterns/src/cli.ts';
export const PAPER =
	process.env.DELEND_AUDIT_PAPER ||
	'/home/toxic/estate/grasp-hub/skills/02_research_intel/paper-search/bin/paper-search';
const OUT = process.env.DELEND_AUDIT_OUT || '/tmp/delend-forge-audit.json';

export function run(
	cmd: string,
	args: string[],
	cwd = process.cwd(),
	timeoutMs = 6000,
) {
	try {
		const p = Bun.spawnSync([cmd, ...args], {
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: timeoutMs,
			env: { ...process.env },
		});
		const timedOut = p.exitCode === null || p.signalCode === 'SIGTERM';
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

export function resolveQuery(args: string[]): string {
	const f = args.indexOf('--file');
	if (f >= 0) {
		const fp = args[f + 1]!;
		const [path, ln] = fp.split(':');
		if (!existsSync(path)) return fp;
		const lines = readFileSync(path, 'utf8').split('\n');
		if (ln) {
			const i = Number(ln) - 1;
			return `${path}:${ln}  "${(lines[i] || '').trim()}"`;
		}
		return `${path}  ${lines.slice(0, 6).join(' | ')}`;
	}
	const q = args.filter((a) => a !== '--file').join(' ');
	if (q) return q;
	try {
		const s = readFileSync(0, 'utf8').trim();
		return s || 'audit this pattern';
	} catch {
		return 'audit this pattern';
	}
}

export interface AuditVerdict {
	query: string;
	borrow: string;
	paper: string;
	retrieve: string;
	attested: boolean;
	summary: string;
}

export function auditCore(
	query: string,
	opts: { root?: string; forge?: string; paper?: string } = {},
): AuditVerdict {
	const forge = opts.forge || process.env.DELEND_AUDIT_FORGE || FORGE;
	const paper = opts.paper || process.env.DELEND_AUDIT_PAPER || PAPER;
	const root = opts.root || process.env.DELEND_AUDIT_ROOT || process.cwd();

	const borrow = run('bun', [forge, 'borrow', query]);
	const retrieve = run('bun', [
		forge,
		'retrieve',
		'--root',
		root,
		'--query',
		query,
	]);
	const paperLane = run('bash', [paper, query], process.cwd(), 10000);

	const attested =
		borrow.stdout.toLowerCase().includes('http') ||
		paperLane.stdout.toLowerCase().includes('arxiv') ||
		paperLane.stdout.toLowerCase().includes('http');

	return {
		query,
		borrow: borrow.stdout || borrow.stderr.slice(0, 600),
		paper: paperLane.stdout || paperLane.stderr.slice(0, 600),
		retrieve: retrieve.stdout || retrieve.stderr.slice(0, 600),
		attested,
		summary: attested
			? 'Well-attested (borrow/paper lanes surfaced sources). Reference them before editing.'
			: 'Not well-attested by borrow/paper lanes — treat the line as uncertain and race a rewrite (forge race).',
	};
}

export function render(v: AuditVerdict): string {
	return [
		`=== PATTERN-BORROW ===`,
		v.borrow || '  (no output)',
		`=== PAPER-FINDER ===`,
		v.paper || '  (no output)',
		`=== CODE-RETRIEVE ===`,
		v.retrieve || '  (no output)',
		`=== VERDICT ===`,
		`  ${v.summary}`,
		`  attested=${v.attested}`,
	].join('\n');
}

export function main(argv = process.argv.slice(2)): number {
	const args = argv;
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`delend-forge-audit — "I'm uncertain of this line" first-class audit (plugin: @delendai/forge-audit).

Usage:
  delend-forge-audit "<query or claim>"        # audit a concept/pattern
  delend-forge-audit --file <path>[:<line>]    # audit a file (or a single line)
  echo "..." | delend-forge-audit              # audit from stdin

Runs PATTERN-BORROW + CODE-RETRIEVE + PAPER-FINDER in parallel and consolidates an
evidence-backed verdict. Exits 0 when well-attested, 2 otherwise.

Env: DELEND_AUDIT_FORGE, DELEND_AUDIT_PAPER, DELEND_AUDIT_ROOT, DELEND_AUDIT_OUT
`);
		return 0;
	}
	const query = resolveQuery(args);
	console.error(`delend-forge-audit: "${query}"`);
	const v = auditCore(query);
	const w = { ...v, at: new Date().toISOString() };
	try {
		Bun.write(OUT, JSON.stringify(w, null, 2));
	} catch {
		/* non-fatal */
	}
	process.stdout.write(render(v) + '\n');
	return v.attested ? 0 : 2;
}

export default definePlugin({
	name: 'forge-audit',
	version: '0.1.0',
	describe:
		'Runs PATTERN-BORROW + CODE-RETRIEVE + PAPER-FINDER lanes and consolidates one evidence-backed attestation verdict.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'forge_audit';
		const wsRoot = ctx.workspace?.root || process.cwd();
		return {
			tools: [
				{
					id: 'audit',
					summary:
						'Attestation audit of a claim/concept/file via borrow + retrieve + paper lanes.',
					tags: ['audit', 'borrow', 'evidence'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_audit`,
							{
								description:
									'Run delend-forge-audit on a query or file line.',
								inputSchema: z.object({
									query: z.string(),
									root: z.string().optional(),
								}),
							},
							async (toolArgs: {
								query: string;
								root?: string;
							}) => {
								const v = auditCore(toolArgs.query, {
									root: toolArgs.root || wsRoot,
								});
								try {
									Bun.write(
										OUT,
										JSON.stringify(
											{
												...v,
												at: new Date().toISOString(),
											},
											null,
											2,
										),
									);
								} catch {
									/* non-fatal */
								}
								return {
									content: [
										{ type: 'text', text: render(v) },
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
