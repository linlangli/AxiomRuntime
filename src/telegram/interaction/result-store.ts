import type { ExecutionResult } from "../engine/types.js";

const TTL_MS = 5 * 60 * 1000;

type Entry = { result: ExecutionResult; expires: number };

export class ResultStore {
  private store = new Map<number, Entry>();

  set(chatId: number, result: ExecutionResult): void {
    this.cleanup();
    this.store.set(chatId, { result, expires: Date.now() + TTL_MS });
  }

  get(chatId: number): ExecutionResult | undefined {
    const entry = this.store.get(chatId);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(chatId);
      return undefined;
    }
    return entry.result;
  }

  delete(chatId: number): void {
    this.store.delete(chatId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now > entry.expires) this.store.delete(id);
    }
  }
}
