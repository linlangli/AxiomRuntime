import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProviders, restoreProviders, updateProviders, writeProviders } from "../dist/core/config/providers-store.js";
import { withSecretStore } from "../dist/core/config/provider-secrets.js";
import { migrateProviderSecrets, providerSecretStatus } from "../dist/core/config/provider-secret-service.js";
import { createSettingsBackup, applyLocalSettings } from "../dist/core/web/local-settings.js";
import { runDoctor } from "../dist/core/status/doctor-service.js";

const provider = { name: "first", baseUrl: "https://example.test", apiKey: "private-original-key", mode: "ask", level: 1, model: "gpt-test" };

async function isolated(run) {
  const previous = process.env.AI_GATEWAY_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-secrets-"));
  process.env.AI_GATEWAY_HOME = root;
  const values = new Map();
  const adapter = { read: async reference => values.get(reference) ?? null, write: async (reference, value) => { values.set(reference, value); }, delete: async reference => values.delete(reference) };
  try { await withSecretStore(adapter, () => run({ root, values, adapter })); }
  finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Provider migration protects current keys and snapshots while preserving exact runtime credentials", () => isolated(async ({ root }) => {
  await writeProviders([provider]);
  const backup = await createSettingsBackup();
  assert.equal((await providerSecretStatus()).plaintextBackups, 1);
  assert.deepEqual(await migrateProviderSecrets(), { backend: "keyring", protectedProviders: 1, plaintextProviders: 0, plaintextBackups: 0 });
  const config = await fs.readFile(path.join(root, "providers.json"), "utf8");
  assert.doesNotMatch(config, /private-original-key|"apiKey"/);
  assert.doesNotMatch(await fs.readFile(path.join(root, "web-backups", `${backup.id}.json`), "utf8"), /private-original-key|"apiKey"/);
  assert.deepEqual(await readProviders(), [provider]);
  const diagnostics = await runDoctor({ fix: true, checkProviders: false, checkNativeDependencies: false });
  assert.equal(diagnostics.some(item => item.group === "Providers" && item.status === "error"), false);
  await updateProviders(rows => rows.map(row => ({ ...row, name: "renamed" })));
  assert.equal((await readProviders())[0].apiKey, provider.apiKey);
  await applyLocalSettings({ action: "restore", id: backup.id });
  assert.deepEqual(await readProviders(), [provider]);
}));

test("Key rotations retain immutable snapshot references, restores cannot downgrade and empty configuration stays protected", () => isolated(async ({ root, values }) => {
  await writeProviders([provider]);
  await migrateProviderSecrets();
  const old = JSON.parse(await fs.readFile(path.join(root, "providers.json"), "utf8"));
  await updateProviders(rows => rows.map(row => ({ ...row, apiKey: "private-rotated-key" })));
  assert.equal(values.size, 2);
  await restoreProviders(old);
  assert.equal((await readProviders())[0].apiKey, provider.apiKey);
  await restoreProviders([{ ...provider, apiKey: "legacy-snapshot-key" }]);
  assert.equal((await providerSecretStatus()).backend, "keyring");
  await writeProviders([]);
  await writeProviders([provider]);
  assert.equal((await providerSecretStatus()).protectedProviders, 1);
  assert.doesNotMatch(await fs.readFile(path.join(root, "providers.json"), "utf8"), /private-original-key/);
}));

test("Locked or missing vault credentials fail closed and failed migration preserves the original document", () => isolated(async ({ root, values, adapter }) => {
  await writeProviders([provider]);
  const original = await fs.readFile(path.join(root, "providers.json"), "utf8");
  await withSecretStore({ ...adapter, write: async () => { throw new Error("private-backend-error"); } }, async () => {
    await assert.rejects(migrateProviderSecrets(), error => !error.message.includes("private") && /Configuration was not replaced/.test(error.message));
  });
  assert.equal(await fs.readFile(path.join(root, "providers.json"), "utf8"), original);
  await migrateProviderSecrets();
  const protectedDocument = await fs.readFile(path.join(root, "providers.json"), "utf8");
  await withSecretStore({ ...adapter, read: async () => { throw new Error("locked"); } }, async () => {
    await assert.rejects(readProviders(), /Unlock/);
    await assert.rejects(writeProviders([provider]), /Unlock/);
  });
  values.clear();
  await assert.rejects(readProviders(), /missing/);
  assert.equal(await fs.readFile(path.join(root, "providers.json"), "utf8"), protectedDocument);
}));

test("Explicit rollback exports original and rotated snapshot credentials without deleting vault versions", () => isolated(async ({ root, values }) => {
  await writeProviders([provider]);
  await migrateProviderSecrets();
  const backup = await createSettingsBackup();
  await updateProviders(rows => rows.map(row => ({ ...row, apiKey: "rotated" })));
  await migrateProviderSecrets(true);
  assert.equal((await providerSecretStatus()).backend, "plaintext");
  assert.equal((await readProviders())[0].apiKey, "rotated");
  assert.match(await fs.readFile(path.join(root, "web-backups", `${backup.id}.json`), "utf8"), /private-original-key/);
  assert.equal(values.size, 2);
}));
