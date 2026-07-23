import { getIntegrationStatePath } from "../config/paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../config/json-store.js";

export type ProviderChange =
  { type: "added" | "updated" | "deleted"; provider: string; previousProvider?: string; at: string };

export type IntegrationProviderSyncState = {
  syncedProviderRevision: number;
  pendingProviderChanges: ProviderChange[];
};

export type IntegrationState = {
  providerRevision: number;
  integrations: Record<string, IntegrationProviderSyncState>;
};

export type IntegrationRegistration = {
  name: string;
};

const EMPTY_STATE: IntegrationState = {
  providerRevision: 0,
  integrations: {}
};
const registeredIntegrations = new Set<string>();

export async function readIntegrationState(): Promise<IntegrationState> {
  const raw = await readJsonFile<Partial<IntegrationState>>(getIntegrationStatePath(), EMPTY_STATE);
  return normalizeIntegrationState(raw);
}

export async function writeIntegrationState(state: IntegrationState): Promise<void> {
  await writeJsonFile(getIntegrationStatePath(), normalizeIntegrationState(state));
}

export async function recordProviderChange(change: Omit<ProviderChange, "at">): Promise<IntegrationState> {
  return updateJsonFile(getIntegrationStatePath(), EMPTY_STATE, (raw) => {
    const state = normalizeIntegrationState(raw);
    const nextRevision = state.providerRevision + 1;
    const providerChange = { ...change, at: new Date().toISOString() };
    const integrations = { ...state.integrations };
    for (const name of registeredIntegrations) {
      integrations[name] = appendProviderChange(getIntegrationProviderState(state, name), providerChange);
    }
    return {
      providerRevision: nextRevision,
      integrations
    };
  });
}

export async function markIntegrationProvidersSynced(integrationName: string): Promise<void> {
  const name = normalizeIntegrationName(integrationName);
  await updateJsonFile(getIntegrationStatePath(), EMPTY_STATE, (raw) => {
    const state = normalizeIntegrationState(raw);
    const synced: IntegrationProviderSyncState = {
      syncedProviderRevision: state.providerRevision,
      pendingProviderChanges: []
    };
    const integrations = { ...state.integrations, [name]: synced };
    return {
      providerRevision: state.providerRevision,
      integrations
    };
  });
}

export async function hasPendingProviderChanges(integrationName: string): Promise<boolean> {
  const state = await readIntegrationState();
  const integration = getIntegrationProviderState(state, integrationName);
  return state.providerRevision !== integration.syncedProviderRevision || integration.pendingProviderChanges.length > 0;
}

export function registerIntegration(registration: IntegrationRegistration): void {
  registeredIntegrations.add(normalizeIntegrationName(registration.name));
}

export function getIntegrationProviderState(
  state: IntegrationState,
  integrationName: string
): IntegrationProviderSyncState {
  const name = normalizeIntegrationName(integrationName);
  return state.integrations[name] ?? {
    syncedProviderRevision: state.providerRevision,
    pendingProviderChanges: []
  };
}

function normalizeIntegrationState(value: Partial<IntegrationState>): IntegrationState {
  const integrations = normalizeIntegrationMap(value.integrations);
  return {
    providerRevision: Number(value.providerRevision ?? 0),
    integrations
  };
}

function normalizeIntegrationMap(value: unknown): Record<string, IntegrationProviderSyncState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const integrations: Record<string, IntegrationProviderSyncState> = {};
  for (const [name, raw] of Object.entries(value)) {
    const normalizedName = normalizeIntegrationName(name);
    integrations[normalizedName] = normalizeIntegrationProviderSyncState(raw as Partial<IntegrationProviderSyncState>);
  }
  return integrations;
}

function normalizeIntegrationProviderSyncState(value: Partial<IntegrationProviderSyncState>): IntegrationProviderSyncState {
  return {
    syncedProviderRevision: Number(value.syncedProviderRevision ?? 0),
    pendingProviderChanges: Array.isArray(value.pendingProviderChanges)
      ? value.pendingProviderChanges.filter(isProviderChange)
      : []
  };
}

function appendProviderChange(
  state: IntegrationProviderSyncState,
  change: ProviderChange
): IntegrationProviderSyncState {
  return {
    syncedProviderRevision: state.syncedProviderRevision,
    pendingProviderChanges: [...state.pendingProviderChanges, change]
  };
}

function normalizeIntegrationName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error("Integration name cannot be empty.");
  }
  return name;
}

function isProviderChange(value: unknown): value is ProviderChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<ProviderChange>;
  return (change.type === "added" || change.type === "updated" || change.type === "deleted")
    && typeof change.provider === "string"
    && typeof change.at === "string";
}
