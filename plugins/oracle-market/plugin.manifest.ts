import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'oracle-market',
	package: '@delendai/oracle-market',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Recursive oracle market loop: hindsight-wrapped intake, event-driven ledger poll, apply via experimental + iterate, hindsight advance.',
	tags: ['oracle', 'market', 'ledger'],
	maturity: 'experimental',
	permissions: ['filesystem-read', 'filesystem-write', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['oracle-market', 'recursive-loop'],
});
