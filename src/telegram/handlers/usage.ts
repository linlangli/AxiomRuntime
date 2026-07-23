import type { Context } from "grammy";
import { resolveProviderForTool } from "../../core/runner/fallback.js";
import type { TokenUsage } from "../../core/types.js";
import { estimateTokenCostUsdFromConfig, upsertModelPrice } from "../../core/usage/pricing.js";
import type { TelegramConfig } from "../config.js";
import { Formatter, formatUsagePriceInvalid, formatUsagePricePrompt, formatUsagePriceSaved } from "../interaction/formatter.js";
import { buildUsagePricingKeyboard } from "../interaction/keyboards.js";
import type { SessionManager } from "../session/manager.js";
import type { TelegramProviderUsage, TelegramSession } from "../session/types.js";

export type UsageDeps = {
  sessionManager: SessionManager;
  config?: TelegramConfig;
};

export async function showUsagePanel(
  ctx: Context,
  deps: UsageDeps,
  options: { edit?: boolean; tokenOnly?: boolean } = {}
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const resolved = await getResolvedProvider(session, deps.config);
  const usage = resolved.provider ? findProviderUsage(session, resolved.provider.name) : undefined;
  const estimatedCostUsd = resolved.provider && usage
    ? await estimateStoredUsageCost(resolved.provider.name, resolved.provider.model, usage)
    : undefined;
  const missingPrice = Boolean(
    resolved.provider
    && usage
    && usage.costUsd <= 0
    && usage.unknownCostCount > 0
    && estimatedCostUsd === undefined
    && !options.tokenOnly
  );
  const extra = {
    parse_mode: "HTML",
    ...(missingPrice ? { reply_markup: buildUsagePricingKeyboard() } : {})
  } as const;
  const text = Formatter.sessionUsage(session, resolved.provider, resolved.error, {
    estimatedCostUsd,
    tokenOnly: options.tokenOnly,
    missingPrice
  });

  if (options.edit) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch {
      // The original usage message may no longer be editable.
    }
  }
  await ctx.reply(text, extra);
}

export async function askUsagePrice(ctx: Context, deps: UsageDeps, options: { edit?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const resolved = await getResolvedProvider(session, deps.config);
  if (!resolved.provider) {
    await ctx.reply(Formatter.sessionUsage(session, undefined, resolved.error), { parse_mode: "HTML" });
    return;
  }

  deps.sessionManager.update(session.id, { setupStep: "usage_price_input" });
  const text = formatUsagePricePrompt(resolved.provider);
  const extra = { parse_mode: "HTML" } as const;
  if (options.edit) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch {
      // The original usage message may no longer be editable.
    }
  }
  await ctx.reply(text, extra);
}

export async function handleUsagePriceInput(ctx: Context, deps: UsageDeps, rawText: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = deps.sessionManager.getOrCreate(chatId);
  const resolved = await getResolvedProvider(session, deps.config);
  if (!resolved.provider) {
    deps.sessionManager.update(session.id, { setupStep: "ready" });
    await ctx.reply(Formatter.sessionUsage(session, undefined, resolved.error), { parse_mode: "HTML" });
    return;
  }

  const parsed = parseModelPriceInput(rawText);
  if (!parsed) {
    await ctx.reply(formatUsagePriceInvalid(), { parse_mode: "HTML" });
    return;
  }

  await upsertModelPrice(resolved.provider.name, resolved.provider.model, {
    inputPerMillionUsd: parsed.inputPerMillionUsd,
    outputPerMillionUsd: parsed.outputPerMillionUsd,
    cacheReadPerMillionUsd: parsed.cacheReadPerMillionUsd
  });
  deps.sessionManager.update(session.id, { setupStep: "ready" });
  await ctx.reply(
    formatUsagePriceSaved(
      resolved.provider,
      parsed.inputPerMillionUsd,
      parsed.outputPerMillionUsd,
      parsed.cacheReadPerMillionUsd
    ),
    { parse_mode: "HTML" }
  );
  await showUsagePanel(ctx, deps);
}

export function parseModelPriceInput(rawText: string): {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
} | null {
  const numbers = rawText
    .replace(/\$/g, "")
    .match(/\d+(?:\.\d+)?/g)
    ?.map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0) ?? [];
  if (numbers.length < 3) return null;
  return {
    inputPerMillionUsd: numbers[0]!,
    outputPerMillionUsd: numbers[1]!,
    cacheReadPerMillionUsd: numbers[2]!
  };
}

async function getResolvedProvider(
  session: TelegramSession,
  config?: TelegramConfig
): Promise<{ provider?: { name: string; model: string }; error?: string }> {
  try {
    const resolved = await resolveProviderForTool(session.engine, config?.provider, config?.model);
    return { provider: { name: resolved.provider.name, model: resolved.model } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function findProviderUsage(session: TelegramSession, providerName: string): TelegramProviderUsage | undefined {
  return session.providerUsage.find((item) => item.provider === providerName);
}

async function estimateStoredUsageCost(
  providerName: string,
  model: string,
  usage: TelegramProviderUsage
): Promise<number | undefined> {
  const tokenUsage: TokenUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens
  };
  return estimateTokenCostUsdFromConfig(providerName, model, tokenUsage);
}
