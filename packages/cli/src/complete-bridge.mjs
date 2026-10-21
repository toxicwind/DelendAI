// DelendAI → freeinference completions bridge for bun-scaffold.
// Usage: bun packages/cli/src/complete-bridge.mjs "<prompt>" [model]
// Runs DelendAI's REAL llm-client (callLlm) against freeinference deepseek,
// writes the markdown to stdout. Single completions source for bun-scaffold.

export {};

const [prompt, model = "deepseek-v4-flash"] = process.argv.slice(2);
if (!prompt) {
  console.error("usage: bun complete-bridge.mjs \"<prompt>\" [model]");
  process.exit(1);
}

const { callLlm } = await import("./_llm-call.mjs");

const apiKey =
  process.env.FREEINFERENCE_API_KEY || process.env.DEEPSEEK_API_KEY || "";

const outcome = await callLlm(
  { provider: "freeinference", model, apiKey },
  prompt,
  {
    systemPrompt:
      "You are a Bun build-scaffold engineer. Given a project's package.json, emit ONLY a compact JSON object of scripts. Reply with the JSON only.",
  },
);

if (outcome.ok) {
  process.stdout.write(outcome.markdown);
} else {
  process.exitCode = 1;
  process.stderr.write(outcome.error);
}