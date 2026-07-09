import { readProviders } from "../config/providers-store.js";
import { readIntegrationState } from "../integrations/integration-state.js";
import type { Provider } from "../types.js";
import type { HermesRobot, UpdateHermesRobotInput } from "./hermes-types.js";

type SwitchHermesRobotsProvider = (from: string, to: Provider) => Promise<number>;
type ListHermesRobots = () => Promise<HermesRobot[]>;
type UpdateHermesRobot = (name: string, patch: UpdateHermesRobotInput) => Promise<HermesRobot>;

export async function applyPendingProviderRenamesToHermesRobots(switchProvider: SwitchHermesRobotsProvider): Promise<number> {
  const state = await readIntegrationState();
  const renameChanges = state.hermes.pendingProviderChanges.filter(
    (change) => change.type === "updated" && change.previousProvider && change.previousProvider !== change.provider
  );
  if (!renameChanges.length) return 0;

  const providers = await readProviders();
  const providerNames = new Set(providers.map((provider) => provider.name));
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const renameTargets = new Map<string, string>();

  for (const change of renameChanges) {
    if (!change.previousProvider) continue;
    for (const [from, to] of renameTargets) {
      if (to === change.previousProvider) {
        renameTargets.set(from, change.provider);
      }
    }
    renameTargets.set(change.previousProvider, change.provider);
  }

  let renamed = 0;

  for (const [from, to] of renameTargets) {
    if (!providerNames.has(to)) continue;
    renamed += await switchProvider(from, providerByName.get(to)!);
  }
  return renamed;
}

export async function switchRobotsWithMissingProvidersToFallback(
  listRobots: ListHermesRobots,
  updateRobot: UpdateHermesRobot
): Promise<number> {
  const [robots, providers] = await Promise.all([listRobots(), readProviders()]);
  const providerNames = new Set(providers.map((provider) => provider.name));
  const affected = robots.filter((robot) => !providerNames.has(robot.provider));
  if (!affected.length) return 0;

  const fallback = providers.sort((a, b) => a.level - b.level)[0];
  if (!fallback) {
    throw new Error(`Cannot sync Hermes: robot provider missing and no fallback provider exists (${affected.map((robot) => robot.name).join(", ")}).`);
  }

  for (const robot of affected) {
    await updateRobot(robot.name, { provider: fallback.name, model: fallback.model || robot.model });
  }
  return affected.length;
}
