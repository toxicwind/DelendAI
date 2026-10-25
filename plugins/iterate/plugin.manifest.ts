import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'iterate',
	package: '@delendai/iterate',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Sync-feedback iteration driver: each iteration feeds the previous result, may change code, double-checks the model, and auto-races breaches.',
	tags: ['iteration', 'feedback', 'driver'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'filesystem-write', 'process', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['iteration', 'sync-feedback'],
});
