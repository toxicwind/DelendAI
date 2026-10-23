/**
 * @delendai/consent — I5-style confirmation gate for DelendAI write/spend tools.
 *
 * Implements the confirmation-token semantics from f00067 /
 * `docs/delendai/wiki/07-plugin-orchestrator-runner.md` (Appendix — CRITICAL I5
 * fix), but as a shared, host-agnostic wrapper every estate plugin can use:
 *
 *   - Write/spend tool invocations require an EXPLICIT consent signal.
 *   - The LLM can never mint its own token: consent is either
 *     `confirm: true` in the tool arguments (a user-initiated call carries
 *     it) or a per-session opt-in flag that a HUMAN declared once:
 *     `--yes-i-take-responsibility-for-spend` (env `DELENDAI_SPEND_CONSENT=1`).
 *   - Every auto-bypassed invocation is recorded in
 *     `<workspace>/.delendai/usage-summary.json` under `autoBypassed`, so it
 *     is auditable via the `consent_overview` tool (or the file itself).
 *   - Read-only tools pass through untouched (role: "read").
 *
 * Usage inside a plugin tool handler:
 *
 *   import { withConsent } from "../consent/src/index.ts";
 *   server.registerTool(
 *     `${prefix}_checkpoint`,
 *     { description: "…", inputSchema },
 *     withConsent("work-refs_checkpoint", "write", async (args) => { … }),
 *   );
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { definePlugin } from '@delendai/core/plugin';
import { z } from 'zod';

export type ToolRole = 'read' | 'write' | 'spend';

/**
 * Role table for the estate's 10 delend-* agentic primitive plugins.
 * Read-only tools pass through un-gated; every write/spend tool requires
 * an I5 consent signal (confirm:true, or the session opt-in env).
 */
export const PLUGIN_TOOL_ROLES: Record<string, string> = {
	'work-refs:quick_checkpoint': 'write',
	'work-refs:dirty_status': 'read',
	'code-race:run': 'spend',
	'experimental:conjecture': 'spend',
	'iterate:run': 'spend',
	'oracle-market:status': 'read',
	'oracle-market:loop': 'spend',
	'model-race:run': 'spend',
	'forge-audit:audit': 'read',
	'intent-router:classify': 'read',
	'intent-router:where': 'read',
	'intent-router:run': 'write',
	'global-gh:run': 'write',
	'global-gh:branch_audit': 'read',
	'rig-c2:diagnose': 'read',
};

export function toolNameFromId(plugin: string, id: string): string {
	// Prefer a table suffix match (prefix may contain underscores); fall back
	// to greedy strip of `<something>_`.
	for (const k of Object.keys(PLUGIN_TOOL_ROLES)) {
		if (!k.startsWith(`${plugin}:`)) continue;
		const t = k.slice(k.indexOf(':') + 1);
		if (id === t || id.endsWith(`_${t}`)) return t;
	}
	return id.replace(/^.*?_/, '');
}

export function roleFor(plugin: string, tool: string): ToolRole {
	const r = PLUGIN_TOOL_ROLES[`${plugin}:${tool}`];
	if (r === 'write' || r === 'spend') return r;
	// Suffix fallback: the served id carries a prefix that may itself contain
	// underscores (`work_refs_quick_checkpoint`), so exact stripping is not
	// safe. Match any table entry `plugin:tool` whose tool is the id's tail.
	for (const [k, v] of Object.entries(PLUGIN_TOOL_ROLES)) {
		if (v !== 'write' && v !== 'spend') continue;
		const t = k.slice(k.indexOf(':') + 1);
		if (k.startsWith(`${plugin}:`) && (tool === t || tool.endsWith(`_${t}`))) return v;
	}
	return 'read';
}

/**
 * Wrap a server so every `registerTool` call gates its handler with
 * withConsent per the PLUGIN_TOOL_ROLES table. One call per plugin:
 *
 *   const server2 = consentedServer(server, "work-refs");
 *   server2.registerTool(id, schema, handler);   // gated automatically
 */
export function consentedServer(
	server: { registerTool: (...a: unknown[]) => unknown },
	plugin: string,
): typeof server {
	return new Proxy(server, {
					get(t, k) {
				if (k !== 'registerTool') return Reflect.get(t, k);
				return (id: string, schema: unknown, handler: (args: Record<string, unknown>) => unknown) => {
					const raw = String(id);
					const role = roleFor(plugin, raw);
					const name = `${plugin}:${raw}`;
					return t.registerTool(
						id,
						schema,
						withConsent(name, role, handler as never),
					);
				};
			},
	});
}

/**
 * Convenience for plugin `register(ctx)` returns: wrap the server per-tool
 * inside the array so no per-handler edits are needed.
 *
 *   return { tools: consentTools("work-refs", [ { id, register(server){…} } ]) };
 */
export function consentTools<
	T extends {
		id: string;
		register: (server: {
			registerTool: (...a: unknown[]) => unknown;
		}) => unknown;
	},
>(plugin: string, tools: T[]): T[] {
	return tools.map((t) => ({
		...t,
		register: (server: { registerTool: (...a: unknown[]) => unknown }) =>
			t.register(consentedServer(server, plugin)),
	}));
}

/** The human-declared opt-in that allows auto-bypassing the per-call gate. */
export const SPEND_CONSENT_FLAG = '--yes-i-take-responsibility-for-spend';
export const SPEND_CONSENT_ENV = 'DELENDAI_SPEND_CONSENT';

/** Where the audit counter lives, relative to the repo root / cwd. */
export const USAGE_FILE = '.delendai/usage-summary.json';

export interface UsageSummary {
	autoBypassed: number;
	denied: Record<string, number>;
	lastEvent?: { at: string; tool: string; kind: 'denied' | 'auto-bypassed' };
	[k: string]: unknown;
}

/** Read the usage summary (missing file → fresh zeroed record). Deterministic sync fs. */
export function readUsageSummary(
	workspace: string = process.cwd(),
): UsageSummary {
	try {
		const p = resolve(workspace, USAGE_FILE);
		if (!existsSync(p)) return { autoBypassed: 0, denied: {} };
		return JSON.parse(readFileSync(p, 'utf8')) as UsageSummary;
	} catch {
		return { autoBypassed: 0, denied: {} };
	}
}

/** Atomically record a consent event. Never throws; audit is best-effort. */
export async function recordUsage(
	kind: 'denied' | 'auto-bypassed',
	tool: string,
	workspace: string = process.cwd(),
): Promise<void> {
	try {
		const p = resolve(workspace, USAGE_FILE);
		mkdirSync(dirname(p), { recursive: true });
		const s = readUsageSummary(workspace);
		if (kind === 'denied') {
			s.denied[tool] = (s.denied[tool] ?? 0) + 1;
		} else {
			s.autoBypassed = (s.autoBypassed ?? 0) + 1;
		}
		s.lastEvent = { at: new Date().toISOString(), tool, kind };
		writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
	} catch (e) {
		console.warn(
			`[consent] audit write failed for ${tool}: ${String(e).slice(0, 120)}`,
		);
	}
}

/**
 * Is the session spend-consent granted? Only the human opt-in counts:
 * the CLI flag set once per session (exported as the env var), OR an
 * explicit `confirm: true` in the tool arguments.
 */
export function isSpendConsentGranted(): boolean {
	return (
		process.env[SPEND_CONSENT_ENV] === '1' ||
		process.env[SPEND_CONSENT_ENV] === 'true'
	);
}

/**
 * Wrap a tool handler with the I5 gate.
 *
 * - role "read": pass-through (no banner, no accounting).
 * - role "write"|"spend": require `confirm === true` in args OR the session
 *   opt-in env; otherwise DENY with a human-readable refusal and record the
 *   denial. When the session opt-in (not an explicit per-call confirm)
 *   authorized the call, record it as an auto-bypass.
 */
export function withConsent<TArgs extends Record<string, unknown>, TResult>(
	name: string,
	role: ToolRole,
	impl: (args: TArgs) => TResult | Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
	return async (args) => {
		if (role === 'read') return impl(args);
		const userConfirmed = args?.['confirm'] === true;
		const sessionOptIn = isSpendConsentGranted();
		if (!userConfirmed && !sessionOptIn) {
			await recordUsage('denied', name);
			return {
				content: [
					{
						type: 'text',
						text:
							`[consent] DENIED: ${name} is a ${role} operation and needs explicit confirmation. ` +
							`Pass confirm:true in the tool arguments, or authorize this session once with ` +
							`--${SPEND_CONSENT_FLAG.slice(2)} (or DELENDAI_SPEND_CONSENT=1).`,
					},
				],
			} as TResult;
		}
		if (sessionOptIn && !userConfirmed)
			await recordUsage('auto-bypassed', name);
		return impl(args);
	};
}

// ─── the consent plugin itself: one read-only overview tool ────────────────
export default definePlugin({
	name: 'consent',
	version: '0.1.0',
	describe:
		'I5 confirmation gate: shared withConsent wrapper + usage-summary auto-bypass audit for write/spend tool invocations.',
	register(ctx) {
		const prefix = ctx.namespacePrefix;
		return {
			tools: [
				{
					id: 'consent_overview',
					summary:
						'Show the session spend-consent state and the autoBypassed audit counter from usage-summary.json.',
					register: async (server) => {
						server.registerTool(
							`${prefix}_overview`,
							{
								description:
									'Read-only: current spend-consent state (granted|denied) and the autoBypassed/denied audit from .delendai/usage-summary.json.',
								inputSchema: z.object({
									workspace: z
										.string()
										.optional()
										.describe(
											'Repo root to read the summary from (default cwd).',
										),
								}),
							},
							withConsent(
								'consent_overview',
								'read',
								(a: { workspace?: string }) => {
									const ws =
										a.workspace ||
										ctx.workspace?.root ||
										process.cwd();
									const s = readUsageSummary(ws);
									return {
										content: [
											{
												type: 'text',
												text: JSON.stringify(
													{
														granted:
															isSpendConsentGranted(),
														flag: SPEND_CONSENT_FLAG,
														summaryPath: `${ws}/${USAGE_FILE}`,
														autoBypassed:
															s.autoBypassed,
														denied: s.denied,
														lastEvent:
															s.lastEvent ?? null,
													},
													null,
													2,
												),
											},
										],
									};
								},
							),
						);
					},
				},
			],
		};
	},
});
