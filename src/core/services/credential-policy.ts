import path from "node:path";
import { getConfigRoot } from "../config/paths.js";
import { updateJsonFile } from "../config/json-store.js";
import type { ServiceCredential } from "../config/service-exposure.js";

export async function admitServiceRequest(credential: ServiceCredential): Promise<boolean> {
  const policy = credential.policy;
  if (!policy?.requestQuota && !policy?.requestsPerMinute) return true;
  let admitted = false;
  const minute = Math.floor(Date.now() / 60_000);
  await updateJsonFile<Record<string, { total: number; minute: number; count: number }>>(path.join(getConfigRoot(), "service-admission.json"), {}, current => {
    const previous = current[credential.id] ?? { total: 0, minute, count: 0 };
    const count = previous.minute === minute ? previous.count : 0;
    if (policy.requestQuota && previous.total >= policy.requestQuota || policy.requestsPerMinute && count >= policy.requestsPerMinute) return current;
    admitted = true;
    return { ...current, [credential.id]: { total: previous.total + 1, minute, count: count + 1 } };
  });
  return admitted;
}
