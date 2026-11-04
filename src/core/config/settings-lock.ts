import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { getConfigRoot } from "./paths.js";
import { withJsonFileLock } from "./json-store.js";

const operations = new AsyncLocalStorage<string>();

export async function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const file = path.join(getConfigRoot(), ".web-restore");
  if (operations.getStore() === file) return operation();
  return withJsonFileLock(file, () => operations.run(file, operation));
}
