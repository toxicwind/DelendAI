import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'forge-audit',
	package: '@delendai/forge-audit',
	version: '0.1.0',
	visibility: 'public',
	summary: 'Runs PATTERN-BORROW + CODE-RETRIEVE + PAPER-FINDER lanes and consolidates one evidence-backed attestation verdict.',
	tags: ['audit', 'attestation', 'forge'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'network'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['audit', 'attestation'],
});
