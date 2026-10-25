import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'intent-router',
	package: '@delendai/intent-router',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Fast-intent router: classifies an instruction to the right delend-* primitive, with --run dispatch and --where live-resource routing.',
	tags: ['router', 'intent', 'dispatch'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'process', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['routing', 'dispatch'],
});
