import {
  LLM_PROVIDERS,
  type LLMProvider,
} from "realtime-avatar-contracts";

export type SecretSource = string | (() => string | null | undefined | Promise<string | null | undefined>);

export type LLMProviderCredentials = {
  apiKey: SecretSource;
};

export type OpenAICompatibleLLMProviderCredentials = LLMProviderCredentials & {
  /** OpenAI-compatible endpoint. Defaults to the runtime's configured base URL. */
  baseUrl?: string;
};

export type LLMCredentialsConfig = {
  gemini?: LLMProviderCredentials;
  openai?: OpenAICompatibleLLMProviderCredentials;
};

export type ConfiguredLLMProviders<TConfig extends LLMCredentialsConfig | undefined> =
  | "local"
  | (TConfig extends { gemini: LLMProviderCredentials } ? "gemini" : never)
  | (TConfig extends { openai: OpenAICompatibleLLMProviderCredentials } ? "openai" : never);

export function listConfiguredLLMProviders(
  config: LLMCredentialsConfig | undefined,
): readonly LLMProvider[] {
  const providers: LLMProvider[] = ["local"];
  if (config?.gemini) providers.push("gemini");
  if (config?.openai) providers.push("openai");
  return providers;
}

export function readLLMProvider(input: unknown): LLMProvider | null {
  if (!input || typeof input !== "object") return null;
  const llm = (input as { llm?: unknown }).llm;
  if (!llm || typeof llm !== "object") return null;
  const provider = (llm as { provider?: unknown; backend?: unknown }).provider ?? (llm as { backend?: unknown }).backend;
  return isLLMProvider(provider) ? provider : null;
}

export function isLLMProvider(value: unknown): value is LLMProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}
