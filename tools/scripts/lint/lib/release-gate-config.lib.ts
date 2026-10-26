/**
 * release-gate-config.lib.ts — first-class project configuration for the
 * release/pre-push gate.
 *
 * The gate (`release-pr-gate.script.ts`) enforces three things on a push that
 * touches `main` or `release/*`:
 *
 *   1. the last commit follows Conventional Commits;
 *   2. `bun run typecheck` passes;
 *   3. `bun run lint` passes.
 *
 * Steps 2 and 3 are project-local facts: a repo whose typecheck is broken by
 * the ENVIRONMENT (a stale toolchain, a dependency drift, a pre-existing error
 * count) cannot land anything at all, because the gate blocks every push. That
 * is a gate that says "never", which is not a gate.
 *
 * So the steps are configurable, first-class, and declared in the project's own
 * `delendai.config.json`:
 *
 *   {
 *     "development": {
 *       "releaseGate": {
 *         "typecheck": false,
 *         "lint": false
 *       }
 *     }
 *   }
 *
 * Resolution order (highest first):
 *   1. CLI flag          — `--no-typecheck` / `--no-lint` (and `--no-gate` for both)
 *   2. project config   — `development.releaseGate.{typecheck,lint}`
 *   3. default          — both enabled (the gate stays on unless a project says otherwise)
 *
 * A disabled step is REPORTED, never silent: the gate prints which steps ran
 * and which were declared off, so a bypass is always visible in the log.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Config file names searched from the repo root, in order. */
export const RELEASE_GATE_CONFIG_CANDIDATES = [
	'delendai.config.json',
	'.delendai.config.json',
] as const;

export interface IReleaseGateConfig {
	/** Run `bun run typecheck` as part of the gate. Default true. */
	readonly typecheck: boolean;
	/** Run `bun run lint` as part of the gate. Default true. */
	readonly lint: boolean;
}

export interface IReleaseGateConfigOptions {
	/** Repo root to search for the config file. */
	readonly cwd?: string;
	/** CLI argv to parse (lefterhook passes only the remote name/url). */
	readonly argv?: readonly string[];
}

const DEFAULT_CONFIG: IReleaseGateConfig = { typecheck: true, lint: true };

const parseConfigFile = (path: string): IReleaseGateConfig | undefined => {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as {
			development?: {
				releaseGate?: { typecheck?: unknown; lint?: unknown };
			};
		};
		const gate = raw.development?.releaseGate;
		if (!gate || typeof gate !== 'object') return undefined;
		return {
			// A declared `false` wins; anything else leaves the default alone.
			typecheck:
				typeof gate.typecheck === 'boolean'
					? gate.typecheck
					: DEFAULT_CONFIG.typecheck,
			lint:
				typeof gate.lint === 'boolean'
					? gate.lint
					: DEFAULT_CONFIG.lint,
		};
	} catch {
		// A parse error is not a gate decision: keep the defaults and let the
		// gate run. A broken config must never silently disable a gate.
		return undefined;
	}
};

const readProjectConfig = (cwd: string): IReleaseGateConfig | undefined => {
	for (const name of RELEASE_GATE_CONFIG_CANDIDATES) {
		const parsed = parseConfigFile(join(cwd, name));
		if (parsed) return parsed;
	}
	return undefined;
};

/** Parse the CLI overrides. Absent flags mean "not specified". */
export const parseReleaseGateArgs = (
	argv: readonly string[],
): Partial<IReleaseGateConfig> => {
	const out: Partial<IReleaseGateConfig> = {};
	for (const arg of argv) {
		if (arg === '--no-typecheck') out.typecheck = false;
		else if (arg === '--no-lint') out.lint = false;
		else if (arg === '--typecheck') out.typecheck = true;
		else if (arg === '--lint') out.lint = true;
		else if (arg === '--no-gate') {
			out.typecheck = false;
			out.lint = false;
		}
	}
	return out;
};

/**
 * Resolve the effective gate configuration: CLI flag > project config > default.
 *
 * `cwd` defaults to the process working directory, which is the repo root for
 * a git hook.
 */
export const resolveReleaseGateConfig = (
	options: IReleaseGateConfigOptions = {},
): IReleaseGateConfig => {
	const cwd = options.cwd ?? process.cwd();
	const fromCli = parseReleaseGateArgs(options.argv ?? process.argv.slice(2));
	const fromConfig = readProjectConfig(cwd);
	return {
		typecheck:
			fromCli.typecheck ??
			fromConfig?.typecheck ??
			DEFAULT_CONFIG.typecheck,
		lint: fromCli.lint ?? fromConfig?.lint ?? DEFAULT_CONFIG.lint,
	};
};

/** Human-readable summary of what the gate will and will not run. */
export const describeReleaseGateConfig = (
	config: IReleaseGateConfig,
): string => {
	const on = [
		config.typecheck ? 'typecheck' : undefined,
		config.lint ? 'lint' : undefined,
	].filter(Boolean);
	const off = [
		config.typecheck ? undefined : 'typecheck',
		config.lint ? undefined : 'lint',
	].filter(Boolean);
	const parts = [`runs: ${on.length ? on.join(', ') : '(none)'}`];
	if (off.length) parts.push(`declared off: ${off.join(', ')}`);
	return parts.join(' · ');
};
