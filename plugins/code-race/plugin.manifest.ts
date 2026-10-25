import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'code-race',
	package: '@delendai/code-race',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Sub-4s breach auto-racer: runs a command under budget and auto-races forge pattern-borrow + code-race on breach.',
	tags: ['race', 'performance', 'borrow'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'process', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['race', 'performance'],
});
