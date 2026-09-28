import type { Provider, ProviderAuthScheme, ProviderRequestProfile } from "../types.js";

export type ProviderRequestPurpose = "discovery" | "openai" | "anthropic";

export function getProviderRequestProfile(provider: Provider): ProviderRequestProfile {
  return provider.requestProfile ?? {
    discoveryAuth: "bearer",
    openaiAuth: "bearer",
    anthropicAuth: "x-api-key",
    verifiedProtocols: []
  };
}

export function getProviderAuthScheme(provider: Provider, purpose: ProviderRequestPurpose): ProviderAuthScheme {
  const profile = getProviderRequestProfile(provider);
  if (purpose === "discovery") return profile.discoveryAuth;
  if (purpose === "anthropic") return profile.anthropicAuth;
  return profile.openaiAuth;
}

export function buildProviderAuthHeaders(apiKey: string, scheme: ProviderAuthScheme): Record<string, string> {
  if (scheme === "x-api-key") return { "x-api-key": apiKey };
  if (scheme === "api-key") return { "api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

export function describeProviderRequestProfile(provider: Provider): string {
  const profile = getProviderRequestProfile(provider);
  return `models=${profile.discoveryAuth}, OpenAI=${profile.openaiAuth}, Anthropic=${profile.anthropicAuth}`;
}
