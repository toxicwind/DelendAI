# `@delendai/code-race`

Latency-first command racing for scripts. Given a time budget and a script, it
runs **every line as a race**: each line executes under a shared monotonic
deadline, fails fast on breach, and (unless disabled) forge pattern-borrow races
a faster alternative against the remaining budget — so the whole script
finishes within the budget you asked for.

> Time is not a construct. `--seconds 10` means the **entire script** must finish
> in 10 seconds. Every line drains one shared budget pool; nothing runs on its
> own clock, and nothing sleeps.

## Why it exists

The old script runner gave each line its _own_ budget, so a 5-line script with
`--seconds 10` could run for 50s. It also split lines on whitespace and ran
them outside a shell, silently breaking `-c` programs, `&&`, pipes, `;`, inline
`FOO=bar` env, and globs, and it leaked credential-shaped env into debug
traces. This version fixes all three.

## Architecture (modular core)

| module              | responsibility                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/clock.ts`  | injected monotonic time (`performance.now`), `fakeClock` for tests — never wall-clock drift                                        |
| `src/lib/budget.ts` | one shared budget pool → whole-script deadlines; `Deadline` for a single op; `spentMs/remainingMs/exhausted` accounting            |
| `src/lib/shell.ts`  | `bash -c` execution with a monotonic hard-kill of the **whole process group** + secret-redacting capture; works under bun and node |
| `src/lib/parse.ts`  | duration (`10s`/`2500ms`), argv + lossless quoting, `--` delimiter                                                                 |

`race(line, budget)` is the per-line primitive: budget run → breach → forge
race (fresh budget bounded by the pool's remaining) → winner.

## CLI

```bash
delend-code-race-line <file> [--seconds N] [--no-race] [--log <file>]
delend-code-race-line --cmd "<multi-line script>" [--seconds N]
cat script | delend-code-race-line --stdin [--seconds N]
```

- `--seconds N` — **whole-script** budget (default 4). Accepts `10`, `10s`, `2500ms`.
- `--no-race` — kill on breach; do not forge-race a faster alternative.
- `--log <file>` — append every line's output (no truncation).

Legacy `secondsPerLine` keeps its per-line meaning for compatibility; a caller
that passes `seconds` gets the shared whole-script pool.

## Emission / verification

```bash
bun test          # 20 specs green
bunx biome check  # 0 errors, idempotent (No fixes applied) — hashline-friendly
```

## Security

Debug traces (`CODE_RACE_DEBUG=1`) redact credential-shaped values
(`ghp_`/`sk-`/`KEY=secret`) before they reach a report or log. Output capture in
`shell.ts` runs through the same redaction. Credential values are never printed.

## Ownership

Canonical source: `pens/barn/corral/delendai` (corral). Estate launchers
(`estate/bin/delend-*`) are thin shims over this package.
