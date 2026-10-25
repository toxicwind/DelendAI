import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'model-race',
	package: '@delendai/model-race',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Modular profile runner: races any model over complexity-profile benchmarks, adaptive backoff on 429, live /v1/models discovery.',
	tags: ['benchmark', 'race', 'models'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'network', 'process'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['benchmarking', 'model-race'],
});
