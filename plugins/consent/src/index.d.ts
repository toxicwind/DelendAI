export type ToolRole = 'read' | 'write' | 'spend';
/**
 * Role table for the estate's 10 delend-* agentic primitive plugins.
 * Read-only tools pass through un-gated; every write/spend tool requires
 * an I5 consent signal (confirm:true, or the session opt-in env).
 */
export declare const PLUGIN_TOOL_ROLES: Record<string, string>;
export declare function toolNameFromId(plugin: string, id: string): string;
export declare function roleFor(plugin: string, tool: string): ToolRole;
/**
 * Wrap a server so every `registerTool` call gates its handler with
 * withConsent per the PLUGIN_TOOL_ROLES table. One call per plugin:
 *
 *   const server2 = consentedServer(server, "work-refs");
 *   server2.registerTool(id, schema, handler);   // gated automatically
 */
export declare function consentedServer(server: {
    registerTool: (...a: unknown[]) => unknown;
}, plugin: string): typeof server;
/**
 * Convenience for plugin `register(ctx)` returns: wrap the server per-tool
 * inside the array so no per-handler edits are needed.
 *
 *   return { tools: consentTools("work-refs", [ { id, register(server){…} } ]) };
 */
export declare function consentTools<T extends {
    id: string;
    register: (server: {
        registerTool: (...a: unknown[]) => unknown;
    }) => unknown;
}>(plugin: string, tools: T[]): T[];
/** The human-declared opt-in that allows auto-bypassing the per-call gate. */
export declare const SPEND_CONSENT_FLAG = "--yes-i-take-responsibility-for-spend";
export declare const SPEND_CONSENT_ENV = "DELENDAI_SPEND_CONSENT";
/** Where the audit counter lives, relative to the repo root / cwd. */
export declare const USAGE_FILE = ".delendai/usage-summary.json";
export interface UsageSummary {
    autoBypassed: number;
    denied: Record<string, number>;
    lastEvent?: {
        at: string;
        tool: string;
        kind: 'denied' | 'auto-bypassed';
    };
    [k: string]: unknown;
}
/** Read the usage summary (missing file → fresh zeroed record). Deterministic sync fs. */
export declare function readUsageSummary(workspace?: string): UsageSummary;
/** Atomically record a consent event. Never throws; audit is best-effort. */
export declare function recordUsage(kind: 'denied' | 'auto-bypassed', tool: string, workspace?: string): Promise<void>;
/**
 * Is the session spend-consent granted? Only the human opt-in counts:
 * the CLI flag set once per session (exported as the env var), OR an
 * explicit `confirm: true` in the tool arguments.
 */
export declare function isSpendConsentGranted(): boolean;
/**
 * Wrap a tool handler with the I5 gate.
 *
 * - role "read": pass-through (no banner, no accounting).
 * - role "write"|"spend": require `confirm === true` in args OR the session
 *   opt-in env; otherwise DENY with a human-readable refusal and record the
 *   denial. When the session opt-in (not an explicit per-call confirm)
 *   authorized the call, record it as an auto-bypass.
 */
export declare function withConsent<TArgs extends Record<string, unknown>, TResult>(name: string, role: ToolRole, impl: (args: TArgs) => TResult | Promise<TResult>): (args: TArgs) => Promise<TResult>;
declare const _default: import("@delendai/core/plugin").IMcpPlugin;
export default _default;
