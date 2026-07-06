import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HermesModelListPatchResult = {
  status: "patched" | "already-supported" | "skipped";
  filePath: string;
  message: string;
};

const PATCH_MARKER = "# AI Gateway: include callable-only user-config model candidates v2";
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

  if (source.includes(PATCH_MARKER)) {
    return { status: "already-supported", filePath, message: "Hermes user-config provider model list support is already present." };
  }

  const nextSource = source.includes(CALLABLE_ONLY_PATCH_MARKER)
    || source.includes(CALLABLE_PATCH_MARKER)
    || source.includes(LEGACY_PATCH_MARKER)
    || source.includes(LEGACY_USER_PROVIDER_MODEL_BLOCK)
    ? source.replace(USER_PROVIDER_MODEL_BLOCK_PATTERN, PATCHED_USER_PROVIDER_MODEL_BLOCK)
    : source;

  if (nextSource === source) {
    return { status: "skipped", filePath, message: "Hermes model_switch.py did not match the known user-provider model block." };
  }

  const backupPath = `${filePath}.ai-gateway.bak`;
  await fs.copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.writeFile(filePath, nextSource, "utf8");
  return { status: "patched", filePath, message: "Patched Hermes to show all AI Gateway user-provider models in /model." };
}

function getLocalHermesModelSwitchPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "hermes_cli", "model_switch.py");
}
