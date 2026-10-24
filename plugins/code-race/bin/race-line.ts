#!/usr/bin/env bun
/**
 * race-line.ts — delend-code-race-line bin entry (plugin-owned).
 * Thin dispatcher to the scriptRunner lib, matching the estate launcher
 * convention: products own entrypoints, bins point at them.
 */
import { main } from '../src/lib/scriptRunner.ts';
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
