export type IEmbedProviderId = "openai" | "voyage" | "cohere" | "freeinference";

export interface IDiscoveredEmbedProvider {
  readonly id: IEmbedProviderId;
  readonly present: boolean;
}

const PROVIDER_ENV_VARS: Readonly<Record<IEmbedProviderId, string>> = {
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  cohere: "COHERE_API_KEY",
  // estate freeinference/deepseek provider (keyring/settings via secretsmith).
  // Prefer FREEINFERENCE_API_KEY, fall back to DEEPSEEK_API_KEY.
  freeinference: "FREEINFERENCE_API_KEY",
};

const hasNonEmptyValue = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

/** FreeInference key resolvable under either of the estate's two key names. */
function freeinferenceKey(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const primary = env.FREEINFERENCE_API_KEY;
  if (hasNonEmptyValue(primary)) return primary?.trim();
  const fallback = env.DEEPSEEK_API_KEY;
  return hasNonEmptyValue(fallback) ? fallback?.trim() : undefined;
}

export const discoverProviders = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly IDiscoveredEmbedProvider[] =>
  (Object.keys(PROVIDER_ENV_VARS) as IEmbedProviderId[]).map((id) => ({
    id,
    present:
      id === "freeinference"
        ? freeinferenceKey(env) !== undefined
        : hasNonEmptyValue(env[PROVIDER_ENV_VARS[id]]),
  }));

export const resolveProviderApiKey = (
  providerId: IEmbedProviderId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  if (providerId === "freeinference") return freeinferenceKey(env);
  const envVar = PROVIDER_ENV_VARS[providerId];
  const value = env[envVar];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};
