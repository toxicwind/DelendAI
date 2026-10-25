import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'experimental',
	package: '@delendai/experimental',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Conjectures 3+ parallel divergent forward paths via forge borrow, probes each under budget, and heals the winner.',
	tags: ['experimental', 'conjecture', 'divergent'],
	maturity: 'experimental',
	permissions: ['filesystem-read', 'filesystem-write', 'process', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['divergent-conjecture', 'self-healing'],
});
