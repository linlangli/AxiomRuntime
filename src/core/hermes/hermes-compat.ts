import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HermesModelListPatchResult = {
  status: "patched" | "already-supported" | "skipped";
  filePath: string;
  message: string;
};

const PATCH_MARKER = "# AI Gateway: include callable-only user-config model candidates v2";
const PICKER_RESTRICT_MARKER = "# AI Gateway: restrict picker to managed user providers v1";
const CALLABLE_ONLY_PATCH_MARKER = "# AI Gateway: include callable-only user-config model candidates";
const CALLABLE_PATCH_MARKER = "# AI Gateway: include callable user-config model candidates";
const LEGACY_PATCH_MARKER = "# AI Gateway: include user-config model candidates";

const LEGACY_USER_PROVIDER_MODEL_BLOCK = `            default_model = ep_cfg.get("default_model", "")

            models_list = []
            if default_model:
                models_list.append(default_model)

            # Try to probe /v1/models if URL is set (but don't block on it)
            # For now just show what we know from config`;

const PATCHED_USER_PROVIDER_MODEL_BLOCK = `            default_model = ep_cfg.get("default_model", "")
            configured_models = ep_cfg.get("models", [])
            has_configured_models = "models" in ep_cfg

            ${PATCH_MARKER}
            models_list = []
            if isinstance(configured_models, dict):
                models_list.extend([str(model) for model in configured_models.keys() if model])
            elif isinstance(configured_models, list):
                models_list.extend([str(model) for model in configured_models if model])
            if default_model and (not has_configured_models or str(default_model) in models_list):
                models_list.insert(0, str(default_model))
            models_list = list(dict.fromkeys(models_list))
            if has_configured_models and not models_list:
                continue

            # Try to probe /v1/models if URL is set (but don't block on it)
            # For now just show what we know from config`;

const USER_PROVIDER_MODEL_BLOCK_PATTERN =
  /            default_model = ep_cfg\.get\("default_model", ""\)\n[\s\S]*?            # Try to probe \/v1\/models if URL is set \(but don't block on it\)\n            # For now just show what we know from config/;

const MANAGED_PROVIDER_HELPER = `

def _ai_gateway_managed_user_providers(user_providers) -> bool:
    try:
        if not user_providers or not isinstance(user_providers, dict):
            return False
        for _cfg in user_providers.values():
            if isinstance(_cfg, dict) and _cfg.get("ai_gateway_managed") is True:
                return True
    except Exception:
        return False
    return False
`;

const PICKER_FILTER_BLOCK = `    if _ai_gateway_managed_user_providers(user_providers):
        ${PICKER_RESTRICT_MARKER}
        results = [
            r for r in results
            if r.get("is_user_defined") or r.get("source") in ("user-config", "model-config")
        ]

`;

export async function ensureLocalHermesModelListSupport(): Promise<HermesModelListPatchResult> {
  const filePath = getLocalHermesModelSwitchPath();
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "skipped", filePath, message: "Hermes model_switch.py not found." };
    }
    throw error;
  }

  let nextSource = source;
  if (!nextSource.includes(PATCH_MARKER)) {
    nextSource = nextSource.includes(CALLABLE_ONLY_PATCH_MARKER)
    || source.includes(CALLABLE_PATCH_MARKER)
    || source.includes(LEGACY_PATCH_MARKER)
    || source.includes(LEGACY_USER_PROVIDER_MODEL_BLOCK)
      ? nextSource.replace(USER_PROVIDER_MODEL_BLOCK_PATTERN, PATCHED_USER_PROVIDER_MODEL_BLOCK)
      : nextSource;
  }
  nextSource = applyPickerRestrictionPatch(nextSource);

  if (nextSource === source) {
    if (source.includes(PATCH_MARKER) && source.includes(PICKER_RESTRICT_MARKER)) {
      return { status: "already-supported", filePath, message: "Hermes AI Gateway /model support is already present." };
    }
    return { status: "skipped", filePath, message: "Hermes model_switch.py did not match the known AI Gateway compatibility blocks." };
  }

  const backupPath = `${filePath}.ai-gateway.bak`;
  await fs.copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.writeFile(filePath, nextSource, "utf8");
  return { status: "patched", filePath, message: "Patched Hermes to show only AI Gateway-managed providers and models in /model." };
}

function applyPickerRestrictionPatch(source: string): string {
  if (source.includes(PICKER_RESTRICT_MARKER)) return source;
  let next = source;
  if (!next.includes("def _ai_gateway_managed_user_providers(")) {
    next = next.replace(/(^|\n)def list_authenticated_providers\(/, `$1${MANAGED_PROVIDER_HELPER}\ndef list_authenticated_providers(`);
  }
  next = next.replace("    # Sort: current provider first, then by model count descending\n", `${PICKER_FILTER_BLOCK}    # Sort: current provider first, then by model count descending\n`);
  next = next.replace("    if include_moa:\n", "    if include_moa and not _ai_gateway_managed_user_providers(user_providers):\n");
  return next;
}

function getLocalHermesModelSwitchPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "hermes_cli", "model_switch.py");
}
