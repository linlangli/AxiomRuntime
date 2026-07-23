export type MemoryScope = "global" | "bot";
export type MemoryCategory = "profile" | "persona" | "credential" | "fact" | "preference" | "note" | "skill";
export type MemoryDuration = "permanent" | "short_term";

export type MemoryEntry = {
  id: number;
  chatId: string;
  scope: MemoryScope;
  botId: string | null;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  priority: number;
  duration: MemoryDuration;
  encrypted: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemorySaveInput = {
  scope?: MemoryScope;
  category?: MemoryCategory;
  title?: string;
  content: string;
  tags?: string[];
  priority?: number;
  duration?: MemoryDuration;
  expiresAt?: number | null;
  encrypted?: boolean;
};

export type MemoryQueryInput = {
  chatId: number | string;
  botId: string;
  query?: string;
  limit?: number;
};

export type MemoryInjection = {
  prompt: string;
  entries: MemoryEntry[];
};
