import { getIntegrationStatePath } from "../config/paths.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../config/json-store.js";

export type ProviderChange =
  { type: "added" | "updated" | "deleted"; provider: string; previousProvider?: string; at: string };

export type IntegrationState = {
  providerRevision: number;
  hermes: {
    syncedProviderRevision: number;
    pendingProviderChanges: ProviderChange[];
  };
};

const EMPTY_STATE: IntegrationState = {
  providerRevision: 0,
  hermes: {
    syncedProviderRevision: 0,
    pendingProviderChanges: []
  }
};

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
    return {
      providerRevision: state.providerRevision + 1,
      hermes: {
        syncedProviderRevision: state.hermes.syncedProviderRevision,
        pendingProviderChanges: [
          ...state.hermes.pendingProviderChanges,
          { ...change, at: new Date().toISOString() }
        ]
      }
    };
  });
}

export async function markHermesProvidersSynced(): Promise<void> {
  await updateJsonFile(getIntegrationStatePath(), EMPTY_STATE, (raw) => {
    const state = normalizeIntegrationState(raw);
    return {
      providerRevision: state.providerRevision,
      hermes: {
        syncedProviderRevision: state.providerRevision,
        pendingProviderChanges: []
      }
    };
  });
}

export async function hasPendingHermesProviderChanges(): Promise<boolean> {
  const state = await readIntegrationState();
  return state.providerRevision !== state.hermes.syncedProviderRevision || state.hermes.pendingProviderChanges.length > 0;
}

function normalizeIntegrationState(value: Partial<IntegrationState>): IntegrationState {
  const hermes = value.hermes ?? EMPTY_STATE.hermes;
  return {
    providerRevision: Number(value.providerRevision ?? 0),
    hermes: {
      syncedProviderRevision: Number(hermes.syncedProviderRevision ?? 0),
      pendingProviderChanges: Array.isArray(hermes.pendingProviderChanges)
        ? hermes.pendingProviderChanges.filter(isProviderChange)
        : []
    }
  };
}

function isProviderChange(value: unknown): value is ProviderChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<ProviderChange>;
  return (change.type === "added" || change.type === "updated" || change.type === "deleted")
    && typeof change.provider === "string"
    && typeof change.at === "string";
}
