import type { TelegramEngineName, TelegramPermissionMode } from "../config.js";

export type TelegramSessionStatus = "idle" | "running" | "waiting_approval" | "closed";
export type TelegramSetupStep = "workdir" | "custom_workdir" | "edit_custom_workdir" | "cli" | "ready";

export type TelegramAttachment = {
  name: string;
  path: string;
  text: string;
  createdAt: string;
};

export type TelegramProviderUsage = {
  provider: string;
  model: string;
  requestCount: number;
  costUsd: number;
  unknownCostCount: number;
  updatedAt: string;
};

export type TelegramSession = {
  id: string;
  chatId: number;
  engine: TelegramEngineName;
  engineSessionId: string | null;
  cwd: string;
  permissionMode: TelegramPermissionMode;
  approveAll: boolean;
  setupStep: TelegramSetupStep;
  status: TelegramSessionStatus;
  messageCount: number;
  attachments: TelegramAttachment[];
  providerUsage: TelegramProviderUsage[];
  createdAt: string;
  lastActiveAt: string;
};

export type TelegramSessionCreateInput = {
  chatId: number;
  engine: TelegramEngineName;
  cwd: string;
  permissionMode: TelegramPermissionMode;
  approveAll?: boolean;
  setupStep?: TelegramSetupStep;
  status?: TelegramSessionStatus;
};
