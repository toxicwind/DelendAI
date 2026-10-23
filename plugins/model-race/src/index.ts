/**
 * @delendai/model-race — DelendAI plugin & drop-in Bun library for the modular profile runner.
 *
 * Converts `estate/bin/delend-model-race` into a first-class DelendAI plugin (`definePlugin`)
 * and importable Bun library.
 */
import { readFileSync, existsSync } from 'node:fs';
import { definePlugin } from '@delendai/core/plugin';
import { consentTools } from '@delendai/consent';
import { z } from 'zod';

export const PROVIDERS: Record<string, { base: string; key: string }> = {
	nvidia: {
		base: 'https://integrate.api.nvidia.com/v1',
		key: process.env.NVIDIA_API_KEY || '',
	},
	freeinference: {
		base: 'https://freeinference.org/v1',
		key: process.env.FREEINFERENCE_API_KEY || '',
	},
	groq: {
		base: 'https://api.groq.com/openai/v1',
		key: process.env.GROQ_API_KEY || '',
	},
	cerebras: {
		base: 'https://api.cerebras.ai/v1',
		key: process.env.CEREBRAS_API_KEY || '',
	},
	together: {
		base: 'https://api.together.xyz/v1',
		key: process.env.TOGETHER_API_KEY || '',
	},
};

function curl(args: string[], timeoutMs: number) {
	const p = Bun.spawnSync(['curl', '-sS', '-w', '\n%{http_code}', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs + 1500,
		env: { ...process.env },
	});
	const out = p.stdout.toString();
	const i = out.lastIndexOf('\n', out.length - 2);
	return {
		rc: p.exitCode ?? 1,
		out: out.slice(0, i + 1).trim(),
		code: out.slice(i + 1).trim() || '000',
	};
}

export function classify(
	body: string,
	code: string,
): 'limit' | 'gone' | 'bad' | 'ok' {
	const low = body.toLowerCase();
	if (
		code === '429' ||
		/rate.?limit|too many requests|governor|exceeded.*(limit|quota)|busy|try again later|concurrency_limit/.test(
			low,
		)
	)
		return 'limit';
	if (code === '410') return 'gone';
	if (
		code === '404' ||
		/not found|not provisioned|does not exist|unknown model/.test(low)
	)
		return 'gone';
	if (code !== '200' || (!low.includes('choices') && low.includes('error')))
		return 'bad';
	return low.includes('choices') ? 'ok' : 'bad';
}

export function replyOf(body: string): string {
	try {
		const d = JSON.parse(body);
		const c = d?.choices?.[0]?.message?.content;
		return typeof c === 'string'
			? c.trim()
			: JSON.stringify(d).slice(0, 300);
	} catch {
		return body.slice(0, 300);
	}
}

export function listModels(provider: string): string[] {
	const p = PROVIDERS[provider];
	if (!p?.key) return [];
	const routes = [p.base + '/models', p.base + '/models/sse', null];
	try {
		for (const r of routes) {
			const args = [
				r ?? p.base + '/models',
				'-H',
				`Authorization: Bearer ${p.key}`,
			];
			if (r === null) args.push('-A', 'Mozilla/5.0');
			const res = curl(args, 8000);
			const d = JSON.parse(res.out);
			if (d?.data?.length) return d.data.map((m: any) => m.id ?? m.name);
		}
	} catch {
		/* try next route */
	}
	return [];
}

export type Profile = {
	id: string;
	banner: string;
	build: (o: { img?: string; imgB64?: string }) => {
		prompt: string;
		content: any;
	};
	score: (reply: string) => number;
};

function imgContent(imgB64: string, prompt: string) {
	return [
		{ type: 'text', text: prompt },
		{
			type: 'image_url',
			image_url: { url: `data:image/png;base64,${imgB64}` },
		},
	];
}

export const PROFILES: Profile[] = [
	{
		id: 'complex-image',
		banner: 'VISION — read the :99 desktop grid screenshot',
		build: (o) => ({
			prompt: "Count the distinct app windows in this desktop screenshot, give each one's quadrant, name the apps if you can, and list accent colors. Be precise.",
			content: o.imgB64
				? imgContent(
						o.imgB64,
						'How many distinct app windows, their quadrants, app names, and accent colors?',
					)
				: '…',
		}),
		score: (r) =>
			/[234]/i.test(r) && /quadrant|top-left|top-right|bottom/i.test(r)
				? 1
				: /quadrant|top-left|bottom/i.test(r)
					? 0.6
					: 0,
	},
	{
		id: 'complex-text',
		banner: 'TEXT — dense multi-part reasoning',
		build: (o) => ({
			prompt: 'A train leaves at 08:00 at 60 km/h; a second leaves at 08:30 and catches up at 12:00. (a) How fast is the second train? (b) State an invariants argument any physicist would accept. (c) If both instead accelerate in opposite directions, what happens to the meeting point? Give three equations.',
			content:
				'A train leaves at 08:00 at 60 km/h; a second leaves at 08:30 and catches up at 12:00. (a) speed of second? (b) invariant argument. (c) if they accelerate oppositely, what of the meeting point? Equations.',
		}),
		score: (r) =>
			/72/ && /km\/h/i.test(r) ? 1 : /km\/h/i.test(r) ? 0.5 : 0,
	},
	{
		id: 'complex-code',
		banner: 'CODE — adversarially fix this broken snippet',
		build: (o) => ({
			prompt: 'This Python leaks a file handle and has an off-by-one: def readcnt(p): f=open(p); i=0; [i:=i+1 for _ in f]; return i. Fix it to be correct AND idiomatic; explain the two defects and the fix in <8 lines.',
			content:
				'def readcnt(p): f=open(p); i=0; [i:=i+1 for _ in f]; return i. Find the 2 defects (handle leak, off-by-one) and give a correct idiomatic rewrite.',
		}),
		score: (r) =>
			/with open|with *open\(|close\(/.test(r) &&
			/count|sum\(1|off-by-one|<8 lines/gi.test(r)
				? 1
				: /with open|close\(/.test(r)
					? 0.6
					: 0,
	},
	{
		id: 'complex-existential',
		banner: 'EXISTENTIAL — structure an open-ended depth question',
		build: (o) => ({
			prompt: "Give a careful, structured take on: 'Is meaning invented or discovered?' Provide 3 named positions (secular, religious, pragmatic), a shared assumption you reject, and a 1-line answer a pragmatic humanist would give. No filler.",
			content:
				'Is meaning invented or discovered? Give 3 named positions (secular, religious, pragmatic), a shared assumption you reject, and a 1-line pragmatic-humanist answer.',
		}),
		score: (r) =>
			/secular|religious|pragmatic/i.test(r) && /invent|discov/i.test(r)
				? 1
				: /invent|discov/i.test(r)
					? 0.5
					: 0,
	},
	{
		id: 'complex-opinion',
		banner: 'OPINION — reasoned stance with rubric',
		build: (o) => ({
			prompt: "Argue for OR against 'local-first AI beats cloud AI for daily personal tasks', with (1) a concrete scenario, (2) the strongest counter-argument, (3) your verdict and why. <6 sentences, no hedging garbage.",
			content:
				"Argue for OR against 'local-first AI beats cloud AI for daily personal tasks': scenario, strongest counter-argument, verdict. <6 sentences.",
		}),
		score: (r) =>
			/scenario|however|counter|against|because/i.test(r) &&
			/local|cloud/i.test(r)
				? 1
				: /local|cloud/i.test(r)
					? 0.5
					: 0,
	},
	{
		id: 'complex-ambiguous',
		banner: 'AMBIGUOUS — minimal-spec constrained guess',
		build: (o) => ({
			prompt: "A system must 'be fast'. Define fast, pick a target metric with a number, state the riskiest assumption, and say what you'd measure first. Maximally concrete, minimal hedging.",
			content:
				"A system must 'be fast'. Define fast, a numeric target metric, the riskiest assumption, and the first measurement. Concrete, minimal hedging.",
		}),
		score: (r) =>
			/ms|s\b|second|latency|metric/i.test(r) &&
			/assum|risk|measure/i.test(r)
				? 1
				: /ms|latency|metric/i.test(r)
					? 0.5
					: 0,
	},
];

export interface RaceRow {
	provider: string;
	model: string;
	profile: string;
	verdict: string;
	latency_ms: number;
	reply: string;
	score: number;
}

export function raceProfile(
	model: string,
	provider: string,
	profile: Profile,
	opts: { img?: string; timeouts?: number[]; prompt?: string },
): RaceRow {
	const p = PROVIDERS[provider];
	const b64 =
		opts.img && existsSync(opts.img)
			? readFileSync(opts.img).toString('base64')
			: '';
	const timeouts = opts.timeouts || [1000, 2000, 3000, 4000];
	const b = profile.build({ img: opts.img, imgB64: b64 });
	const bodyContent = b.content;
	const payload = JSON.stringify({
		model,
		messages: [{ role: 'user', content: bodyContent }],
		max_tokens: 220,
	});
	let row: RaceRow = {
		provider,
		model,
		profile: profile.id,
		verdict: 'bad',
		latency_ms: 0,
		reply: '<no valid>',
		score: 0,
	};
	for (const t of timeouts) {
		const s = Date.now();
		const r = curl(
			[
				p.base + '/chat/completions',
				'-H',
				`Authorization: Bearer ${p.key}`,
				'-H',
				'Content-Type: application/json',
				'-d',
				payload,
			],
			t,
		);
		row = {
			provider,
			model,
			profile: profile.id,
			verdict: classify(r.out, r.code),
			latency_ms: Date.now() - s,
			reply: replyOf(r.out),
			score: 0,
		};
		if (classify(r.out, r.code) === 'ok') {
			row.verdict = 'OK';
			row.score = profile.score(row.reply);
			return row;
		}
		if (classify(r.out, r.code) === 'limit') {
			busysleep(400);
			continue;
		}
		if (classify(r.out, r.code) !== 'limit') break;
	}
	return row;
}

function busysleep(ms: number) {
	const e = Date.now() + ms;
	while (Date.now() < e) {}
}

export function main(argv = process.argv.slice(2)): number {
	const a = argv;
	if (a.includes('--help') || a.includes('-h')) {
		console.log(`delend-model-race — MODULAR PROFILE RUNNER (plugin: @delendai/model-race).

Usage:
  delend-model-race --provider P [--profile complex-image|complex-text|...]
                    [--models a,b,c] [--img <png>] [--prompt ".."] [--timeouts 1,2,3,4]
                    [--max N] [--score]
  DELEND_RACE_OUT=path  writes json.

Races any model over multiple complexity-profile benchmarks and finds the
fastest-correct per profile. Adaptively backs off on 429/ratelimit; discovers
models via /v1/models unless --models is given.
`);
		return 0;
	}
	const g = (f: string, d = '') => {
		const i = a.indexOf(f);
		return i >= 0 ? a[i + 1] : d;
	};
	const prov = g('--provider', 'freeinference');
	const profId = g('--profile', 'complex-image');
	const img = g('--img', '/home/toxic/disp_small.png');
	const max = Number(g('--max', '10'));
	const profile = PROFILES.find((x) => x.id === profId) || PROFILES[0]!;
	const timeouts = g('--timeouts', '1,2,3,4')
		.split(',')
		.map((x) => Number(x) * 1000);

	console.error(
		`delend-model-race provider=${prov} profile=${profId} ttl=${timeouts.join('/')}\n  # ${profile.banner}`,
	);

	let models = g('--models', '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!models.length) models = listModels(prov).slice(0, max);

	const rows: RaceRow[] = [];
	for (const m of models) {
		const r = raceProfile(m, prov, profile, { img, timeouts });
		rows.push(r);
		console.log(
			`  ${r.model.padEnd(46)} ${r.verdict.padEnd(7)} ${String(r.latency_ms).padStart(6)}ms score=${r.score.toFixed(2)} ${r.reply.slice(0, 60).replace(/\n/g, ' ')}`,
		);
	}
	const ok = rows
		.filter((r) => r.verdict === 'OK')
		.sort((x, y) =>
			x.score !== y.score
				? y.score - x.score
				: x.latency_ms - y.latency_ms,
		)[0];
	try {
		Bun.write(
			process.env.DELEND_RACE_OUT ||
				`/tmp/delend-model-race-${prov}-${profId}.json`,
			JSON.stringify(
				{
					provider: prov,
					profile: profId,
					at: new Date().toISOString(),
					rows,
				},
				null,
				2,
			),
		);
	} catch {}
	process.stdout.write(
		`\nPROFILE-WINNER ${profId} @ ${prov}: ${ok ? `${ok.model} score=${ok.score} ${ok.latency_ms}ms` : 'none'}\n`,
	);
	return ok ? 0 : 3;
}

export default definePlugin({
	name: 'model-race',
	version: '0.1.0',
	describe:
		'Modular profile runner: races any model over complexity-profile benchmarks, adaptive backoff on 429, live /v1/models discovery.',
	register(ctx) {
		const prefix = ctx.namespacePrefix || 'model_race';
		return {
			tools: consentTools('model-race', [
				{
					id: 'run',
					summary:
						'Race models over a complexity profile and report the fastest-correct winner.',
					tags: ['model', 'race', 'benchmark'],
					register: async (server) => {
						server.registerTool(
							`${prefix}_run`,
							{
								description:
									'Run delend-model-race for a provider/profile.',
								inputSchema: z.object({
									confirm: z
										.boolean()
										.optional()
										.describe(
											'Explicit I5 consent: required for write/spend tools unless the session opted in via --yes-i-take-responsibility-for-spend',
										),
									provider: z.string().optional(),
									profile: z.string().optional(),
									models: z.array(z.string()).optional(),
									img: z.string().optional(),
									max: z.number().int().positive().optional(),
								}),
							},
							async (toolArgs: {
								provider?: string;
								profile?: string;
								models?: string[];
								img?: string;
								max?: number;
							}) => {
								const cliArgs = [
									'--provider',
									toolArgs.provider || 'freeinference',
									'--profile',
									toolArgs.profile || 'complex-image',
								];
								if (toolArgs.models?.length)
									cliArgs.push(
										'--models',
										toolArgs.models.join(','),
									);
								if (toolArgs.img)
									cliArgs.push('--img', toolArgs.img);
								if (toolArgs.max)
									cliArgs.push('--max', String(toolArgs.max));
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
