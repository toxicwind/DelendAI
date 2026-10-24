/**
 * llm/client.ts — DelendAI's shared LLM-completion primitive.
 *
 * Moved out of `@delendai/audit` (was `lib/services/llm-client.service.ts`) so
 * ANY plugin — code-race, iterate, audit — can race a slow command against a
 * model without shelling to an external CLI or re-implementing provider
 * dispatch. This is the canonical "uses DelendAI completions" path.
 *
 * Broad guidance (inherited from the audit fan-out):
 * - **No env-var reach-around.** API keys are passed explicitly via a target;
 *   this primitive never reads `process.env` on its own (plugin-authoring
 *   layer 2 in AGENTS.md).
 * - **Stateless**, bounded timeouts, secret-redacting on the error envelope.
 * - **429-aware (rate limit = limiter shed, not failure).** Matches estate
 *   doctrine: "a 429 with retry-after is a local Thresher/limiter shed, not
 *   the provider". On HTTP 429 we read `Retry-After` / `x-ratelimit-reset`
 *   and surface a `retryable` outcome with the suggested wait, so callers can
 *   back off and retry instead of treating it as a hard provider failure.
 */
import { redactSecrets } from "@delendai/core/public";

export type LlmProvider =
  "hodos" | "openrouter" | "anthropic" | "google" | "openai" | "freeinference";

/** The estate's cloud router (merged cutover 2026-10-14): hodos (:25193) is THE
 *  router. OpenAI-compatible; key via HODOS_API_KEY. This is the fleet's model
 *  ENTRY — every completion (code-race autoFix, plugins) routes through it. */
export const HODOS_BASE_URL = "http://127.0.0.1:25193/v1";
/** Default routed model: Nemotron 3.5 Super VL — agentic/coding reasoning with
 *  tool calling on the free lane. */
export const HODOS_ROUTER_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
/** Ordered fallback models — every one VERIFIED to complete through :25193.
 *  The racer walks the WHOLE list when a model is unavailable upstream
 *  (502/404), so one dead lane can never disable the autonomous fix.
 *  "Target them all." */
export const HODOS_FALLBACK_MODELS = [
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "openai/gpt-oss-20b",
  "stepfun-ai/step-5-preview",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

/** HTTP statuses that mean "this model lane is unavailable right now" — the
 *  call is worth retrying on the NEXT model, not a hard failure. */
const UPSTREAM_UNAVAILABLE = new Set([404, 502, 503, 504]);

export interface IModelTarget {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
}

export interface IResolvedTarget {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ILlmCallResult {
  readonly target: IModelTarget;
  readonly markdown: string;
  readonly elapsedMs: number;
}

export interface ILlmCallError {
  readonly target: IModelTarget;
  readonly error: string;
  readonly elapsedMs: number;
}

/**
 * A rate-limited (HTTP 429) outcome. Distinct from a hard failure: the caller
 * SHOULD honor `retryAfterMs` and retry, because the estate treats a 429 as a
 * limiter shed rather than a provider defect.
 */
export interface ILlmCallRateLimited {
  readonly target: IModelTarget;
  readonly error: string;
  readonly elapsedMs: number;
  /** Suggested wait before retry: seconds from `Retry-After` (or
   *  seconds-until-reset from `x-ratelimit-reset`), else 0 (unknown). */
  readonly retryAfterMs: number;
}

export type ILlmCallOutcome =
  | ({ readonly ok: true } & ILlmCallResult)
  | ({ readonly ok: false; readonly kind: "error" } & ILlmCallError)
  | ({
      readonly ok: false;
      readonly kind: "rate_limited";
    } & ILlmCallRateLimited);

export interface ILlmClientOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly systemPrompt?: string;
  readonly transport?: IHttpTransport;
}

export interface IHttpTransport {
  readonly fetchJson: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    },
  ) => Promise<{
    readonly status: number;
    readonly json: unknown;
    readonly headers?: { get(n: string): string | null };
  }>;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_SYSTEM_PROMPT =
  "You are a precise engineering assistant. Return ONLY the concrete result " +
  "requested (an optimized command, a patch, or a short explanation). No preamble.";

const PROVIDER_URL: Readonly<Record<LlmProvider, string>> = {
  hodos: HODOS_BASE_URL + "/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  openai: "https://api.openai.com/v1/chat/completions",
  freeinference: "https://freeinference.org/v1/chat/completions",
};

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Build a TARGET that routes ANY model through the estate's super-provider,
 * Hodos (:25193) — the fleet's model ENTRY. Whether the caller wants
 * freeinference, openrouter, nvidia, or a plain router model, it sends the
 * request to (:25193) and Hodos resolves + routes upstream.
 *
 * Rule 2 (AGENTS.md): no process.env reach-around in engines — the apiKey is
 * passed explicitly by the host/plugin, never read here.
 */
export const hodosTarget = (model: string, apiKey: string): IModelTarget => ({
  provider: "hodos",
  model,
  apiKey,
});

const defaultTransport: IHttpTransport = {
  async fetchJson(url, init) {
    const res = await fetch(url, init);
    const json: unknown = await res.json().catch(() => ({}));
    return {
      status: res.status,
      json,
      headers: { get: (n: string) => res.headers.get(n) },
    };
  },
};

export const resolveTarget = (
  target: IModelTarget,
  brief: string,
  systemPrompt: string,
): IResolvedTarget => {
  if (target.provider === "google") {
    const url =
      `${PROVIDER_URL.google}/${encodeURIComponent(target.model)}` +
      `:generateContent?key=${encodeURIComponent(target.apiKey)}`;
    return {
      provider: target.provider,
      model: target.model,
      url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: brief }] }],
        generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
      }),
    };
  }
  if (target.provider === "anthropic") {
    return {
      provider: target.provider,
      model: target.model,
      url: PROVIDER_URL[target.provider],
      headers: {
        "content-type": "application/json",
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: target.model,
        system: systemPrompt,
        messages: [{ role: "user", content: brief }],
        max_tokens: DEFAULT_MAX_TOKENS,
      }),
    };
  }
  return {
    provider: target.provider,
    model: target.model,
    url: PROVIDER_URL[target.provider],
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: brief },
      ],
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: false,
    }),
  };
};

const extractMarkdown = (
  provider: LlmProvider,
  payload: unknown,
): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  switch (provider) {
    case "hodos":
    case "openrouter":
    case "openai":
    case "freeinference": {
      const choices = p.choices;
      if (!Array.isArray(choices) || choices.length === 0) return null;
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const t = (part as Record<string, unknown>).text;
            return typeof t === "string" ? t : "";
          })
          .filter((s) => s.length > 0)
          .join("\n");
      }
      return null;
    }
    case "anthropic": {
      const content = p.content;
      if (!Array.isArray(content)) return null;
      return content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const b = block as Record<string, unknown>;
          return b.type === "text" && typeof b.text === "string" ? b.text : "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    }
    case "google": {
      const candidates = p.candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const first = candidates[0] as Record<string, unknown> | undefined;
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = content?.parts;
      if (!Array.isArray(parts)) return null;
      return parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const t = (part as Record<string, unknown>).text;
          return typeof t === "string" ? t : "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    }
  }
};

/**
 * Parse a `Retry-After` header. Accepts an HTTP-date or a bare seconds count;
 * falls back to `x-ratelimit-reset` seconds-until-reset when `Retry-After`
 * is absent. Returns ms to wait, or 0 when nothing parseable is present.
 */
export function retryAfterMs(headers?: {
  get(n: string): string | null;
}): number {
  if (!headers) return 0;
  const ra = headers.get("retry-after");
  if (ra) {
    const asSec = Number(ra);
    if (Number.isFinite(asSec)) return Math.max(0, asSec * 1000);
    const asDate = Date.parse(ra);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  }
  const rr = headers.get("x-ratelimit-reset");
  if (rr) {
    const sec = Number(rr);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  }
  return 0;
}

export const callLlm = async (
  target: IModelTarget,
  brief: string,
  options: ILlmClientOptions = {},
): Promise<ILlmCallOutcome> => {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const transport = options.transport ?? defaultTransport;

  // Target them all: for the hodos super-provider, walk the primary model
  // then every fallback on "this lane is unavailable" (404/502/503/504 or a
  // transport abort). 429 is NEVER retried — that's a limiter shed to honor,
  // not a dead lane. Endpoints like anthropic/google don't fall back (their
  // own models are explicit) — only hodos gets the walk.
  const modelChain =
    target.provider === "hodos"
      ? [
          target.model,
          ...HODOS_FALLBACK_MODELS.filter((m) => m !== target.model),
        ]
      : [target.model];

  const attempt = async (
    modelId: string,
  ): Promise<
    | { status: "ok"; outcome: ILlmCallOutcome }
    | { status: "retryable" }
    | { status: "final"; outcome: ILlmCallOutcome }
  > => {
    const attemptStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resolved = resolveTarget(
      { ...target, model: modelId },
      brief,
      systemPrompt,
    );
    let outcome: ILlmCallOutcome;
    try {
      const { status, json, headers } = await transport.fetchJson(
        resolved.url,
        {
          method: "POST",
          headers: { ...resolved.headers },
          body: resolved.body,
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (status === 429) {
        const waitMs = retryAfterMs(headers);
        const safe = redactSecrets(
          typeof json === "string" ? json : JSON.stringify(json),
        );
        outcome = {
          ok: false,
          kind: "rate_limited",
          target,
          elapsedMs: Date.now() - attemptStart,
          error: `provider ${target.provider} rate-limited (HTTP 429): ${safe.text.slice(0, 300)}`,
          retryAfterMs: waitMs,
        };
        return { status: "final", outcome }; // 429 = shed, never fall through
      }
      if (status < 200 || status >= 300) {
        const safe = redactSecrets(
          typeof json === "string" ? json : JSON.stringify(json),
        );
        if (UPSTREAM_UNAVAILABLE.has(status)) return { status: "retryable" };
        outcome = {
          ok: false,
          kind: "error",
          target,
          elapsedMs: Date.now() - attemptStart,
          error: `provider ${target.provider} returned HTTP ${status}: ${safe.text.slice(0, 500)}`,
        };
        return { status: "final", outcome };
      }
      const markdown = extractMarkdown(target.provider, json);
      if (markdown === null || markdown.length === 0) {
        outcome = {
          ok: false,
          kind: "error",
          target,
          elapsedMs: Date.now() - attemptStart,
          error: `provider ${target.provider} returned an empty or unrecognised response envelope`,
        };
        return { status: "final", outcome };
      }
      const truncated = markdown.length > maxBytes;
      const finalMarkdown = truncated
        ? `${markdown.slice(0, maxBytes)}\n\n<!-- truncated at ${maxBytes} bytes -->`
        : markdown;
      outcome = {
        ok: true,
        target,
        elapsedMs: Date.now() - attemptStart,
        markdown: finalMarkdown,
      };
      return { status: "ok", outcome };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : "unknown error";
      // transport abort / network error on a model lane -> try the next fallback
      outcome = {
        ok: false,
        kind: "error",
        target,
        elapsedMs: Date.now() - attemptStart,
        error: redactSecrets(message).text,
      };
      return modelChain.length > 1
        ? { status: "retryable" }
        : { status: "final", outcome };
    }
  };

  for (let i = 0; i < modelChain.length; i++) {
    const attemptResult = await attempt(modelChain[i]!);
    if (attemptResult.status === "ok" || attemptResult.status === "final") {
      return attemptResult.outcome;
    }
    // retryable: fall through to the next model in the chain
  }
  // exhausted every model — synthesize an honest upstream-unavailable error
  return {
    ok: false,
    kind: "error",
    target,
    elapsedMs: Date.now() - start,
    error: `all hodos models unavailable upstream (${modelChain.join(", ")})`,
  };
};

export const callLlmFanOut = async (
  targets: readonly IModelTarget[],
  brief: string,
  options: ILlmClientOptions = {},
): Promise<readonly ILlmCallOutcome[]> => {
  const bounded = targets.slice(0, 4);
  const results = await Promise.all(
    bounded.map((t) => callLlm(t, brief, options)),
  );
  return results;
};
