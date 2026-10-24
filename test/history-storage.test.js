import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupHistoryStorage, historyStorageStatus, migrateHistoryStorage, restoreHistoryStorage, rollbackHistoryStorage } from "../dist/core/config/history-database.js";
import { appendUsageEvents, readUsage, ensureUsageFile } from "../dist/core/config/usage-store.js";
import { addSession, readSessions, updateSession, clearSessions } from "../dist/core/config/session-store.js";
import { queryWebHistory } from "../dist/core/web/history-service.js";
import { readRecentLogs, writeLog } from "../dist/core/logs/log-service.js";
import { runDoctor } from "../dist/core/status/doctor-service.js";

const usage = index => ({ id: `usage-${index}`, createdAt: "2026-10-24T12:00:00.000Z", provider: index % 2 ? "first" : "second", model: "gpt-test", tool: "codex", source: "proxy", inputTokens: index, outputTokens: 1, totalTokens: index + 1, sessionId: "ses_test", traceId: `trace-${index}` });
const session = { id: "ses_test", tool: "codex", provider: "first", model: "gpt-test", mode: "ask", projectPath: "/private/project", startedAt: "2026-10-24T12:00:00.000Z", endedAt: null, status: "running", exitCode: null, fallbackFrom: null };

async function isolated(run) {
  const previous = process.env.AI_GATEWAY_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-history-"));
  process.env.AI_GATEWAY_HOME = root;
  try { await run(root); } finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_HOME; else process.env.AI_GATEWAY_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("history migration preserves legacy records, deduplicates concurrent writes and uses one authoritative ledger", () => isolated(async root => {
  await appendUsageEvents([usage(1), usage(2)]);
  await addSession(session);
  const legacy = await fs.readFile(path.join(root, "usage.json"), "utf8");
  assert.equal((await migrateHistoryStorage()).backend, "sqlite");
  await Promise.all(Array.from({ length: 5 }, () => appendUsageEvents([usage(3), usage(4)])));
  assert.deepEqual((await readUsage()).events, [1, 2, 3, 4].map(usage));
  await updateSession(session.id, { actualProvider: "second", actualModel: "actual-model" });
  assert.equal((await readSessions()).sessions[0].actualProvider, "second");
  await ensureUsageFile();
  assert.equal(await fs.readFile(path.join(root, "usage.json"), "utf8"), legacy);
  const page = await queryWebHistory(new URLSearchParams({ kind: "usage", provider: "second", limit: "1", offset: "1" }));
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, "usage-2");
  const sessions = await queryWebHistory(new URLSearchParams({ kind: "sessions", provider: "second" }));
  assert.equal(sessions.total, 1);
  assert.doesNotMatch(JSON.stringify(sessions), /private\/project/);
  assert.equal((await queryWebHistory(new URLSearchParams({ kind: "sessions", q: "private/project" }))).total, 0);
  assert.equal((await queryWebHistory(new URLSearchParams({ kind: "usage", q: "%' OR 1=1 --" }))).total, 0);
  assert.equal(await clearSessions(), 1);
  assert.equal((await readSessions()).sessions.length, 0);
}));

test("SQLite backup, restore and JSON rollback preserve current records and exclude other Runtime state", () => isolated(async root => {
  await appendUsageEvents([usage(1)]); await addSession(session);
  await fs.writeFile(path.join(root, "memory.sqlite"), "do-not-touch");
  await migrateHistoryStorage();
  const backup = await backupHistoryStorage();
  await appendUsageEvents([usage(2)]);
  await restoreHistoryStorage(path.basename(backup));
  assert.deepEqual((await readUsage()).events, [usage(1)]);
  await assert.rejects(restoreHistoryStorage("../../escape.sqlite"), /Invalid/);
  await appendUsageEvents([usage(3)]);
  await rollbackHistoryStorage();
  assert.equal((await historyStorageStatus()).backend, "json");
  assert.deepEqual((await readUsage()).events, [usage(1), usage(3)]);
  assert.deepEqual((await readSessions()).sessions, [session]);
  assert.equal(await fs.readFile(path.join(root, "memory.sqlite"), "utf8"), "do-not-touch");
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  const database = new Database(backup, { readonly: true });
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok"); database.close();
}));

test("corrupt history fails closed and invalid legacy migration leaves JSON authoritative", () => isolated(async root => {
  await fs.writeFile(path.join(root, "usage.json"), '{"events":null}');
  await assert.rejects(migrateHistoryStorage(), /Invalid legacy/);
  assert.equal((await historyStorageStatus()).backend, "json");
  await fs.writeFile(path.join(root, "history.sqlite"), "corrupt");
  const diagnostics = await runDoctor({ fix: true, checkProviders: false, checkNativeDependencies: false });
  assert.ok(diagnostics.some(item => item.group === "History" && item.status === "error"));
  assert.equal(await fs.readFile(path.join(root, "history.sqlite"), "utf8"), "corrupt");
  await assert.rejects(readUsage());
  await assert.rejects(appendUsageEvents([usage(1)]));
  assert.equal(await fs.readFile(path.join(root, "usage.json"), "utf8"), '{"events":null}');
}));

test("missing active history never falls back to old JSON and verified backups can repair a missing or corrupt database", () => isolated(async root => {
  await appendUsageEvents([usage(1)]); await migrateHistoryStorage();
  const backup = await backupHistoryStorage();
  await fs.rm(path.join(root, "history.sqlite"));
  await assert.rejects(readUsage(), /missing/);
  await restoreHistoryStorage(path.basename(backup));
  assert.equal((await readUsage()).events.length, 1);
  await fs.writeFile(path.join(root, "history.sqlite"), "invalid-database");
  await restoreHistoryStorage(path.basename(backup));
  assert.equal((await readUsage()).events.length, 1);
}));

test("bounded reverse log reading preserves UTF-8, ignores malformed rows and paginates older safe projections", () => isolated(async root => {
  await writeLog({ category: "usage", action: "old", message: "中文旧日志", traceId: "old", metadata: { apiKey: "private-key" } });
  await fs.appendFile(path.join(root, ".ai-gateway.log"), "bad-json\n");
  for (let index = 0; index < 20; index += 1) await writeLog({ category: "usage", action: `row_${index}`, message: "中文".repeat(3000) });
  assert.deepEqual((await readRecentLogs(2)).map(row => row.action), ["row_18", "row_19"]);
  assert.equal((await readRecentLogs(100))[0].message, "中文旧日志");
  const page = await queryWebHistory(new URLSearchParams({ kind: "logs", limit: "1", offset: "20" }));
  assert.equal(page.total, 21); assert.equal(page.items[0].action, "old");
  assert.doesNotMatch(JSON.stringify(page), /private-key/);
}));
