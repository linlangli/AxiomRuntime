import { backupHistoryStorage, historyStorageStatus, migrateHistoryStorage, restoreHistoryStorage, rollbackHistoryStorage } from "../../core/config/history-database.js";

export async function runHistoryCommand(args: string[]): Promise<void> {
  const [action = "status", ...options] = args;
  if (action === "restore") {
    if (options.length !== 2 || !options.includes("--yes")) throw new Error("Stop all Runtime writers, then run `ai history restore <backup.sqlite> --yes`.");
    console.log(JSON.stringify(await restoreHistoryStorage(options.find(option => option !== "--yes")!), null, 2));
    return;
  }
  if (!["status", "migrate", "backup", "rollback"].includes(action) || options.some(option => option !== "--yes")) throw new Error("Usage: ai history [status|migrate|backup|rollback --yes]");
  if (action === "rollback" && !options.includes("--yes")) throw new Error("Stop all Runtime writers, then run `ai history rollback --yes` to export current SQLite history to JSON.");
  const result = action === "status" ? await historyStorageStatus() : action === "migrate" ? await migrateHistoryStorage() : action === "backup" ? { file: await backupHistoryStorage() } : await rollbackHistoryStorage();
  console.log(JSON.stringify(result, null, 2));
}
