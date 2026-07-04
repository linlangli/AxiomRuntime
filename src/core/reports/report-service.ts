import fs from "node:fs/promises";
import { readCache } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { getReportPath, getReportsDir } from "../config/paths.js";
import { readUsage } from "../config/usage-store.js";
import { generateProjectContext } from "../context/context-service.js";
import { writeLog } from "../logs/log-service.js";
import { getSession } from "../sessions/session-service.js";
import type { Provider, SessionRecord, UsageEvent } from "../types.js";

export type ReportResult = {
  filePath: string;
  content: string;
};

type TokenSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  eventCount: number;
};

export async function generateSessionReport(sessionId: string): Promise<ReportResult> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const [providers, cache, usage] = await Promise.all([
    readProviders(),
    readCache(),
    readUsage()
  ]);
  const provider = providers.find((item) => item.name === session.provider) ?? null;
  const providerCache = cache.providers[session.provider] ?? null;
  const tokenSummary = summarizeSessionUsage(session, usage.events);
  const projectContext = await buildProjectContext(session);
  const content = renderReport({
    session,
    provider,
    providerHealth: providerCache?.status ?? "unknown",
    providerLastCheckedAt: providerCache?.lastCheckedAt ?? null,
    providerModelCount: providerCache?.models.length ?? 0,
    tokenSummary,
    projectContext
  });

  const filePath = getReportPath(session.id);
  await fs.mkdir(getReportsDir(), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await writeLog({
    category: "usage",
    action: "report_generated",
    message: `Generated session report: ${filePath}`,
    metadata: { sessionId: session.id, provider: session.provider, model: session.model }
  });

  return { filePath, content };
}

function summarizeSessionUsage(session: SessionRecord, events: UsageEvent[]): TokenSummary {
  const startedAt = new Date(session.startedAt).getTime();
  const endedAt = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const matched = events.filter((event) => {
    const createdAt = new Date(event.createdAt).getTime();
    return event.provider === session.provider
      && event.tool === session.tool
      && event.model === session.model
      && createdAt >= startedAt
      && createdAt <= endedAt;
  });

  return matched.reduce<TokenSummary>(
    (summary, event) => ({
      inputTokens: summary.inputTokens + event.inputTokens,
      outputTokens: summary.outputTokens + event.outputTokens,
      totalTokens: summary.totalTokens + event.totalTokens,
      eventCount: summary.eventCount + 1
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, eventCount: 0 }
  );
}

async function buildProjectContext(session: SessionRecord): Promise<string> {
  try {
    const context = await generateProjectContext(session.projectPath);
    return context.content.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "# Project Context",
      "",
      `Project context could not be generated for ${session.projectPath}.`,
      "",
      `Error: ${message}`
    ].join("\n");
  }
}

function renderReport(input: {
  session: SessionRecord;
  provider: Provider | null;
  providerHealth: string;
  providerLastCheckedAt: string | null;
  providerModelCount: number;
  tokenSummary: TokenSummary;
  projectContext: string;
}): string {
  const duration = getDuration(input.session);
  const providerLevel = input.provider ? String(input.provider.level) : "(provider removed)";
  const defaultModel = input.provider?.model ?? "(provider removed)";

  return `${[
    "# AI Gateway Session Report",
    "",
    "This report is generated for agent handoff. It intentionally excludes API keys and does not estimate token usage.",
    "",
    "## Session Summary",
    "",
    `- Session ID: ${input.session.id}`,
    `- Tool: ${input.session.tool}`,
    `- Provider: ${input.session.provider}`,
    `- Model: ${input.session.model}`,
    `- Provider priority level: ${providerLevel}`,
    `- Provider default model: ${defaultModel}`,
    `- Permission mode: ${input.session.mode}`,
    `- Project path: ${input.session.projectPath}`,
    `- Status: ${input.session.status}`,
    `- Exit code: ${input.session.exitCode ?? "(running)"}`,
    `- Started at: ${input.session.startedAt}`,
    `- Ended at: ${input.session.endedAt ?? "(running)"}`,
    `- Duration: ${duration}`,
    `- Fallback: ${input.session.fallbackFrom ? `${input.session.fallbackFrom} -> ${input.session.provider}` : "none"}`,
    "",
    "## Token Usage",
    "",
    `- Usage events matched to this session: ${input.tokenSummary.eventCount}`,
    `- Input tokens: ${input.tokenSummary.inputTokens}`,
    `- Output tokens: ${input.tokenSummary.outputTokens}`,
    `- Total tokens: ${input.tokenSummary.totalTokens}`,
    "",
    "Token usage is counted only from structured provider usage events recorded by AI Gateway.",
    "",
    "## Provider Snapshot",
    "",
    `- Health: ${input.providerHealth}`,
    `- Last checked at: ${input.providerLastCheckedAt ?? "(never)"}`,
    `- Discovered model count: ${input.providerModelCount}`,
    "",
    "## Current Session Profile",
    "",
    renderSessionProfile(input.session),
    "",
    "## User Profile",
    "",
    renderUserProfile(),
    "",
    "## Session Context",
    "",
    input.projectContext
  ].join("\n")}\n`;
}

function renderSessionProfile(session: SessionRecord): string {
  const lines = [
    `- This session launched ${session.tool} through AI Gateway with provider ${session.provider}.`,
    `- The selected model was ${session.model}.`,
    `- The working project was ${session.projectPath}.`
  ];
  if (session.fallbackFrom) {
    lines.push(`- The session used fallback from ${session.fallbackFrom} to ${session.provider}.`);
  }
  if (session.status === "running") {
    lines.push("- The session was still marked as running when the report was generated.");
  }
  return lines.join("\n");
}

function renderUserProfile(): string {
  return [
    "- User-facing documentation should be concise and written in Chinese.",
    "- Agent-facing project/context documents can be written in English.",
    "- The user prefers practical interactive workflows that reduce command memorization.",
    "- Documentation should be updated whenever CLI behavior, configuration, or architecture changes.",
    "- Provider secrets must be masked in logs, terminal output, and reports."
  ].join("\n");
}

function getDuration(session: SessionRecord): string {
  const startedAt = new Date(session.startedAt).getTime();
  const endedAt = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return "(unknown)";
  }
  const seconds = Math.round((endedAt - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}
