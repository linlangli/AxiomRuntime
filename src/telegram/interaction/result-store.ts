import type { ExecutionResult } from "../engine/types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function resolveTtlMs(): number {
  const raw = process.env.TELEGRAM_RESULT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

type Entry = { result: ExecutionResult; expires: number };

export class ResultStore {
  private store = new Map<number, Entry>();
  private ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? resolveTtlMs();
  }

  set(chatId: number, result: ExecutionResult): void {
    this.cleanup();
    this.store.set(chatId, { result, expires: Date.now() + this.ttlMs });
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
