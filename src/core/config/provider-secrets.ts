import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { getConfigRoot } from "./paths.js";

export interface SecretStorePort {
  read(reference: string): Promise<string | null>;
  write(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

const adapters = new AsyncLocalStorage<SecretStorePort>();
const referencePattern = /^provider_[a-f0-9-]{36}$/;

export function withSecretStore<T>(adapter: SecretStorePort, operation: () => T): T {
  return adapters.run(adapter, operation);
}

export function getProviderSecretStore(): SecretStorePort {
  const entry = async (reference: string) => {
    if (!referencePattern.test(reference)) throw new Error("Invalid Provider secret reference.");
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      const namespace = createHash("sha256").update(getConfigRoot()).digest("hex").slice(0, 24);
      return new AsyncEntry(`AxiomRuntime.providers.${namespace}`, reference, { linux: { store: "secret-service" } });
    } catch {
      throw new Error("OS credential store unavailable. Unlock the system keychain or install a supported credential backend.");
    }
  };
  return adapters.getStore() ?? {
    read: async reference => (await entry(reference)).getPassword(AbortSignal.timeout(15_000)),
    write: async (reference, secret) => (await entry(reference)).setPassword(secret, AbortSignal.timeout(15_000)),
    delete: async reference => (await entry(reference)).deleteCredential(AbortSignal.timeout(15_000))
  };
}

export type ProviderDocument = { backend: "plaintext" | "keyring"; rows: Record<string, unknown>[] };

export function parseProviderDocument(raw: unknown): ProviderDocument {
  let backend: ProviderDocument["backend"] = "plaintext";
  let rows = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const document = raw as Record<string, unknown>;
    if (document.version !== 1 || document.secretBackend !== "keyring" || !Array.isArray(document.providers)) throw new Error("Unsupported providers.json format.");
    backend = "keyring";
    rows = document.providers;
  }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("providers.json must contain a Provider array or a versioned keyring document.");
  if (rows.some(row => "apiKeyRef" in row)) backend = "keyring";
  return { backend, rows };
}

export async function hydrateProviderSecrets(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    const { apiKeyRef, ...provider } = row;
    if (apiKeyRef !== undefined) {
      if (typeof apiKeyRef !== "string" || !referencePattern.test(apiKeyRef) || "apiKey" in row) throw new Error("Invalid Provider credential reference.");
      let secret: string | null;
      try { secret = await getProviderSecretStore().read(apiKeyRef); }
      catch { throw new Error("Cannot read Provider credentials. Unlock the OS credential store; plaintext fallback is disabled."); }
      if (!secret) throw new Error("Provider credential missing from the OS credential store. Restore the credential or explicitly replace it.");
      provider.apiKey = secret;
    }
    result.push(provider);
  }
  return result;
}

export async function protectProviderSecrets(rows: Record<string, unknown>[], previous: Record<string, unknown>[] = []): Promise<unknown> {
  const reusable = new Map<string, string>();
  const protectedRows: Record<string, unknown>[] = [];
  for (const row of previous) {
    if (typeof row.apiKeyRef !== "string" || !referencePattern.test(row.apiKeyRef)) continue;
    const value = await getProviderSecretStore().read(row.apiKeyRef);
    if (value) reusable.set(value, row.apiKeyRef);
  }
  for (const row of rows) {
    const { apiKey, ...provider } = row;
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Provider apiKey cannot be empty.");
    let reference = reusable.get(apiKey);
    if (!reference) {
      reference = `provider_${randomUUID()}`;
      try {
        await getProviderSecretStore().write(reference, apiKey);
        if (await getProviderSecretStore().read(reference) !== apiKey) throw new Error("verification failed");
      } catch {
        throw new Error("Cannot protect Provider credentials. Configuration was not replaced; no plaintext fallback is allowed.");
      }
      reusable.set(apiKey, reference);
    }
    protectedRows.push({ ...provider, apiKeyRef: reference });
  }
  return { version: 1, secretBackend: "keyring", providers: protectedRows };
}
