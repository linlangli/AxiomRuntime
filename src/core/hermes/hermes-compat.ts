import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HermesModelListPatchResult = {
  status: "patched" | "already-supported" | "skipped";
  filePath: string;
  message: string;
};

const PATCH_MARKER = "# AI Gateway: include user-config model candidates";

const LEGACY_USER_PROVIDER_MODEL_BLOCK = `            default_model = ep_cfg.get("default_model", "")

            models_list = []
            if default_model:
                models_list.append(default_model)

            # Try to probe /v1/models if URL is set (but don't block on it)
            # For now just show what we know from config`;

const PATCHED_USER_PROVIDER_MODEL_BLOCK = `            default_model = ep_cfg.get("default_model", "")
            configured_models = ep_cfg.get("models", [])

            ${PATCH_MARKER}
            models_list = []
            if isinstance(configured_models, dict):
                models_list.extend([str(model) for model in configured_models.keys() if model])
            elif isinstance(configured_models, list):
                models_list.extend([str(model) for model in configured_models if model])
            if default_model:
                models_list.insert(0, str(default_model))
            models_list = list(dict.fromkeys(models_list))

            # Try to probe /v1/models if URL is set (but don't block on it)
            # For now just show what we know from config`;

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

  if (source.includes(PATCH_MARKER) || source.includes('configured_models = ep_cfg.get("models"')) {
    return { status: "already-supported", filePath, message: "Hermes user-config provider model list support is already present." };
  }

  if (!source.includes(LEGACY_USER_PROVIDER_MODEL_BLOCK)) {
    return { status: "skipped", filePath, message: "Hermes model_switch.py did not match the known user-provider model block." };
  }

  const backupPath = `${filePath}.ai-gateway.bak`;
  await fs.copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.writeFile(filePath, source.replace(LEGACY_USER_PROVIDER_MODEL_BLOCK, PATCHED_USER_PROVIDER_MODEL_BLOCK), "utf8");
  return { status: "patched", filePath, message: "Patched Hermes to show all AI Gateway user-provider models in /model." };
}

function getLocalHermesModelSwitchPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "hermes_cli", "model_switch.py");
}
