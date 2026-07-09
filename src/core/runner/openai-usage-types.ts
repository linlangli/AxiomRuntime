import type { Provider, RunToolType, TokenUsage } from "../types.js";

export type OpenAiUsageProxyRecord = {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd?: number;
  costSource: "provider" | "pricing" | "unknown";
};

export type OpenAiUsageProxy = {
  baseUrl: string;
  close(): Promise<void>;
  getRecords(): OpenAiUsageProxyRecord[];
};

export type StartOpenAiUsageProxyInput = {
  provider: Provider;
  model: string;
  tool: RunToolType;
  onUsage?: (record: OpenAiUsageProxyRecord) => void | Promise<void>;
};
