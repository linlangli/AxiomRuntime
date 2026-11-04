import fs from "node:fs/promises";
import path from "node:path";
import { getConfigRoot, getProvidersPath } from "./paths.js";
import { readJsonFile, updateJsonFile } from "./json-store.js";
import { withSettingsLock } from "./settings-lock.js";
import { decodeProviders } from "./providers-store.js";
import { parseProviderDocument, protectProviderSecrets } from "./provider-secrets.js";
import { writeLog } from "../logs/log-service.js";

async function backupPaths(): Promise<string[]> {
  const directory = path.join(getConfigRoot(), "web-backups");
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  return names.filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).map(name => path.join(directory, name));
}

export async function providerSecretStatus() {
  const document = parseProviderDocument(await readJsonFile<unknown>(getProvidersPath(), []));
  let plaintextBackups = 0;
  for (const file of await backupPaths()) {
    const backup = await readJsonFile<{ files?: Record<string, unknown> }>(file, {});
    const providers = backup.files?.["providers.json"];
    if (providers && parseProviderDocument(providers).rows.some(row => "apiKey" in row)) plaintextBackups += 1;
  }
  return { backend: document.backend, protectedProviders: document.rows.filter(row => "apiKeyRef" in row).length, plaintextProviders: document.rows.filter(row => "apiKey" in row).length, plaintextBackups };
}

export async function migrateProviderSecrets(rollback = false) {
  await withSettingsLock(async () => {
    const convert = async (raw: unknown) => {
      const providers = await decodeProviders(raw);
      return rollback ? providers : protectProviderSecrets(providers, parseProviderDocument(raw).rows);
    };
    if (!rollback) await updateJsonFile<unknown>(getProvidersPath(), [], convert);
    for (const file of await backupPaths()) {
      await updateJsonFile<{ files?: Record<string, unknown> }>(file, {}, async backup => {
        if (!backup.files?.["providers.json"]) return backup;
        return { ...backup, files: { ...backup.files, "providers.json": await convert(backup.files["providers.json"]) } };
      });
    }
    if (rollback) await updateJsonFile<unknown>(getProvidersPath(), [], convert);
  });
  await writeLog({ category: "provider", action: rollback ? "provider_secrets_rollback" : "provider_secrets_migrated", message: rollback ? "Provider credentials explicitly restored to plaintext." : "Provider credentials migrated to the OS credential store." });
  return providerSecretStatus();
}
