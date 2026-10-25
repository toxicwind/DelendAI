import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'work-refs',
	package: '@delendai/work-refs',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Shared-checkout-merge work-ref checkpoint, dirty-tree snapshot, and guarded stash-optimize tools (delend-quick, delend-working-dirty, delend-stash-optimize).',
	tags: ['work-refs', 'checkpoint', 'git', 'shared-checkout'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'filesystem-write', 'git-read', 'git-write', 'process'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['work-refs', 'checkpoint', 'git'],
});
