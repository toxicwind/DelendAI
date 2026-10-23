/**
 * @delendai/global-gh — DelendAI plugin & drop-in Bun library for the GLOBAL GitHub primitive.
 *
 * Converts `estate/bin/delend-gh` + `estate/bin/delend-branch-audit-for-main` into a
 * first-class DelendAI plugin (`definePlugin`) and importable Bun library.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

function gitIn(cwd: string, a: string[]) {
	const p = Bun.spawnSync(['git', ...a], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env },
	});
	if (p.exitCode !== 0)
		throw new Error(
			p.stderr.toString().trim().slice(0, 140) ||
				`git ${a[0]} failed rc=${p.exitCode}`,
		);
	return p.stdout.toString().trim();
}

function resolveRepo(target: string): string {
	let url = target;
	if (!/^(https?|git|ssh):\/\/|^git@/.test(url)) {
		url = /^[^/]+\/[^/]+$/.test(target)
			? `https://github.com/${target}.git`
			: target;
	}
	return url;
}

export function ghMain(target: string, rest: string[], keep: boolean): number {
	const url = resolveRepo(target);
	const cloneDir = mkdtempSync(join(tmpdir(), 'delend-gh-'));
	const work = join(cloneDir, 'r');
	const git = (args: string[]) => {
		const p = Bun.spawnSync(['git', ...args], {
			cwd: work,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env },
		});
		if (p.exitCode !== 0)
			throw new Error(
				p.stderr.toString().trim().slice(0, 160) ||
					`git ${args[0]} rc=${p.exitCode}`,
			);
		return p.stdout.toString().trim();
	};

	let result = '';
	try {
		const cl = Bun.spawnSync(['git', 'clone', '--quiet', url, 'r'], {
			cwd: cloneDir,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env },
		});
		if (cl.exitCode !== 0)
			throw new Error(
				cl.stderr.toString().trim().slice(0, 160) || 'clone failed',
			);
		const mode = rest[0] || 'audit-main';
		if (mode === 'audit-main') {
			const branches = git([
				'for-each-ref',
				'refs/remotes/origin',
				'--format=%(refname:short)',
			])
				.split('\n')
				.filter(
					(r) =>
						r.startsWith('origin/') &&
						!r.startsWith('origin/HEAD') &&
						r !== 'origin/main' &&
						r !== 'origin/master',
				);
			const def =
				git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
					.split('/')
					.pop() || 'main';
			const defRev = git(['rev-parse', `origin/${def}`]);
			const lines: string[] = [
				`delend-gh ${target} — remote ${git(['remote', 'get-url', 'origin']).split('\n')[0]}, default ${def}@${defRev.slice(0, 8)}`,
			];
			for (const b of branches) {
				const name = b.replace('origin/', '');
				let ahead = 0;
				let behind = 0;
				let state: string | undefined;
				try {
					const rr = git([
						'rev-list',
						'--left-right',
						'--count',
						`origin/${def}...${b}`,
					]).split(/\s+/);
					behind = Number(rr[0] || 0);
					ahead = Number(rr[1] || 0);
				} catch {
					state = '?';
				}
				state ??=
					ahead === 0
						? 'merged'
						: behind === 0
							? 'ahead'
							: 'diverged';
				lines.push(
					`  ${state === 'merged' ? '✓' : state === 'diverged' ? '✗' : '△'} ${name} (${ahead}a/${behind}b) [${state}]`,
				);
			}
			result = lines.join('\n');
		} else if (mode === 'raw') {
			const p = rest[1];
			const def =
				git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
					.split('/')
					.pop() || 'main';
			const blob = Bun.spawnSync(['git', 'show', `origin/${def}:${p}`], {
				cwd: work,
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...process.env },
			});
			result =
				blob.exitCode === 0
					? blob.stdout.toString()
					: `(not found on default branch)`;
		} else {
			result = git(rest);
		}
	} catch (e: any) {
		console.error('delend-gh error:', String(e.message || e).slice(0, 200));
		if (!keep) rmSync(cloneDir, { recursive: true, force: true });
		return 1;
	}
	console.log(result);
	if (keep) console.log(`\n(clone kept at ${work})`);
	else rmSync(cloneDir, { recursive: true, force: true });
	return 0;
}

export function branchAuditMain(argv: string[]): number {
	const gv = (f: string) =>
		argv.includes(f) ? argv[argv.indexOf(f) + 1] || null : null;
	const repo = gv('--repo') || process.cwd();
	const mainBranch = gv('--main') || 'main';
	const only = gv('--only');
	const mergeReady = argv.includes('--merge-ready');
	const doPush = argv.includes('--push');

	let cwd: string = repo;
	let isClone = false;
	let cloneDir = '';
	try {
		if (/^(https?|git|ssh):\/\/|^git@|^gh:/.test(repo)) {
			cloneDir = mkdtempSync(join(tmpdir(), 'branch-audit-'));
			gitIn(cloneDir, ['clone', '--quiet', repo, 'upstream']);
			cwd = join(cloneDir, 'upstream');
			isClone = true;
		} else if (!existsSync(join(repo, '.git'))) {
			console.error(`not a repo / bad path or URL: ${repo}`);
			return 2;
		}
	} catch (e: any) {
		console.error(
			`clone/open failed: ${String((e as Error).message || e).slice(0, 140)}`,
		);
		return 2;
	}

	const g = (a: string[]) => gitIn(cwd, a);
	const rev = (branch: string) => {
		try {
			return g(['rev-parse', branch]);
		} catch {
			return null;
		}
	};
	const mainRev = rev(mainBranch);
	if (!mainRev) {
		console.error(`default branch '${mainBranch}' not found; use --main`);
		if (isClone) rmSync(cloneDir, { recursive: true, force: true });
		return 2;
	}

	const remotes = g([
		'for-each-ref',
		'refs/remotes',
		`--format=%(refname:short)`,
	])
		.split('\n')
		.filter((r) => r.startsWith('origin/') && !r.startsWith('origin/HEAD'));

	const report: any[] = [];
	for (const rname of remotes) {
		const name = rname.replace(/^origin\//, '');
		if (only && !name.includes(only)) continue;
		if (name === mainBranch) continue;
		let ahead = 0;
		let behind = 0;
		let state = 'merged';
		try {
			const rr = g([
				'rev-list',
				'--left-right',
				'--count',
				`${mainBranch}...${rname}`,
			]).split(/\s+/);
			behind = Number(rr[0] || 0);
			ahead = Number(rr[1] || 0);
		} catch {
			state = 'unresolvable';
		}
		if (state !== 'unresolvable')
			state =
				ahead === 0
					? 'merged'
					: behind === 0
						? 'ahead-clean'
						: 'diverged';
		report.push({ branch: name, ahead, behind, state });
	}

	console.log('=== delend-branch-audit-for-main ===');
	console.log(
		`repo: ${repo}${isClone ? ' (cloned to temp)' : ''}  main=${mainBranch}@${mainRev.slice(0, 8)}  [${g(['remote', 'get-url', 'origin']).split('\n')[0] || 'no-origin'}]`,
	);
	for (const r of report) {
		const icon =
			r.state === 'merged'
				? '✓'
				: r.state === 'diverged'
					? '✗'
					: r.state === 'ahead-clean'
						? '△'
						: '?';
		console.log(
			`  ${icon} ${r.branch}  (${r.ahead} ahead / ${r.behind} behind) [${r.state}]`,
		);
	}
	const div = report.filter((r) => r.state === 'diverged').length;
	const merged = report.filter((r) => r.state === 'merged').length;
	const clean = report.filter((r) => r.state === 'ahead-clean').length;
	console.log(
		`\n  summary: ${merged} merged · ${clean} ahead-clean · ${div} diverged (need reconcile, not force) · ${isClone ? 'read-only clone (no push unless --push)' : ''}`,
	);

	if (mergeReady) {
		console.log(
			'\n-- merge-ready: land non-diverged ahead-clean branches into ' +
				mainBranch +
				' --',
		);
		for (const r of report) {
			if (r.state === 'ahead-clean') {
				const msg = `merge(${r.branch}): land ahead-clean branch (delend-branch-audit-for-main)`;
				if (doPush || !isClone) {
					try {
						g([
							'merge',
							'--no-ff',
							`origin/${r.branch}`,
							'-m',
							msg,
						]);
						console.log(`  merged ${r.branch}`);
					} catch (e: any) {
						console.log(
							`  SKIP ${r.branch}: ${String((e as Error).message || e).slice(0, 90)}`,
						);
					}
				} else {
					console.log(
						`  would-merge ${r.branch} (clone read-only; use --push on a real checkout to apply)`,
					);
				}
			}
		}
		if (doPush) {
			try {
				g(['push', 'origin', mainBranch]);
				console.log('  pushed ' + mainBranch);
			} catch (e: any) {
				console.log(
					'  push blocked:',
					String((e as Error).message || e).slice(0, 90),
				);
			}
		}
	}

	if (isClone) rmSync(cloneDir, { recursive: true, force: true });
	return 0;
}

export function main(argv = process.argv.slice(2)): number {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`delend-gh — GLOBAL GitHub primitive (any org/repo, not just toxicwind). (plugin: @delendai/global-gh)

Usage:
  delend-gh <org/repo|url> "<git args...>"     # run git in a temp clone, print output
  delend-gh <org/repo> audit-main              # alias: branch audit vs its default main
  delend-gh <org/repo> raw <path>              # print a file's content from the upstream default branch
  --keep                                       # keep the temp clone; print its path

Global by construction: works for ANY host (github.com, gitlab, codeberg, self-hosted URL).
Also: delend-branch-audit-for-main --repo <path|url> [--main main] [--only s] [--merge-ready] [--push]
`);
		return 0;
	}
	const target = argv[0];
	if (!target) {
		console.error(
			"usage: delend-gh <org/repo|url> [git-args|'audit-main'|'raw <path>'] [--keep]",
		);
		return 2;
	}
	const rest = argv.slice(1);
	const keep = rest.includes('--keep');
	const cleanRest = rest.filter((x) => x !== '--keep');
	return ghMain(target, cleanRest, keep);
}

export default definePlugin({
	name: 'global-gh',
	version: '0.1.0',
	describe:
		'GLOBAL GitHub primitive: clone any org/repo/URL to a temp dir, audit branches vs the default head, read raw files, or run arbitrary git.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'gh';
		return {
			tools: [
				{
					id: 'run',
					summary:
						'Run delend-gh on any org/repo/URL: audit-main, raw <path>, or arbitrary git args.',
					tags: ['github', 'git', 'global'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_run`,
							{
								description:
									'Run the global GitHub primitive on a target repo.',
								inputSchema: z.object({
									target: z.string(),
									mode: z
										.enum(['audit-main', 'raw', 'git'])
										.optional(),
									path: z.string().optional(),
									gitArgs: z.array(z.string()).optional(),
									keep: z.boolean().optional(),
								}),
							},
							async (toolArgs: {
								target: string;
								mode?: 'audit-main' | 'raw' | 'git';
								path?: string;
								gitArgs?: string[];
								keep?: boolean;
							}) => {
								const rest: string[] = [];
								if (toolArgs.mode === 'raw')
									rest.push('raw', toolArgs.path || '');
								else if (toolArgs.mode === 'git')
									rest.push(...(toolArgs.gitArgs || []));
								else rest.push('audit-main');
								if (toolArgs.keep) rest.push('--keep');
								const lines: string[] = [];
								const origLog = console.log;
								const origError = console.error;
								console.log = (...a) => lines.push(a.join(' '));
								console.error = (...a) =>
									lines.push('ERROR: ' + a.join(' '));
								let rc: number;
								try {
									rc = ghMain(
										toolArgs.target,
										rest,
										!!toolArgs.keep,
									);
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
				{
					id: 'branch_audit',
					summary:
						'Audit branches vs main (and optionally merge ahead-clean branches) for any repo.',
					tags: ['github', 'git', 'audit'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_branch_audit`,
							{
								description:
									'Run delend-branch-audit-for-main on a repo.',
								inputSchema: z.object({
									repo: z.string().optional(),
									main: z.string().optional(),
									only: z.string().optional(),
									mergeReady: z.boolean().optional(),
									push: z.boolean().optional(),
								}),
							},
							async (toolArgs: {
								repo?: string;
								main?: string;
								only?: string;
								mergeReady?: boolean;
								push?: boolean;
							}) => {
								const cliArgs: string[] = [];
								if (toolArgs.repo)
									cliArgs.push('--repo', toolArgs.repo);
								if (toolArgs.main)
									cliArgs.push('--main', toolArgs.main);
								if (toolArgs.only)
									cliArgs.push('--only', toolArgs.only);
								if (toolArgs.mergeReady)
									cliArgs.push('--merge-ready');
								if (toolArgs.push) cliArgs.push('--push');
								const lines: string[] = [];
								const origLog = console.log;
								const origError = console.error;
								console.log = (...a) => lines.push(a.join(' '));
								console.error = (...a) =>
									lines.push('ERROR: ' + a.join(' '));
								let rc: number;
								try {
									rc = branchAuditMain(cliArgs);
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
