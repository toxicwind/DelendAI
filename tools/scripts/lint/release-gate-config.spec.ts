import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	describeReleaseGateConfig,
	parseReleaseGateArgs,
	resolveReleaseGateConfig,
} from './lib/release-gate-config.lib';

const withConfig = (body: unknown): string => {
	const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
	writeFileSync(join(dir, 'delendai.config.json'), JSON.stringify(body));
	return dir;
};

describe('release-gate config', () => {
	it('defaults both steps on when no config exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'release-gate-empty-'));
		const cfg = resolveReleaseGateConfig({ cwd: dir, argv: [] });
		expect(cfg.typecheck).toBe(true);
		expect(cfg.lint).toBe(true);
	});

	it('reads development.releaseGate.typecheck=false from the project config', () => {
		const dir = withConfig({
			development: { releaseGate: { typecheck: false } },
		});
		const cfg = resolveReleaseGateConfig({ cwd: dir, argv: [] });
		expect(cfg.typecheck).toBe(false);
		expect(cfg.lint).toBe(true); // untouched key keeps the default
	});

	it('reads both steps off from the project config', () => {
		const dir = withConfig({
			development: { releaseGate: { typecheck: false, lint: false } },
		});
		const cfg = resolveReleaseGateConfig({ cwd: dir, argv: [] });
		expect(cfg.typecheck).toBe(false);
		expect(cfg.lint).toBe(false);
	});

	it('a CLI flag beats the project config', () => {
		const dir = withConfig({
			development: { releaseGate: { typecheck: false } },
		});
		const cfg = resolveReleaseGateConfig({
			cwd: dir,
			argv: ['--typecheck'],
		});
		expect(cfg.typecheck).toBe(true); // CLI re-enables what config disabled
	});

	it('--no-gate turns both steps off regardless of config', () => {
		const dir = withConfig({
			development: { releaseGate: { typecheck: true, lint: true } },
		});
		const cfg = resolveReleaseGateConfig({ cwd: dir, argv: ['--no-gate'] });
		expect(cfg.typecheck).toBe(false);
		expect(cfg.lint).toBe(false);
	});

	it('a broken config file keeps the defaults (never silently disables)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'release-gate-broken-'));
		writeFileSync(join(dir, 'delendai.config.json'), '{ not json');
		const cfg = resolveReleaseGateConfig({ cwd: dir, argv: [] });
		expect(cfg.typecheck).toBe(true);
		expect(cfg.lint).toBe(true);
	});

	it('parses each CLI flag', () => {
		expect(parseReleaseGateArgs(['--no-typecheck'])).toEqual({
			typecheck: false,
		});
		expect(parseReleaseGateArgs(['--no-lint'])).toEqual({ lint: false });
		expect(parseReleaseGateArgs(['--no-gate'])).toEqual({
			typecheck: false,
			lint: false,
		});
		expect(parseReleaseGateArgs([])).toEqual({});
	});

	it('describes what runs and what was declared off', () => {
		const text = describeReleaseGateConfig({
			typecheck: false,
			lint: true,
		});
		expect(text).toContain('typecheck');
		expect(text).toContain('lint');
	});
});
