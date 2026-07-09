import type { TelegramEngineName, TelegramPermissionMode } from "../config.js";
import type { TokenUsage } from "../../core/types.js";

export type ExecutionResult = {
  sessionId?: string;
  response: string;
  toolCalls?: ToolCallResult[];
  filesChanged?: string[];
  diff?: string;
  cost?: number;
  usage?: TokenUsage;
  duration?: number;
  provider?: string;
  model?: string;
};

export type ToolCallResult = {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
};

export type PermissionRequest = {
  id: string;
  tool: string;
  description: string;
  command?: string;
  filePath?: string;
  params: Record<string, unknown>;
};

export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export type EngineExecuteParams = {
  chatId: number;
  prompt: string;
  cwd: string;
  resume?: string | null;
  permissionMode?: TelegramPermissionMode;
  allowedTools?: string[];
  providerName?: string;
  modelName?: string;
  onPermission: PermissionHandler;
  onProgress?: (update: ProgressUpdate) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProgressUpdate = {
  phase: "thinking" | "tool_calling" | "writing" | "done";
  message?: string;
  tool?: string;
  toolKind?: "builtin" | "mcp" | "command";
  mcpServer?: string;
};

export interface Engine {
  name: TelegramEngineName;
  execute(params: EngineExecuteParams): Promise<ExecutionResult>;
  abort(chatId: number): void;
}
