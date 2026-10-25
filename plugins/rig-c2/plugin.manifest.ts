import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'rig-c2',
	package: '@delendai/rig-c2',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Forever-loop C2 rig diagnostics: ledger settlement stats, workdir status per bidder, market-loop symlink check/fix, loop tick launch.',
	tags: ['rig-c2', 'diagnostics', 'oracle'],
	maturity: 'experimental',
	permissions: ['filesystem-read', 'process'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['diagnostics', 'c2-rig'],
});
