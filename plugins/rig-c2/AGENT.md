# AGENT.md — plugin `plugins/rig-c2`

> Below the `<!-- delendai:begin agent-md -->
## Purpose

- DelendAI forever-loop C2 rig diagnostics plugin (converts delend-rig-c2): ledger settlement stats, workdir status, market-loop symlink fix, loop tick launch.

## Public API

- default

## Depends on

- zod
- @delendai/core

## Writes

- <host workspace>/.delendai/cache/rig-c2/

## Entry points

- ./src/index.ts
- src/index.ts (default export → IMcpPlugin)

## Tests

_(none)_

## Do not

- An agent does not run `git stash`: git refuses it for agents (`delendai guard`, reference-transaction), because every worktree shares one stash and stashed work is invisible to the work model. Commit, or checkpoint to your work ref, instead.
- Do not hand-edit content between `<!-- delendai:begin -->`/`<!-- delendai:end -->` markers; regenerate via the owning `gen:*` script instead.
- Do not import `@delendai/core/lib/...`; use `@delendai/core/public`.
- Do not run user-facing shell or destructive tools without `dryRunSupported: true`.
- Do not surface absolute host paths; use `workspaceRoot`-relative paths only.

## Token hotspots

_(none)_

<!-- delendai:end agent-md -->

