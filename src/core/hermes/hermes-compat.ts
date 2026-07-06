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
const GATEWAY_USER_PROVIDERS_MARKER = "# AI Gateway: pass gateway user providers into model switch v1";
const GATEWAY_PERSIST_PICKER_MARKER = "# AI Gateway: persist Telegram picker model switch v1";
const RUN_AGENT_EMPTY_TOOL_NAME_MARKER = "# AI Gateway: drop empty tool call names before chat completions v1";
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

const GATEWAY_PICKER_SWITCH_BLOCK = `                        result = _switch_model(
                            raw_input=model_id,
                            current_provider=_cur_provider,
                            current_model=_cur_model,
                            current_base_url=_cur_base_url,
                            current_api_key=_cur_api_key,
                            is_global=False,
                            explicit_provider=provider_slug,
                        )`;

const PATCHED_GATEWAY_PICKER_SWITCH_BLOCK = `                        result = _switch_model(
                            raw_input=model_id,
                            current_provider=_cur_provider,
                            current_model=_cur_model,
                            current_base_url=_cur_base_url,
                            current_api_key=_cur_api_key,
                            is_global=False,
                            explicit_provider=provider_slug,
                            user_providers=user_provs,  ${GATEWAY_USER_PROVIDERS_MARKER}
                        )`;

const GATEWAY_DIRECT_SWITCH_BLOCK = `        result = _switch_model(
            raw_input=model_input,
            current_provider=current_provider,
            current_model=current_model,
            current_base_url=current_base_url,
            current_api_key=current_api_key,
            is_global=persist_global,
            explicit_provider=explicit_provider,
        )`;

const PATCHED_GATEWAY_DIRECT_SWITCH_BLOCK = `        result = _switch_model(
            raw_input=model_input,
            current_provider=current_provider,
            current_model=current_model,
            current_base_url=current_base_url,
            current_api_key=current_api_key,
            is_global=persist_global,
            explicit_provider=explicit_provider,
            user_providers=user_provs,  ${GATEWAY_USER_PROVIDERS_MARKER}
        )`;

const GATEWAY_PICKER_OVERRIDE_BLOCK = `                        _self._session_model_overrides[_session_key] = {
                            "model": result.new_model,
                            "provider": result.target_provider,
                            "api_key": result.api_key,
                            "base_url": result.base_url,
                            "api_mode": result.api_mode,
                        }

                        # Build confirmation text`;

const PATCHED_GATEWAY_PICKER_OVERRIDE_BLOCK = `                        _self._session_model_overrides[_session_key] = {
                            "model": result.new_model,
                            "provider": result.target_provider,
                            "api_key": result.api_key,
                            "base_url": result.base_url,
                            "api_mode": result.api_mode,
                        }

                        try:
                            if config_path.exists():
                                with open(config_path, encoding="utf-8") as f:
                                    cfg = yaml.safe_load(f) or {}
                            else:
                                cfg = {}
                            model_cfg = cfg.setdefault("model", {})
                            model_cfg["default"] = result.new_model
                            model_cfg["provider"] = result.target_provider
                            if result.base_url:
                                model_cfg["base_url"] = result.base_url
                            if result.api_key:
                                model_cfg["api_key"] = result.api_key
                            from hermes_cli.config import save_config
                            save_config(cfg)
                        except Exception as exc:
                            logger.warning("Failed to persist picker model switch: %s", exc)
                        ${GATEWAY_PERSIST_PICKER_MARKER}

                        # Build confirmation text`;

const RUN_AGENT_METHOD_INSERT_ANCHOR = `    def _supports_reasoning_extra_body(self) -> bool:`;

const RUN_AGENT_EMPTY_TOOL_NAME_METHOD = `    @staticmethod
    def _ai_gateway_drop_empty_tool_call_names(messages):
        """Remove invalid empty-name tool calls before strict chat-completions requests."""
        if not isinstance(messages, list):
            return messages

        changed = False
        removed_call_ids = set()
        cleaned = []
        for msg in messages:
            if not isinstance(msg, dict):
                cleaned.append(msg)
                continue

            role = msg.get("role")
            if role == "tool":
                tool_call_id = msg.get("tool_call_id")
                if not isinstance(tool_call_id, str) or not tool_call_id.strip() or tool_call_id in removed_call_ids:
                    changed = True
                    continue
                cleaned.append(msg)
                continue

            tool_calls = msg.get("tool_calls")
            if not isinstance(tool_calls, list):
                cleaned.append(msg)
                continue

            valid_tool_calls = []
            for tool_call in tool_calls:
                if not isinstance(tool_call, dict):
                    valid_tool_calls.append(tool_call)
                    continue
                function = tool_call.get("function")
                name = function.get("name") if isinstance(function, dict) else None
                if isinstance(name, str) and name.strip():
                    valid_tool_calls.append(tool_call)
                    continue
                call_id = tool_call.get("id")
                if isinstance(call_id, str) and call_id:
                    removed_call_ids.add(call_id)
                changed = True

            if len(valid_tool_calls) == len(tool_calls):
                cleaned.append(msg)
                continue

            next_msg = dict(msg)
            if valid_tool_calls:
                next_msg["tool_calls"] = valid_tool_calls
                cleaned.append(next_msg)
            else:
                next_msg.pop("tool_calls", None)
                content = next_msg.get("content")
                if isinstance(content, str) and content.strip():
                    cleaned.append(next_msg)
                elif content and not isinstance(content, str):
                    cleaned.append(next_msg)

        return cleaned if changed else messages

`;

const RUN_AGENT_SANITIZE_CALL_ANCHOR = `        # Qwen portal: normalize content to list-of-dicts, inject cache_control.
        # Must run AFTER codex sanitization so we transform the final messages.`;

const RUN_AGENT_SANITIZE_CALL_BLOCK = `        ${RUN_AGENT_EMPTY_TOOL_NAME_MARKER}
        sanitized_messages = self._ai_gateway_drop_empty_tool_call_names(sanitized_messages)

        # Qwen portal: normalize content to list-of-dicts, inject cache_control.
        # Must run AFTER codex sanitization so we transform the final messages.`;

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
  const gatewayPatch = await ensureLocalHermesGatewayModelSwitchSupport();
  const runAgentPatch = await ensureLocalHermesRunAgentRequestSanitizerSupport();
  const runAgentCompatible = runAgentPatch.status === "already-supported"
    || (runAgentPatch.status === "skipped" && runAgentPatch.message.includes("not found"));

  if (nextSource === source) {
    if (
      source.includes(PATCH_MARKER)
      && source.includes(PICKER_RESTRICT_MARKER)
      && gatewayPatch.status === "already-supported"
      && runAgentCompatible
    ) {
      return { status: "already-supported", filePath, message: "Hermes AI Gateway /model support is already present." };
    }
    if (gatewayPatch.status === "patched") {
      return { status: "patched", filePath: gatewayPatch.filePath, message: gatewayPatch.message };
    }
    if (runAgentPatch.status === "patched") {
      return { status: "patched", filePath: runAgentPatch.filePath, message: runAgentPatch.message };
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

async function ensureLocalHermesGatewayModelSwitchSupport(): Promise<HermesModelListPatchResult> {
  const filePath = getLocalHermesGatewayRunPath();
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "skipped", filePath, message: "Hermes gateway run.py not found." };
    }
    throw error;
  }

  let nextSource = source;
  nextSource = nextSource.replace(GATEWAY_PICKER_SWITCH_BLOCK, PATCHED_GATEWAY_PICKER_SWITCH_BLOCK);
  nextSource = nextSource.replace(GATEWAY_DIRECT_SWITCH_BLOCK, PATCHED_GATEWAY_DIRECT_SWITCH_BLOCK);
  if (!nextSource.includes(GATEWAY_PERSIST_PICKER_MARKER)) {
    nextSource = nextSource.replace(GATEWAY_PICKER_OVERRIDE_BLOCK, PATCHED_GATEWAY_PICKER_OVERRIDE_BLOCK);
  }

  if (nextSource === source) {
    if (source.includes(GATEWAY_USER_PROVIDERS_MARKER) && source.includes(GATEWAY_PERSIST_PICKER_MARKER)) {
      return { status: "already-supported", filePath, message: "Hermes gateway /model switch support is already present." };
    }
    return { status: "skipped", filePath, message: "Hermes gateway run.py did not match the known AI Gateway compatibility blocks." };
  }

  const backupPath = `${filePath}.ai-gateway.bak`;
  await fs.copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.writeFile(filePath, nextSource, "utf8");
  return { status: "patched", filePath, message: "Patched Hermes gateway /model switching to resolve AI Gateway providers." };
}

async function ensureLocalHermesRunAgentRequestSanitizerSupport(): Promise<HermesModelListPatchResult> {
  const filePath = getLocalHermesRunAgentPath();
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "skipped", filePath, message: "Hermes run_agent.py not found." };
    }
    throw error;
  }

  if (source.includes(RUN_AGENT_EMPTY_TOOL_NAME_MARKER)) {
    return { status: "already-supported", filePath, message: "Hermes chat-completions request sanitizer is already present." };
  }

  let nextSource = source;
  if (!nextSource.includes("def _ai_gateway_drop_empty_tool_call_names(")) {
    nextSource = nextSource.replace(RUN_AGENT_METHOD_INSERT_ANCHOR, `${RUN_AGENT_EMPTY_TOOL_NAME_METHOD}${RUN_AGENT_METHOD_INSERT_ANCHOR}`);
  }
  nextSource = nextSource.replace(RUN_AGENT_SANITIZE_CALL_ANCHOR, RUN_AGENT_SANITIZE_CALL_BLOCK);

  if (nextSource === source) {
    return { status: "skipped", filePath, message: "Hermes run_agent.py did not match the known AI Gateway request sanitizer blocks." };
  }

  const backupPath = `${filePath}.ai-gateway.bak`;
  await fs.copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.writeFile(filePath, nextSource, "utf8");
  return { status: "patched", filePath, message: "Patched Hermes chat-completions requests to drop empty tool call names." };
}

function getLocalHermesModelSwitchPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "hermes_cli", "model_switch.py");
}

function getLocalHermesGatewayRunPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "gateway", "run.py");
}

function getLocalHermesRunAgentPath(): string {
  const root = process.env.AI_GATEWAY_HERMES_AGENT_DIR
    ? path.resolve(process.env.AI_GATEWAY_HERMES_AGENT_DIR)
    : path.join(os.homedir(), ".hermes", "hermes-agent");
  return path.join(root, "run_agent.py");
}
