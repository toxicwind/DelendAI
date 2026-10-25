import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'consent',
	package: '@delendai/consent',
	version: '0.1.0',
	visibility: 'public',
	summary: 'I5 confirmation gate: shared withConsent wrapper + usage-summary auto-bypass audit for write/spend tool invocations.',
	tags: ['consent', 'gate', 'audit'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'filesystem-write', 'env-read'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', 'zod'],
	capabilities: ['consent', 'gate', 'audit'],
});
