export type TelegramNetworkRetryOptions = {
  delaysMs?: number[];
};

const DEFAULT_RETRY_DELAYS_MS = [250, 750];

export async function withTelegramNetworkRetry<T>(
  operation: () => Promise<T>,
  options: TelegramNetworkRetryOptions = {}
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !isRetryableTelegramNetworkError(error)) {
        throw error;
      }
      await delay(delays[attempt]);
    }
  }
}

export function isRetryableTelegramNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Network request|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\b5\d\d\b/i.test(message);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
