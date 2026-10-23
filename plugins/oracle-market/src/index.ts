/**
 * @delendai/oracle-market — DelendAI plugin & drop-in Bun library for the recursive oracle market loop.
 *
 * Converts `estate/bin/delend-oracle` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import {
	watch as fsWatch,
	existsSync,
	readFileSync,
	appendFileSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

export const ORACLE =
	process.env.DELEND_ORACLE_DIR || '/home/toxic/estate/ranch/squawk/oracle';
export const ORACLE_WORK = join(ORACLE, 'work');
export const POST_INTAKE = join(ORACLE, 'bin', 'post_intake.py');
export const LEDGER =
	process.env.DELEND_ORACLE_LEDGER || join(ORACLE, 'ledger', 'ledger.jsonl');
export const HINDSIGHT =
	process.env.DELEND_ORACLE_HINDSIGHT || join(ORACLE, 'hindsight.md');
export const TRANSCRIPT =
	process.env.DELEND_ORACLE_TRANSCRIPT || '/tmp/delend-oracle-loop.jsonl';
export const DELEND_EXPERIMENTAL =
	process.env.DELEND_EXPERIMENTAL_BIN ||
	'/home/toxic/estate/bin/delend-experimental';
export const DELEND_ITERATE =
	process.env.DELEND_ITERATE_BIN || '/home/toxic/estate/bin/delend-iterate';

export const PROBE_MS = 3500;
export const LEDGER_POLL_MS = parseInt(
	process.env.DELEND_ORACLE_POLL_MS || '2500',
	10,
);
export const LEDGER_POLL_TAIL_MS = 500;
export const LEDGER_POLL_STEP_MS = 50;
export const APPLY_BUDGET_MS = parseInt(
	process.env.DELEND_ORACLE_APPLY_MS || '2500',
	10,
);

export function run(
	cmd: string[],
	env?: Record<string, string>,
	timeoutMs = PROBE_MS,
) {
	const p = Bun.spawnSync(cmd, {
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs,
		env: { ...process.env, ...(env || {}) } as Record<string, string>,
	});
	return {
		status: p.exitCode ?? 1,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString().trim(),
		killed: p.signalCode === 'SIGTERM' || p.signalCode === 'SIGKILL',
	};
}

export function readHindsight(): string {
	if (!existsSync(HINDSIGHT)) return '';
	try {
		const txt = readFileSync(HINDSIGHT, 'utf8').trim();
		if (!txt) return '';
		return txt.slice(0, 4000);
	} catch {
		return '';
	}
}

export function ensureHindsight() {
	if (!existsSync(HINDSIGHT)) {
		try {
			Bun.write(
				HINDSIGHT,
				'# hindsight\n\nDelend-oracle recursive emergent context (seeded).\n',
			);
		} catch {
			/* best-effort */
		}
	}
}

const isHeader = (l: string) => /^#{1,6}\s/.test(l);
const isOpenHeader = (l: string) => /^#{1,2}\s*Open\b/i.test(l);
const isDoneHeader = (l: string) => /^#{1,2}\s*Done\b/i.test(l);
const isMandateHeader = (l: string) => /^#{1,2}\s*Mandate\b/i.test(l);
const boldLead = (l: string): string | null => {
	const b = l.match(/^\s*[-*]\s+\*\*(.+?)\*\*(?::.*)?\s*$/);
	return b ? b[1]!.trim() : null;
};
const leadOf = (item: string): string => {
	const b = item.match(/^\*\*(.+?)\*\*(?::|\s|$)/);
	return (b ? b[1] : item).trim();
};

export function parseOpenItems(md: string): string[] {
	const items: string[] = [];
	let inOpen = false;
	for (const raw of md.split('\n')) {
		if (isHeader(raw)) {
			inOpen = isOpenHeader(raw);
			continue;
		}
		if (!inOpen) continue;
		const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
		if (bullet) items.push(bullet[1]!.trim());
		else if (raw.trim() && items.length)
			items[items.length - 1] += ' ' + raw.trim();
	}
	return items.filter(Boolean);
}

export function extractNextOpenTask(hindsight: string): string {
	const first = parseOpenItems(hindsight)[0];
	return first ? leadOf(first) : '';
}

export function recordApplied(md: string, task: string, note: string): string {
	if (!task) return md;
	const doneLine = `- **${task}** — ${note}`.replace(/\s+/g, ' ');
	const kept: string[] = [];
	let inOpen = false;
	let dropping = false;
	for (const line of md.split('\n')) {
		if (isOpenHeader(line)) {
			inOpen = true;
			dropping = false;
			kept.push(line);
			continue;
		}
		if (inOpen && isHeader(line)) {
			inOpen = false;
			dropping = false;
			kept.push(line);
			continue;
		}
		if (inOpen) {
			const bullet = line.match(/^\s*[-*]\s+(.*)$/);
			if (bullet) {
				dropping = boldLead(line) === task;
				if (dropping) continue;
			} else if (dropping && line.trim()) {
				continue;
			} else if (!line.trim()) {
				dropping = false;
			}
		}
		kept.push(line);
	}
	let out = kept.join('\n');

	const doneIdx = out.split('\n').findIndex(isDoneHeader);
	if (doneIdx >= 0) {
		const dl = out.split('\n');
		dl.splice(doneIdx + 1, 0, doneLine, '');
		out = dl.join('\n');
	} else {
		out = out.replace(/\s*$/, '\n') + '\n## Done\n\n' + doneLine + '\n';
	}
	return out.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

export function recordLoopNote(md: string, note: string): string {
	const line = `- [${new Date().toISOString().slice(0, 10)}] ${note}`;
	const mandIdx = md.split('\n').findIndex(isMandateHeader);
	if (mandIdx >= 0) {
		const lines = md.split('\n');
		let insertAt = mandIdx + 1;
		while (insertAt < lines.length && !lines[insertAt]!.trim()) insertAt++;
		lines.splice(insertAt, 0, line, '');
		return lines.join('\n').replace(/\n{3,}/g, '\n\n');
	}
	return md.replace(/\s*$/, '\n') + '\n## Mandate\n\n' + line + '\n';
}

export function writeHindsight(md: string): boolean {
	try {
		Bun.write(HINDSIGHT, md);
		return true;
	} catch {
		return false;
	}
}

export function readLedger(start = 0): {
	events: any[];
	newOffset: number;
	lastOpen: any | null;
	lastAssigned: any | null;
	lastDecision: any | null;
	lastSettled: any | null;
} {
	let events: any[] = [];
	let offset = start;
	let lastOpen: any | null = null;
	let lastAssigned: any | null = null;
	let lastDecision: any | null = null;
	let lastSettled: any | null = null;
	const scan = (slice: string) => {
		for (const line of slice.split('\n')) {
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line);
				events.push(ev);
				if (ev.event === 'task_open' || ev.event === 'task_post')
					lastOpen = ev;
				if (ev.event === 'assigned') lastAssigned = ev;
				if (ev.event === 'intake-decision') lastDecision = ev;
				if (ev.event === 'settled') lastSettled = ev;
			} catch {
				/* skip malformed */
			}
		}
	};
	try {
		if (existsSync(LEDGER)) {
			const raw = readFileSync(LEDGER, 'utf8');
			offset = raw.length;
			scan(start > 0 ? raw.slice(start) : raw);
		}
	} catch {
		/* ledger unreadable → treat as empty */
	}
	if (events.length === 0 && start > 0) {
		try {
			const raw = readFileSync(LEDGER, 'utf8');
			offset = raw.length;
			scan(raw);
		} catch {
			/* ignore */
		}
	}
	return {
		events,
		newOffset: offset,
		lastOpen,
		lastAssigned,
		lastDecision,
		lastSettled,
	};
}

/**
 * Event-driven ledger wait: watch the ledger with `fs.watch` (push, not
 * poll) and resolve true the moment its size exceeds `initialSize`, else
 * false when `pollMs` elapses. Never blocks on sleep.
 */
export function pollLedgerGrowth(
	initialSize: number,
	pollMs = LEDGER_POLL_MS,
	_stepMs = LEDGER_POLL_STEP_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		let watcher: ReturnType<typeof fsWatch> | undefined;
		const finish = (grew: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			watcher?.close();
			resolve(grew);
		};
		const probeSize = () => {
			try {
				if (statSync(LEDGER).size > initialSize) finish(true);
			} catch {
				/* ledger may be mid-rotation */
			}
		};
		try {
			const target = existsSync(LEDGER) ? LEDGER : ORACLE;
			watcher = fsWatch(target, { persistent: false }, () => probeSize());
		} catch {
			watcher = undefined;
		}
		timer = setTimeout(() => finish(false), Math.max(1, pollMs));
		probeSize();
	});
}

export function summarizeAwarded(events: any[]): string[] {
	const out: string[] = [];
	for (const ev of events) {
		if (ev.event === 'assigned') {
			out.push(
				`[assigned] task ${ev.task_id} → winner ${ev.winner} @ ${ev.price_paid ?? ev.amount ?? '?'}`,
			);
		} else if (ev.event === 'task_open') {
			out.push(`[task_open] ${ev.task_id} ${ev.title ?? ''}`.trim());
		} else if (ev.event === 'intake-decision') {
			out.push(
				`[intake-decision] ${ev.from}: route=${ev.route} reason=${ev.reason}`,
			);
		} else if (ev.event === 'next_work_request') {
			out.push(`[next_work] prev=${ev.prev_task}`);
		}
	}
	return out;
}

export function summarizeSettled(events: any[], limit = 5): string {
	const settled = events.filter((e: any) => e && e.event === 'settled');
	if (!settled.length) return '';
	return settled
		.slice(-limit)
		.map((s: any) => {
			const verdict =
				s.success === true
					? 'success'
					: `no-result (${s.reason || s.gate_reason || 'unverified'})`;
			const dur =
				typeof s.duration_ms === 'number'
					? `, ${(s.duration_ms / 1000).toFixed(1)}s`
					: '';
			return `${s.task_id}: ${verdict}${dur}`;
		})
		.join('; ');
}

export function pickNextTask(events: any[], hindsight: string): string {
	const assigned = [...events]
		.reverse()
		.find((e: any) => e && e.event === 'assigned');
	if (assigned) {
		const title = assigned.title || assigned.task_text || '';
		return title
			? `${assigned.task_id}: ${title}`
			: String(assigned.task_id);
	}
	return extractNextOpenTask(hindsight);
}

export function applyTask(
	task: string,
	budgetMs = APPLY_BUDGET_MS,
): { exp: any; iter: any } {
	const brief = task.length > 2000 ? task.slice(0, 2000) : task;
	const expSlice = Math.max(400, Math.floor(budgetMs * 0.7));
	const iterSlice = Math.max(400, budgetMs - expSlice);
	const exp = run(
		[
			DELEND_EXPERIMENTAL,
			'--brief',
			brief,
			'--paths',
			'3',
			'--budget-ms',
			String(expSlice),
		],
		{},
		expSlice + 400,
	);
	const iter = run(
		[
			DELEND_ITERATE,
			'--goal',
			brief,
			'--workdir',
			process.cwd(),
			'--iters',
			'1',
			'--budget-ms',
			String(iterSlice),
		],
		{},
		iterSlice,
	);
	return { exp, iter };
}

async function cmdLoop(
	from: string,
	iters: number,
	pollMs: number,
	autoApply: boolean,
): Promise<number> {
	ensureHindsight();

	const transcript: any[] = [];
	const seen = new Set<string>();
	let emptyRuns = 0;
	const n = Math.max(1, iters);

	const priorSettled = summarizeSettled(readLedger(0).events);
	let startOffset = 0;
	try {
		if (existsSync(LEDGER))
			startOffset = readFileSync(LEDGER, 'utf8').length;
	} catch {
		/* ignore */
	}

	console.log(
		`delend-oracle loop — from=${from}, iters=${n}, poll=${pollMs}ms`,
	);
	if (priorSettled) console.log(`  prior settlements: ${priorSettled}`);

	for (let i = 1; i <= n; i++) {
		const hindsight = readHindsight();
		const goal =
			'RECURSIVE EMERGENT MANDATE: find more to do by asking the oracle market ' +
			'for the NEXT task + new emergent experimental work to apply. We reconcile ' +
			'the estate oracle market with the standing recursive mandate.';
		let text = goal;
		if (hindsight)
			text += `\n\nHINDSIGHT CONTEXT (prior loop): ${hindsight}`;
		const queue = parseOpenItems(hindsight);
		if (queue.length) {
			text +=
				'\n\nOPEN QUEUE (hindsight ## Open, next up first):\n' +
				queue
					.slice(0, 4)
					.map((q, n2) => `${n2 + 1}. ${q}`)
					.join('\n');
		}
		text += `\n\nOPEN ASK (iteration ${i}/${n}): award us the next concrete task or emergent experimental direction to APPLY. Bidders, propose implementation.`;
		if (i > 1 && transcript.length) {
			const last = transcript[transcript.length - 1];
			if (last.settled)
				text += `\n\nPRIOR TASK SETTLED: ${last.settled}. `;
			if (last.applied?.length)
				text += `ALREADY APPLIED THIS RUN (do not repeat): ${last.applied.join(' | ')}. `;
			if (last.task_text)
				text += `Previous intake asked: ${last.task_text.slice(0, 200)}. `;
			text +=
				'Feed prior result forward: surface the genuinely NEXT task, not a repeat.';
		}

		const res = run(
			['python3', POST_INTAKE, '--from', from, '--text', text],
			{ ORACLE_INTAKE: '1' },
		);
		const entry: any = { iter: i, ts: Date.now(), applied: [] };
		if (res.status !== 0) {
			entry.error =
				res.err || res.out || `post_intake exit ${res.status}`;
			console.error(`  iter ${i}: post failed — ${entry.error}`);
		} else {
			console.log(`  iter ${i}: ${res.out}`);
		}

		await pollLedgerGrowth(
			startOffset,
			i === 1 ? pollMs : Math.min(pollMs, LEDGER_POLL_TAIL_MS),
		);

		const { events, newOffset } = readLedger(startOffset);
		startOffset = newOffset;

		const settledSummary = summarizeSettled(events);
		if (settledSummary) {
			entry.settled = settledSummary;
			console.log(`  settled: ${settledSummary}`);
		}

		const fresh = events.filter((e: any) => {
			const key = `${e.event}:${e.task_id ?? ''}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		const awarded = summarizeAwarded(fresh);
		entry.events = fresh.map((e: any) => e.event);
		entry.awarded = awarded;
		entry.task_text = text;

		if (awarded.length) {
			console.log('  market awarded:');
			for (const a of awarded) console.log(`    ${a}`);
		} else {
			console.log('  no new award this iteration.');
			emptyRuns += 1;
		}

		const nextTask = pickNextTask(fresh, hindsight);
		if (nextTask && !seen.has(`applied:${nextTask}`)) {
			seen.add(`applied:${nextTask}`);
			console.log(`  next task: ${nextTask.slice(0, 120)}`);
			let ok = false;
			if (autoApply) {
				console.log(
					'  applying via delend-experimental + delend-iterate...',
				);
				const { exp, iter } = applyTask(nextTask);
				entry.apply_exit = exp.status;
				entry.apply_out = exp.out.slice(0, 2000);
				entry.iterate_exit = iter.status;
				entry.iterate_out = iter.out.slice(0, 1000);
				ok = exp.status === 0 && iter.status === 0;
				if (exp.out)
					console.log(exp.out.split('\n').slice(0, 6).join('\n'));
			}

			let next = readHindsight();
			const head = extractNextOpenTask(next);
			if (ok && head) {
				next = recordApplied(
					next,
					head,
					`applied via delend-oracle loop (${new Date().toISOString().slice(0, 10)})`,
				);
				entry.applied.push(head);
				console.log(
					`  hindsight advanced: moved "${head.slice(0, 60)}" Open → Done`,
				);
			}
			next = recordLoopNote(
				next,
				autoApply
					? `loop iter ${i}: applied "${nextTask.slice(0, 100)}" (experimental exit ${entry.apply_exit}, iterate exit ${entry.iterate_exit})`
					: `loop iter ${i}: surfaced "${nextTask.slice(0, 100)}" (pass --auto-apply to execute)`,
			);
			writeHindsight(next);
		} else if (!nextTask) {
			console.log('  nothing to apply (no award, empty ## Open queue).');
			writeHindsight(
				recordLoopNote(
					readHindsight(),
					`loop iter ${i}: market idle, no open task to apply`,
				),
			);
		}

		transcript.push(entry);

		if (i > 1 && emptyRuns >= 2) {
			console.log(
				'  converged (no new task for 2 iterations). stopping early.',
			);
			break;
		}
	}

	try {
		appendFileSync(
			TRANSCRIPT,
			transcript.map((t: any) => JSON.stringify(t)).join('\n') + '\n',
		);
	} catch {
		/* best-effort transcript */
	}

	const appliedAll = [
		...new Set(transcript.flatMap((t: any) => t.applied || [])),
	];
	const lastAwarded = transcript.flatMap((t: any) => t.awarded || []);
	let nextToDo: string;
	if (appliedAll.length) nextToDo = appliedAll.join(' ; ');
	else if (lastAwarded.length) nextToDo = lastAwarded.join(' ; ');
	else {
		const tail = readLedger(0);
		const queued = extractNextOpenTask(readHindsight());
		if (queued) nextToDo = `next open task from hindsight: ${queued}`;
		else if (tail.lastAssigned)
			nextToDo = `last awarded task ${tail.lastAssigned.task_id} → ${tail.lastAssigned.winner}`;
		else if (tail.lastOpen)
			nextToDo =
				`last open task ${tail.lastOpen.task_id} ${tail.lastOpen.title ?? ''}`.trim();
		else nextToDo = '(market surfaced nothing new this loop)';
	}

	console.log(`\n[x] wrote transcript → ${TRANSCRIPT}`);
	console.log(`[x] NEXT-TO-DO: ${nextToDo}`);
	try {
		appendFileSync(
			TRANSCRIPT,
			JSON.stringify({
				event: 'loop_done',
				next_to_do: nextToDo,
				ts: Date.now(),
			}) + '\n',
		);
	} catch {
		/* ignore */
	}
	return 0;
}

export function cmdStatus() {
	const hindsight = readHindsight();
	const { lastOpen, lastAssigned, lastDecision, lastSettled } = readLedger(0);
	console.log('=== delend-oracle status ===');
	if (hindsight) {
		console.log('-- hindsight (head) --');
		for (const l of hindsight.split('\n').slice(0, 8))
			console.log('  ' + l);
	} else {
		console.log('-- hindsight --');
		console.log('  (none yet — will be seeded on first `loop`)');
	}
	const queue = parseOpenItems(hindsight);
	if (queue.length) {
		console.log('-- open queue --');
		for (const q of queue.slice(0, 5))
			console.log(`  - ${q.slice(0, 110)}`);
	}
	console.log('-- last oracle activity --');
	if (lastDecision)
		console.log(
			`  intake-decision from=${lastDecision.from} route=${lastDecision.route} reason=${lastDecision.reason}`,
		);
	if (lastAssigned)
		console.log(
			`  assigned task=${lastAssigned.task_id} winner=${lastAssigned.winner}`,
		);
	else if (lastOpen)
		console.log(
			`  last open task=${lastOpen.task_id} ${lastOpen.title ?? ''}`.trim(),
		);
	else console.log('  (no open/assigned task seen in ledger)');
	if (lastSettled) {
		console.log(
			`  settled task=${lastSettled.task_id} success=${lastSettled.success} reason=${lastSettled.reason ?? lastSettled.gate_reason ?? '?'}`,
		);
	}
}

export function cmdApply(task: string): number {
	if (!task) {
		console.error('usage: delend-oracle apply --task "<task>"');
		return 2;
	}
	console.log(
		`delend-oracle apply — handing to delend-experimental:\n  brief: ${task}`,
	);
	const res = run([DELEND_EXPERIMENTAL, '--brief', task], {}, 9000);
	const rec = {
		event: 'apply',
		task,
		ts: Date.now(),
		exit: res.status,
		out: res.out.slice(0, 4000),
		err: res.err.slice(0, 1000),
	};
	try {
		appendFileSync(TRANSCRIPT, JSON.stringify(rec) + '\n');
	} catch {
		/* ignore */
	}
	if (res.out) console.log(res.out);
	if (res.err) console.error(res.err);
	if (res.status !== 0) {
		console.error(
			`apply failed (exit ${res.status}) — recorded to ${TRANSCRIPT}`,
		);
		return 1;
	}
	console.log(`[x] recorded apply result → ${TRANSCRIPT}`);
	return 0;
}

function usage() {
	console.log(`usage: delend-oracle <command> [args]

Commands:
  loop [--from kappa] [--iters N] [--poll-ms MS] [--auto-apply]
                                    recursive emergent loop: hindsight-wrapped
                                    intake → post to oracle → event-driven ledger
                                    poll for the awarded task → apply it via
                                    delend-experimental + delend-iterate → advance
                                    hindsight.md so the next intake asks for the
                                    genuinely next task. Never spawns a blocking
                                    sleep; finishes sub-4s. Writes transcript to
                                    ${TRANSCRIPT}.
  status                            show hindsight + open queue + last oracle task.
  apply --task "<task>"             hand a market-surfaced task to delend-experimental
                                    to apply, then record the result.
`);
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const get = (f: string, d: string) => {
		const idx = argv.indexOf(f);
		return idx >= 0 ? argv[idx + 1] : d;
	};
	const sub = argv[0];
	if (sub === 'loop') {
		const raw = parseInt(get('--poll-ms', String(LEDGER_POLL_MS)), 10);
		const pollMs = Number.isFinite(raw) && raw >= 0 ? raw : LEDGER_POLL_MS;
		return await cmdLoop(
			get('--from', 'kappa'),
			parseInt(get('--iters', '3'), 10) || 3,
			pollMs,
			argv.includes('--auto-apply'),
		);
	} else if (sub === 'status') {
		cmdStatus();
		return 0;
	} else if (sub === 'apply') {
		return cmdApply(get('--task', ''));
	} else if (sub === 'help' || sub === '--help' || sub === '-h' || !sub) {
		usage();
		return 0;
	} else {
		console.error(`delend-oracle: unknown subcommand '${sub}'`);
		usage();
		return 2;
	}
}

export default definePlugin({
	name: 'oracle-market',
	version: '0.1.0',
	describe:
		'Recursive oracle market loop: hindsight-wrapped intake, event-driven ledger poll, apply via experimental + iterate, hindsight advance.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'oracle';
		return {
			tools: [
				{
					id: 'status',
					summary:
						'Show oracle market hindsight + open queue + last activity.',
					tags: ['oracle', 'market', 'status'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_status`,
							{
								description: 'Show delend-oracle status.',
								inputSchema: z.object({}),
							},
							async () => {
								cmdStatus();
								return {
									content: [
										{
											type: 'text',
											text: JSON.stringify({ ok: true }),
										},
									],
								};
							},
						);
					},
				},
				{
					id: 'loop',
					summary:
						'Run the recursive oracle market loop (post intake, poll ledger, surface next task).',
					tags: ['oracle', 'market', 'loop'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_loop`,
							{
								description:
									'Run the delend-oracle recursive loop.',
								inputSchema: z.object({
									from: z.string().optional(),
									iters: z
										.number()
										.int()
										.positive()
										.optional(),
									pollMs: z
										.number()
										.int()
										.positive()
										.optional(),
									autoApply: z.boolean().optional(),
								}),
							},
							async (toolArgs: {
								from?: string;
								iters?: number;
								pollMs?: number;
								autoApply?: boolean;
							}) => {
								const cliArgs = [
									'loop',
									'--from',
									toolArgs.from || 'kappa',
								];
								const iters = toolArgs.iters ?? 3;
								const pollMs =
									toolArgs.pollMs ?? LEDGER_POLL_MS;
								cliArgs.push(
									'--iters',
									String(iters),
									'--poll-ms',
									String(pollMs),
								);
								if (toolArgs.autoApply)
									cliArgs.push('--auto-apply');
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
			],
		};
	},
});
