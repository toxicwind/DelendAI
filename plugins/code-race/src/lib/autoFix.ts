/**
 * autoFix.ts — the AUTONOMOUS "make it uber faster" fixer.
 *
 * The autonomous engine of code-race. When a line breaches its budget, this
 * sends the line plus its REAL measured execution time to DelendAI's completion
 * primitive (`callLlm` from @delendai/core/llm) with the explicit prompt
 * "HOW COULD I MAKE THIS UBER FASTER". The model proposes a faster shell
 * command; we verify it under the remaining budget (runp) and, if it passes,
 * write the winner. This is the part that makes code-race a real DelendAI
 * primitive-user (like audit's callLlmFanOut / model-race's classify+backoff)
 * instead of a shell-out to an external forge CLI.
 *
 * Provider-agnostic on purpose: `target` is an explicit
 * `{ provider, model, apiKey }` and `callLlm` dispatches to freeinference /
 * openrouter / anthropic / google / openai. This deliberately does NOT route
 * through corral's nin-router / Flock NIM proxy — that path hardcodes a single
 * router + reasoning-param special-casing, which would lock code-race to NIM
 * uselessly. code-race fixes lines against whatever provider the caller picks.
 *
 * 429/Retry-After: rate limit is a limiter shed, NOT a provider failure. A
 * `rate_limited` outcome from callLlm is surfaced so the caller can honor
 * `retryAfterMs` and retry rather than declaring the auto-fix failed.
 */
import {
  callLlm,
  hodosTarget,
  retryAfterMs,
  type IModelTarget,
  type ILlmCallOutcome,
} from "../../../../packages/core/src/lib/llm/client.ts";
import { runShell } from "./shell";
import type { Budget } from "./budget";

/** The exact prompt the user cares about: how do we make this UBER faster. */
const UBER_FASTER_PROMPT = `HOW COULD I MAKE THIS UBER FASTER.

A command/script line breached its latency budget. It is slow. Question why
it needs to do work at all — e.g. "why are we sleeping at all", why a sync
wait, why a full rebuild, why network when a cache exists. Prefer REMOVING or
AVOIDING work entirely; then parallelize, cache, reduce IO, compile, retry.

Return ONLY a single, correct, faster shell command (no prose, no markdown
fences, no "here is" — just the command). It may be empty if the work can be
skipped (e.g. the whole thing was a sleep). Preserve the command's semantics
exactly; only make it faster.

Line:
%s

Measured execution:
- took %dms (budget was %dms; remaining %dms)
`;

export interface IAutoFixResult {
  /** original slow line */
  slug: string;
  /** the model's proposed faster command (null if none usable) */
  proposed: string | null;
  /** verification result of the proposed command under budget */
  verified: "unverified" | "passed" | "still-slow";
  /** measured ms of the proposed command when it was verified */
  verifyMs?: number;
  /** yes when the provider rate-limited (429) — limiter shed, not failure */
  rateLimited?: boolean;
  /** suggested wait before retry when rateLimited */
  retryAfterMs?: number;
  /** the raw model text (redacted, truncated) */
  modelReply: string;
  /** outcome kinds of the model call */
  callOutcome?: "ok" | "rate_limited" | "error";
}

/**
 * Ask the model to make a slow line UBER faster, then verify the proposal under
 * the budget. `target` carries provider/model/apiKey explicitly (rule 2: no
 * process.env reach-around in engines). Returns a structured result so the
 * caller can fall back to forge-borrow when the model is unavailable.
 */
export async function autoFix({
  line,
  measuredMs,
  budget,
  target,
  transport,
  doVerify = true,
  systemPrompt,
}: {
  line: string;
  measuredMs: number;
  budget: Budget;
  target: IModelTarget;
  transport?: {
    fetchJson: (
      url: string,
      init: {
        method: "POST";
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
      },
    ) => Promise<{
      status: number;
      json: unknown;
      headers?: { get(n: string): string | null };
    }>;
  };
  doVerify?: boolean;
  systemPrompt?: string;
}): Promise<IAutoFixResult> {
  const brief = (UBER_FASTER_PROMPT || "")
    .replace("%s", line)
    .replace("%d", String(measuredMs))
    .replace("%d", String(budget.totalMs))
    .replace("%d", String(budget.remainingMs()));

  const outcome: ILlmCallOutcome = await callLlm(target, brief, {
    timeoutMs: Math.min(
      90_000,
      Math.max(4_000, budget.remainingMs() || 60_000),
    ),
    maxResponseBytes: 16_000,
    systemPrompt:
      systemPrompt ??
      "You are a brutally honest senior principal performance engineer auditing a junior dev's command. WTF is this shitty junior dev code? It's slow. Call it out briefly, then return ONLY a valid, far faster shell command — remove the slop entirely if it buys nothing (a sleep that exists for no reason? return empty). No fluff, no hedging, just the fast command.",
    ...(transport ? { transport } : {}),
  });

  if (outcome.ok) {
    const proposed = parseCommand(outcome.markdown);
    let verified: IAutoFixResult["verified"] = "unverified";
    let verifyMs: number | undefined;
    if (proposed && doVerify) {
      const r = await runShell(proposed, budget.deadlineForOp(), process.cwd());
      budget.charge(r.ms);
      verified = !r.timedOut && r.rc === 0 ? "passed" : "still-slow";
      verifyMs = r.ms;
    }
    return {
      slug: line,
      proposed,
      verified,
      ...(verifyMs !== undefined ? { verifyMs } : {}),
      modelReply: outcome.markdown.slice(0, 4000),
      callOutcome: "ok",
    };
  }

  if (outcome.ok === false && outcome.kind === "rate_limited") {
    return {
      slug: line,
      proposed: null,
      verified: "unverified",
      rateLimited: true,
      retryAfterMs: outcome.retryAfterMs,
      modelReply: outcome.error,
      callOutcome: "rate_limited",
    };
  }

  return {
    slug: line,
    proposed: null,
    verified: "unverified",
    modelReply: outcome.ok === false ? outcome.error : "unknown",
    callOutcome: outcome.ok === false ? "error" : "error",
  };
}

/**
 * Pull a single shell command out of the model's reply: first line, strips
 * prose/markdown fences. Returns null when the reply is empty or the line
 * looks like prose (no shell-ish tokens) — caller falls back.
 */
export function parseCommand(reply: string): string | null {
  if (!reply) return null;
  let line =
    reply
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/i, "")
      .split("\n")[0]
      ?.trim() ?? "";
  // Strip a leading "here is"/"the fastest"/quote run from prose-y replies.
  line = line
    .replace(
      /^("the |here['’]s |the (fastest|better|faster) (command|way)|just use )/i,
      "",
    )
    .replace(/["`]$/g, "");
  if (!line || /^[a-z\s,.!?]+$/i.test(line)) return null; // prose, not a command
  return line;
}

/** Re-export so integrations that track 429 sheds don't re-implement parsing. */
export { retryAfterMs };
