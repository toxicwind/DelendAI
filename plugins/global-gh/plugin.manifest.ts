import { definePluginManifest, TOKEN_BUDGETS } from '@delendai/core/public';

export default definePluginManifest({
	id: 'global-gh',
	package: '@delendai/global-gh',
	version: '0.1.0',
	visibility: 'public',
	summary: 'GLOBAL GitHub primitive: clone any org/repo/URL to a temp dir, audit branches vs the default head, read raw files, or run arbitrary git.',
	tags: ['github', 'git', 'primitive'],
	maturity: 'stable',
	permissions: ['filesystem-read', 'filesystem-write', 'git-read', 'git-write', 'network', 'process'],
	presets: ['standard', 'swarm'],
	tokenBudget: TOKEN_BUDGETS.toolPayloads.search,
	dependencies: ['@delendai/core', '@delendai/consent', 'zod'],
	capabilities: ['github', 'branch-audit'],
});
