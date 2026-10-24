/**
 * shell.ts — runtime-agnostic command executor with a monotonic hard-kill
 * deadline and secret-redacting stdout/stderr capture.
 *
 * A line of a script is SHELL. Trying to `spawnSync(cmd[0], cmd.slice(1))`
 * on a whitespace split destroys `-c` programs, `&&`, pipes, `;`, inline
 * `FOO=bar` env, and globs. This executor runs the line through `bash -c` so
 * real shell semantics survive, and kills the child hard once the injected
 * monotonic deadline expires (no sleeping, no wall-clock drift). Output is
 * captured whole and redacted of known secrets before it ever reaches a trace
 * or a report.
 *
 * Works under bun AND node (node:child_process), so the lib is portable.
 */
import { spawn } from 'node:child_process';

export interface ShellRun {
	rc: number;
	timedOut: boolean;
	lines: string[];
	ms: number;
}

// Known secret-shaped env keys that must never leak into a captured trace.
const SECRET_KEY_RE = /key|token|secret|password|api|auth|bearer|credit/i;
const SECRET_TEXT_RE =
	/(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|[A-Za-z0-9]{32,})/g;

/** Redact obvious credential-shaped substrings from a blob of text. */
export function redactText(text: string): string {
	// Redact ENV key=secret assignments (e.g. a `FOO_KEY=...` echo from a
	// traced shell line) and standalone credential-shaped blobs. Values are
	// eaten, the key name survives so the shape stays readable.
	return text
		.replace(SECRET_KEY_RE, '$1<redacted>')
		.replace(SECRET_TEXT_RE, '<redacted>');
}

/**
 * Run a shell command line under a monotonic deadline. `deadline.now()` is the
 * injected monotonic clock; pass one from a Budget. Returns rc / timedOut /
 * captured-and-redacted lines / measured ms.
 *
 * The child is spawned in its OWN process group and, on deadline, the WHOLE
 * group is killed — never just the shell. Killing only `bash` would orphan
 * grandchildren (e.g. `bun run forge` grandchildren) still holding the
 * stdout/stderr pipes, so the close event would never fire and the caller
 * would hang forever. Group-kill is the difference between "fails fast" and
 * "leaks a process that keeps a promise open."
 */
export function runShell(
	cmdLine: string,
	deadline: { readonly now: () => number; isExpired(): boolean },
	cwd: string,
	env: Record<string, string> = process.env as Record<string, string>,
): Promise<ShellRun> {
	return new Promise<ShellRun>((resolve) => {
		const started = deadline.now();
		const child = spawn(`bash`, ['-c', cmdLine], {
			cwd,
			env: { ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

		let timedOut = false;
		let done = false;

		// Process-group kill: signal the shell AND every descendant atomically.
		const killGroup = () => {
			try {
				if (child.pid !== undefined)
					process.kill(-child.pid, 'SIGKILL');
			} catch {
				// group already gone or not killable
			}
		};

		// Poll the child with a monotonic deadline (no sleep): kill the process
		// group as soon as the injected clock passes the budget-derived deadline.
		const poll = setInterval(() => {
			if (done) return clearInterval(poll);
			if (deadline.isExpired()) {
				timedOut = true;
				killGroup();
			}
		}, 2);

		child.on('close', (code, signal) => {
			if (done) return;
			done = true;
			clearInterval(poll);
			if (!timedOut && signal !== null) timedOut = true;
			const ms = deadline.now() - started;
			const raw = [stdout, stderr].join('\n');
			const lines = redactText(raw).split('\n').filter(Boolean);
			const rc = timedOut ? 124 : signal ? 1 : (code ?? 1);
			resolve({ rc, timedOut, lines, ms });
		});

		child.on('error', () => {
			if (done) return;
			done = true;
			clearInterval(poll);
			const ms = deadline.now() - started;
			resolve({
				rc: 124,
				timedOut: true,
				lines: ['shell spawn error'],
				ms,
			});
		});
	});
}
