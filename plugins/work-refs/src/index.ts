/**
 * @delendai/work-refs — Unified DelendAI plugin & drop-in Bun library for:
 *   - delend-quick (zero-friction staged/explicit work-ref checkpoint & push)
 *   - delend-working-dirty (dirty-tree snapshot, status, doctor)
 *   - delend-stash-optimize (undurable checkpoint, guarded stash-list & stash-pop)
 *   - shared delendai CLI driver (findRepoRoot, cleanId, workRef, identity, undurablePaths, checkpoint, statusText, work)
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

export interface ExecResult {
	status: number;
	stdout: string;
	stderr: string;
}

export interface CheckpointOptions {
	proposal?: string;
	slice?: string;
	kind?: string;
	topic?: string;
	message: string;
	agent?: string;
	paths: string[];
	generation?: number;
	workspace?: string;
}

export interface WorkStatus {
	profile?: string;
	integration?: string;
	dirty: number;
	undurable: string[];
	workRefTemplate?: string;
	publishedAhead?: string[];
	[k: string]: unknown;
}

const DELENDAI = 'delendai';

export function run(
	cmd: string,
	args: string[],
	cwd: string = process.cwd(),
): ExecResult {
	const p = Bun.spawnSync([cmd, ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env },
	});
	return {
		status: p.exitCode ?? 1,
		stdout: p.stdout.toString().trim(),
		stderr: p.stderr.toString().trim(),
	};
}

export function findRepoRoot(startDir: string = process.cwd()): string {
	let cur = resolve(startDir);
	const home = homedir();
	while (cur !== '/' && cur !== home) {
		if (existsSync(join(cur, '.git'))) return cur;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return resolve(startDir);
}

export function getChangedPaths(repoRoot: string): string[] {
	const res = run('git', ['status', '--porcelain'], repoRoot);
	if (res.status !== 0 || !res.stdout) return [];
	return res.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line
				.replace(/^[AMD?RCU\s]{1,3}\s+/, '')
				.split(' -> ');
			return parts[parts.length - 1]!.trim();
		})
		.filter((p) => !p.startsWith('.git') && !p.includes('__pycache__'));
}

export function getStagedPaths(repoRoot: string): string[] {
	const res = run('git', ['diff', '--cached', '--name-only', '-z'], repoRoot);
	if (res.status !== 0 || !res.stdout) return [];
	return res.stdout
		.split('\0')
		.filter(Boolean)
		.map((p) => p.trim())
		.filter((p) => !p.startsWith('.git') && !p.includes('__pycache__'));
}

export function cleanId(s: string, fallback = 'core'): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, '_')
			.replace(/^_+|_+$/g, '') || fallback
	);
}

export function workRef(
	agent: string,
	kind: string,
	proposal: string,
	slice: string,
	generation: number,
	topic: string,
): string {
	return `heads/wip/${cleanId(agent, 'toxic')}/${cleanId(kind, 'implement')}/${cleanId(proposal)}-${cleanId(slice)}-g${generation}/${cleanId(topic, 'work')}`;
}

export function identity(repoRoot: string): {
	agent: string;
	proposal: string;
	slice: string;
	topic: string;
} {
	return {
		agent: process.env.DELENDAI_AGENT_ID || 'toxic',
		proposal: cleanId(resolve(repoRoot).split('/').pop() || 'project'),
		slice: 'core',
		topic: 'work',
	};
}

export function undurablePaths(workspace?: string): string[] {
	const repo = workspace || findRepoRoot(process.cwd());
	const st = run(
		DELENDAI,
		['work', 'status', '--json', `--workspace=${repo}`],
		repo,
	);
	try {
		const d = JSON.parse(st.stdout) as WorkStatus;
		return Array.isArray(d.undurable) ? d.undurable : [];
	} catch {
		return [];
	}
}

export function checkpoint(
	opts: CheckpointOptions,
): ExecResult & { ref?: string; commit?: string } {
	const repo = opts.workspace || findRepoRoot(process.cwd());
	const id = identity(repo);
	const args = [
		'work',
		'checkpoint',
		`--workspace=${repo}`,
		`--agent=${opts.agent ?? id.agent}`,
		`--proposal=${opts.proposal ?? id.proposal}`,
		`--slice=${opts.slice ?? id.slice}`,
		`--kind=${opts.kind ?? 'implement'}`,
		`--topic=${opts.topic ?? id.topic}`,
		`--message=${opts.message}`,
	];
	if (opts.generation != null) args.push(`--generation=${opts.generation}`);
	if (opts.paths.length)
		args.push(`--paths=${opts.paths.slice(0, 1500).join(',')}`);
	const res = run(DELENDAI, args, repo);
	let ref: string | undefined;
	let commit: string | undefined;
	try {
		const parsed = JSON.parse(res.stdout) as {
			ref?: string;
			commit?: string;
			status?: string;
		};
		ref = parsed.ref;
		commit = parsed.commit;
	} catch {
		/* non-JSON stdout */
	}
	return { ...res, ref, commit };
}

export function statusText(workspace?: string): string {
	const repo = workspace || findRepoRoot(process.cwd());
	return run(DELENDAI, ['work', 'status', `--workspace=${repo}`], repo)
		.stdout;
}

export function work(
	sub: 'doctor' | 'publish' | 'retire' | 'swarm',
	args: string[] = [],
	workspace?: string,
): ExecResult {
	const repo = workspace || findRepoRoot(process.cwd());
	return run(DELENDAI, ['work', sub, `--workspace=${repo}`, ...args], repo);
}

// ─── unified delend main dispatcher ────────────────────────────────
// `main` is the single entry the corral `delend` dispatcher and the estate
// bin shims share. Existing delend-quick flag-style invocations keep working
// because argv[0] never starts with "-" for the bootstrapped quick case:
//   argv = ["-m", "msg", ...]              → quickMain
//   argv = ["checkpoint"|"status"|"doctor"] → dirty/status/doctor (dwd)
/**
 * Unified entry for the work-refs family. When argv[0] looks like a quick
 * flag we run quickMain (backwards-compatible with `delend-quick -m …`),
 * otherwise we accept the dirty/stash-style subcommands.
 */
export function main(
	argv: string[] = process.argv.slice(2),
): number | Promise<number> {
	const first = argv[0];
	if (!first || first.startsWith('-')) {
		return quickMain(argv);
	}
	switch (first) {
		case 'checkpoint':
		case 'status':
		case 'doctor':
			return workingDirtyMain(argv);
		case 'stash-list':
		case 'stash-pop':
			return stashOptimizeMain(argv);
		default:
			return quickMain(argv);
	}
}

// ─── delend-quick ───────────────────────────────────────────────────

export async function quickMain(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const args = argv;
	let message = '';
	let proposal = '';
	let slice = '';
	let topic = '';
	let explicitPaths: string[] = [];
	let doPush = true;
	let agent = process.env.DELENDAI_AGENT_ID || 'toxic';
	let workspaceOverride = '';

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		let key = arg;
		let val = '';
		if (arg.includes('=')) {
			const eqIdx = arg.indexOf('=');
			key = arg.slice(0, eqIdx);
			val = arg.slice(eqIdx + 1);
		}

		if (key === '-w' || key === '--workspace' || key === '--cwd') {
			workspaceOverride = val || args[++i] || '';
		} else if (key === '-m' || key === '--message') {
			message = val || args[++i] || '';
		} else if (key === '-p' || key === '--proposal') {
			proposal = val || args[++i] || '';
		} else if (key === '-s' || key === '--slice') {
			slice = val || args[++i] || '';
		} else if (key === '-t' || key === '--topic') {
			topic = val || args[++i] || '';
		} else if (key === '--agent') {
			agent = val || args[++i] || '';
		} else if (key === '--paths') {
			const raw = val || args[++i] || '';
			explicitPaths = raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (key === '--no-push') {
			doPush = false;
		} else if (key === '-h' || key === '--help') {
			console.log(`delend-quick: Universal DelendAI checkpoint & push helper (plugin: @delendai/work-refs)

Options:
  -m, --message <text>   Commit/checkpoint message (required)
  -p, --proposal <name>  Proposal ID (auto-inferred if omitted)
  -s, --slice <name>     Slice ID (default: 'core' or s1)
  -t, --topic <name>     Topic branch descriptor (default: 'work')
  --paths <a,b>          Specific paths to include (default: all changed/untracked)
  --agent <name>         Agent identity (default: $DELENDAI_AGENT_ID or 'toxic')
  --no-push              Skip pushing work-ref to remote
`);
			return 0;
		}
	}

	if (!message) {
		console.error('Error: --message (-m) is required.');
		return 1;
	}

	const repoRoot = workspaceOverride
		? resolve(workspaceOverride)
		: findRepoRoot(process.cwd());

	let paths: string[];
	if (explicitPaths.length > 0) {
		const staged = new Set(getStagedPaths(repoRoot));
		const resolved: string[] = [];
		for (const p of explicitPaths) {
			const rel = p.startsWith('/') ? relative(repoRoot, p) : p;
			const abs = resolve(repoRoot, rel);
			let isDir = false;
			try {
				isDir = existsSync(abs) && statSync(abs).isDirectory();
			} catch {
				isDir = false;
			}
			if (isDir && !staged.has(rel)) {
				const wantDir = rel.endsWith('/') ? rel : `${rel}/`;
				const matches = [...staged].filter((s) =>
					s.startsWith(wantDir),
				);
				if (matches.length > 0) resolved.push(...matches);
				else resolved.push(rel);
			} else {
				resolved.push(rel);
			}
		}
		paths = [...new Set(resolved)];
	} else {
		paths = getStagedPaths(repoRoot);
	}

	if (explicitPaths.length === 0 && paths.length === 0) {
		const dirty = getChangedPaths(repoRoot).length;
		if (dirty > 0) {
			console.error(
				`[delend-quick] Refused: ${dirty} dirty path(s) but none staged and no --paths given.\n` +
					`  Stage exactly what you intend (git add <path>) or pass --paths <a,b>.`,
			);
			return 1;
		}
	}

	if (paths.length === 0) {
		console.log(
			'No changed, staged, or untracked paths found to checkpoint.',
		);
		return 0;
	}

	const cap =
		explicitPaths.length > 0 || getStagedPaths(repoRoot).length > 0
			? 1500
			: 50;
	if (paths.length > cap) {
		console.warn(
			`[delend-quick] Warning: ${paths.length} path(s) exceed the ${cap} safety cap; narrowing.`,
		);
		paths = paths.slice(0, cap);
	}

	proposal = proposal
		? cleanId(proposal)
		: cleanId(repoRoot.split('/').pop() || 'project');
	slice = slice ? cleanId(slice) : 'core';
	topic = topic ? cleanId(topic) : 'work';

	console.log(`[delend-quick] Checkpointing in ${repoRoot}`);
	console.log(
		`[delend-quick] Ref: heads/wip/${agent}/implement/${proposal}-${slice}-g1/${topic}`,
	);
	console.log(`[delend-quick] Files: ${paths.length} path(s)`);

	const cpArgs = [
		'work',
		'checkpoint',
		`--workspace=${repoRoot}`,
		`--agent=${agent}`,
		`--proposal=${proposal}`,
		`--slice=${slice}`,
		`--topic=${topic}`,
		`--paths=${paths.join(',')}`,
		`--message=${message}`,
	];

	const cpRes = run(DELENDAI, cpArgs, repoRoot);
	let parsed:
		| { status?: string; reason?: string; ref?: string; commit?: string }
		| undefined;
	try {
		parsed = JSON.parse(cpRes.stdout);
	} catch {
		console.log(cpRes.stdout);
		if (cpRes.stderr) console.error(cpRes.stderr);
	}

	if (cpRes.status !== 0 || (parsed && parsed.status === 'failed')) {
		console.error(
			`[delend-quick] Checkpoint failed: ${parsed?.reason || cpRes.stderr || cpRes.stdout}`,
		);
		return 1;
	}

	const createdRef = parsed?.ref;
	console.log(
		`✔ [delend-quick] Checkpointed commit ${parsed?.commit?.slice(0, 10)} on ${createdRef}`,
	);

	if (doPush && createdRef) {
		console.log(`[delend-quick] Pushing ${createdRef} to origin...`);
		const pushRes = run('git', ['push', 'origin', createdRef], repoRoot);
		if (pushRes.status === 0) {
			console.log(`✔ [delend-quick] Pushed to remote successfully.`);
		} else {
			console.warn(
				`[delend-quick] Push warning: ${pushRes.stderr || pushRes.stdout}`,
			);
		}
	}
	return 0;
}

// ─── delend-working-dirty ───────────────────────────────────────────

export function workingDirtySnapshot(
	repo: string,
	message: string,
	paths: string[],
	push: boolean,
): number {
	const id = identity(repo);
	const targets = paths.length ? paths : undurablePaths(repo);
	if (targets.length === 0) {
		console.log('[dwd] no undurable paths to checkpoint — clean.');
		return 0;
	}
	const msg = message || `dwd-${repo.split('/').at(-1)}-${Date.now()}`;
	console.log(`[dwd] @ ${repo}`);
	console.log(
		`[dwd] checkpoint → ${id.proposal}-${id.slice}/${cleanId(msg)}  (${targets.length} path(s))`,
	);
	const res = checkpoint({
		proposal: id.proposal,
		slice: id.slice,
		topic: cleanId(msg),
		message: msg,
		agent: id.agent,
		paths: targets,
		workspace: repo,
	});
	if (res.status !== 0) {
		console.error(`[dwd] checkpoint failed: ${res.stderr || res.stdout}`);
		return 1;
	}
	console.log(`[dwd] -> ${res.stdout}`);
	if (push) {
		const branch =
			process.env.DELENDAI_WORK_BRANCH ||
			`wip/${id.agent}/implement/${id.proposal}-${id.slice}-g1/${cleanId(msg)}`;
		work('publish', [`--ref=${branch}`], repo);
		console.log(`[dwd] published ${branch}`);
	}
	return 0;
}

export function workingDirtyMain(
	argv: string[] = process.argv.slice(2),
): number {
	const cmd = argv[0] || 'status';
	const repo = findRepoRoot();
	const eqM = argv.find((a) => a.startsWith('-m='));
	const message = eqM
		? eqM.slice(3)
		: argv.includes('-m')
			? argv[argv.indexOf('-m') + 1] || ''
			: '';
	const paths = (argv.find((a) => a.startsWith('--paths=')) || '')
		.slice(8)
		.split(',')
		.filter(Boolean);
	const push = argv.includes('--push');

	switch (cmd) {
		case '--help':
		case '-h':
			console.log(`delend-working-dirty — delend-first snapshot/restore around a disruptive
operation (upstream weave merge, force-checkout) that demands a pristine tree.

Usage:
  delend-working-dirty checkpoint [-m label] [--paths=a,b] [--push]
  delend-working-dirty status
  delend-working-dirty doctor
`);
			return 0;
		case 'checkpoint':
			return workingDirtySnapshot(repo, message, paths, push);
		case 'status': {
			const txt = statusText(repo);
			if (txt) {
				console.log(txt);
				return 0;
			}
			return 1;
		}
		case 'doctor': {
			const r = work('doctor', [], repo);
			console.log(r.stdout || r.stderr);
			return r.status === 0 ? 0 : 1;
		}
		default:
			console.log(
				'usage: delend-working-dirty <checkpoint|status|doctor> [-m label] [--paths=a,b] [--push]',
			);
			return 2;
	}
}

// ─── delend-stash-optimize ──────────────────────────────────────────

export function stashCheckpointPaths(repo: string, paths: string[]): number {
	const id = identity(repo);
	const targets = paths.length ? paths : undurablePaths(repo);
	if (targets.length === 0) {
		console.log('[dso] nothing to checkpoint.');
		return 0;
	}
	const are = checkpoint({
		proposal: id.proposal,
		slice: id.slice,
		message: `delend-stash-optimize ${Date.now()}`,
		agent: id.agent,
		paths: targets,
		workspace: repo,
	});
	if (are.status !== 0) {
		console.error(`[dso] ${are.stderr || are.stdout}`);
		return 1;
	}
	console.log(`[dso] -> ${are.stdout}`);
	return 0;
}

export function stashList(repo: string): number {
	const r = run('git', ['stash', 'list'], repo);
	console.log(r.stdout || '(no stashes)');
	return 0;
}

export function stashPop(repo: string, ref: string): number {
	const stashes = run('git', ['stash', 'list'], repo)
		.stdout.split('\n')
		.filter((l) => l.startsWith(ref) || l.includes(ref));
	if (stashes.length === 0) {
		console.error(`[dso] no stash matching ${ref}`);
		return 1;
	}
	const show = run('git', ['stash', 'show', '-p', '--name-only', ref], repo)
		.stdout.split('\n')
		.filter(Boolean);
	const dirty = new Set(
		run('git', ['status', '--porcelain'], repo)
			.stdout.split('\n')
			.filter(Boolean)
			.map((l) => l.trim().replace(/^[A-Z?M{ ]+\s+/, '')),
	);
	const clash = show.filter((f) => dirty.has(f));
	if (clash.length > 0) {
		console.error(
			`[dso] refusing: pop would overwrite ${clash.length} dirty file(s) (${clash.slice(0, 3).join(', ')}...)`,
		);
		return 1;
	}
	const ap = run('git', ['stash', 'apply', ref], repo);
	if (ap.status !== 0) {
		console.error(`[dso] apply failed: ${ap.stderr}`);
		return 1;
	}
	console.log(`[dso] applied ${ref} (ref kept; drop explicitly when sure).`);
	return 0;
}

export function stashOptimizeMain(
	argv: string[] = process.argv.slice(2),
): number {
	const cmd = argv[0] || 'status';
	const repo = findRepoRoot();
	switch (cmd) {
		case '--help':
		case '-h':
			console.log(`delend-stash-optimize — delend-first reconciliation of working-tree work with
DelendAI durable work-refs.

Usage:
  delend-stash-optimize status                     # delendai work status
  delend-stash-optimize checkpoint [--paths=a,b]   # delendai checkpoint undurable
  delend-stash-optimize doctor                     # delendai workspace doctor
  delend-stash-optimize stash-list                 # list stashes (read-only)
  delend-stash-optimize stash-pop <ref>            # restore a stash iff safe
`);
			return 0;
		case 'status': {
			const txt = statusText(repo);
			if (txt) {
				console.log(txt);
				return 0;
			}
			return 1;
		}
		case 'checkpoint': {
			const p = (argv.find((a) => a.startsWith('--paths=')) || '')
				.slice(8)
				.split(',')
				.filter(Boolean);
			return stashCheckpointPaths(repo, p);
		}
		case 'doctor': {
			const r = work('doctor', [], repo);
			console.log(r.stdout || r.stderr);
			return r.status === 0 ? 0 : 1;
		}
		case 'stash-list':
			return stashList(repo);
		case 'stash-pop':
			return stashPop(repo, argv[1] || '');
		default:
			console.log(
				'usage: delend-stash-optimize <status|checkpoint|doctor|stash-list|stash-pop <ref>>',
			);
			return 2;
	}
}

// ─── DelendAI Plugin Registration ───────────────────────────────────

const OptionsSchema = z.object({
	defaultAgent: z.string().optional(),
});

export default definePlugin({
	name: 'work-refs',
	version: '0.1.0',
	describe:
		'Shared-checkout-merge work-ref checkpoint, dirty-tree snapshot, and guarded stash-optimize tools (delend-quick, delend-working-dirty, delend-stash-optimize).',
	optionsSchema: OptionsSchema,
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'work_refs';
		const wsRoot = ctx.workspace?.root || process.cwd();
		return {
			tools: [
				{
					id: 'quick_checkpoint',
					summary:
						'Checkpoint staged or explicit paths to a DelendAI work-ref and optionally push to origin.',
					tags: ['git', 'work-refs', 'checkpoint'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_quick_checkpoint`,
							{
								description:
									'Run delend-quick checkpoint on staged or explicit paths in a workspace.',
								inputSchema: z.object({
									message: z.string(),
									paths: z.array(z.string()).optional(),
									proposal: z.string().optional(),
									slice: z.string().optional(),
									topic: z.string().optional(),
									push: z.boolean().optional(),
									workspace: z.string().optional(),
								}),
							},
							async (toolArgs: {
								message: string;
								paths?: string[];
								proposal?: string;
								slice?: string;
								topic?: string;
								push?: boolean;
								workspace?: string;
							}) => {
								const cliArgs = [
									'-m',
									toolArgs.message,
									'--workspace',
									toolArgs.workspace || wsRoot,
								];
								if (toolArgs.paths?.length)
									cliArgs.push(
										'--paths',
										toolArgs.paths.join(','),
									);
								if (toolArgs.proposal)
									cliArgs.push('-p', toolArgs.proposal);
								if (toolArgs.slice)
									cliArgs.push('-s', toolArgs.slice);
								if (toolArgs.topic)
									cliArgs.push('-t', toolArgs.topic);
								if (toolArgs.push === false)
									cliArgs.push('--no-push');
								const rc = await quickMain(cliArgs);
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
				{
					id: 'dirty_status',
					summary:
						'Inspect or checkpoint undurable working-tree paths via DelendAI.',
					tags: ['git', 'work-refs', 'dirty'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_dirty_status`,
							{
								description:
									'Inspect or snapshot undurable paths in the workspace.',
								inputSchema: z.object({
									action: z
										.enum([
											'status',
											'checkpoint',
											'doctor',
										])
										.default('status'),
									message: z.string().optional(),
									paths: z.array(z.string()).optional(),
									push: z.boolean().optional(),
									workspace: z.string().optional(),
								}),
							},
							async (toolArgs: {
								action?: 'status' | 'checkpoint' | 'doctor';
								message?: string;
								paths?: string[];
								push?: boolean;
								workspace?: string;
							}) => {
								const ws = toolArgs.workspace || wsRoot;
								if (toolArgs.action === 'checkpoint') {
									const rc = workingDirtySnapshot(
										ws,
										toolArgs.message || '',
										toolArgs.paths || [],
										!!toolArgs.push,
									);
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
								}
								if (toolArgs.action === 'doctor') {
									const r = work('doctor', [], ws);
									return {
										content: [
											{
												type: 'text',
												text: JSON.stringify({
													ok: r.status === 0,
													out: r.stdout || r.stderr,
												}),
											},
										],
									};
								}
								const undurable = undurablePaths(ws);
								return {
									content: [
										{
											type: 'text',
											text: JSON.stringify({
												ok: true,
												workspace: ws,
												undurable,
												status: statusText(ws),
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
