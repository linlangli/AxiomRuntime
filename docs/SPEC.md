# AI Runtime Product Specification

> Audience: AI agents and maintainers. This document is normative and must remain in English.

## 1. Product Goal

Build an enterprise AI Runtime that continuously turns execution experience into governed, reusable organizational capability.

The existing AI Gateway is the first Runtime foundation: a local `ai` command that manages providers, models, permission modes, health, fallback, usage, Claude Code, Codex, Hermes, Telegram, sessions, and early memory capabilities.

The Runtime is the product. Models, providers, agents, memory, knowledge, skills, workflows, tools, execution, reasoning, and learning are replaceable capabilities.

The first release remains CLI-first, while the architecture must support Telegram, schedulers, a local web control panel, enterprise APIs, and future desktop clients through the same core contracts.

All surfaces must share Runtime orchestration, policy, execution, learning, and capability APIs instead of reimplementing domain behavior.

Normative product principles:

- Runtime first: capabilities belong to the Runtime, not to one surface or agent.
- Provider agnostic: no core contract depends on one model vendor.
- Plugin first: adapters and capabilities are discoverable, replaceable, composable, and governed.
- Learning by default: success and failure produce evidence, but promotion requires policy and authority.
- Organization first: optimize durable shared capability, not only a single response.
- Stable interfaces: internal implementations may evolve behind versioned contracts.
- Enhance before expand: new modules require a distinct, documented responsibility.

### Current Foundation And Target

| Stage | Product responsibility |
|---|---|
| Current Gateway foundation | provider routing, model discovery, execution launch, fallback, usage, sessions, diagnostics, Telegram, Hermes, early memory |
| Unified Execution Runtime | shared execution context, lifecycle events, permissions, retries, idempotency, tool and workflow contracts |
| Learning Runtime | governed evidence, knowledge, memory, skills, evaluation, promotion, rollback |
| Organizational Runtime | tenant and organization scope, shared capability registry, policy administration, enterprise integrations |
| Runtime Platform | stable APIs, plugin ecosystem, web/desktop governance surfaces, organizational intelligence operations |

## 2. Core User Scenarios

Users should be able to run one command:

```bash
ai
```

Then enter the interactive workflow and complete common tasks:

- Choose Claude Code or Codex CLI.
- Add providers.
- Edit provider configuration.
- View provider health and token usage.
- Select a default provider by priority.
- Automatically fall back to the next available provider when the current provider is unavailable.
- Manage Hermes robots that reuse AI Gateway providers and launch through Hermes CLI.
- Execute work through one governed Runtime context across CLI and Telegram.
- Accumulate auditable knowledge and skills without allowing model output to bypass policy.
- Promote validated capabilities to the appropriate user, project, team, or organization scope.

The latter scenarios are target Runtime behavior and must be delivered incrementally without breaking the current Gateway workflows documented below.

## 3. Commands

Interactive entry:

```bash
ai
```

Running `ai` without arguments enters interactive mode.

Help entry:

```bash
ai help
```

`ai help` opens `docs/USAGE.html`.

Direct commands:

```bash
ai help
ai use claude
ai use codex
ai use claude 51talk claude-opus-4-6
ai use codex 51talk gpt-5.5

ai add 51talk https://example.com sk-xxx

ai provider edit
ai provider list
ai status
ai log
ai context
ai session
ai session list
ai session clear
ai report
ai web
ai doctor
ai last
ai hermes
ai hermes status
ai hermes use <robot-name>
ai hermes add
ai hermes list
ai hermes edit
ai hermes clear
ai hermes delete
ai hermes import <file>
ai hermes import-local
ai hermes export
ai hermes export <robot-name>
```

## 4. Configuration Files

### User Editable: `providers.json`

Default path:

```text
~/.ai-gateway/providers.json
```

`AI_GATEWAY_HOME` can override the config directory.

`providers.json` should stay clean and only contain fields users need to understand and edit.

```json
[
  {
    "name": "51talk",
    "baseUrl": "https://example.com",
    "apiKey": "sk-xxx",
    "mode": "auto",
    "level": 1,
    "model": "claude-opus-4-6"
  }
]
```

Field definitions:

- `name`: unique provider name.
- `baseUrl`: provider API base URL.
- `apiKey`: provider API key.
- `mode`: permission mode, either `ask` or `auto`. For Claude Code, `auto` launches with `--dangerously-skip-permissions`; `ask` prompts before launch and does not add that flag.
- `level`: provider priority. Smaller numbers have higher priority. `level: 1` is the default provider.
- `model`: default model for this provider.

Rules:

- `name` must be unique.
- `mode` must be `ask` or `auto`.
- `level` controls priority. Smaller is higher priority.
- Model candidates come from internal cache, not from `providers.json`.
- Manual changes to `providers.json` must be picked up on the next command run.
- Internal runtime data should not pollute `providers.json`.
- JSON runtime stores should tolerate a complete JSON value followed by accidental trailing duplicate content, then rewrite clean JSON on the next save.
- Writes should use temp-file plus rename semantics to reduce corruption from concurrent CLI processes.

### Internal Cache: `.ai-cache.json`

Default path:

```text
~/.ai-gateway/.ai-cache.json
```

Stores internal runtime data:

- Provider health status.
- Last health check time.
- Discovered model list.
- Last error message.

Example:

```json
{
  "providers": {
    "51talk": {
      "status": "ok",
      "models": ["claude-opus-4-6", "gpt-5.5"],
      "lastCheckedAt": "2026-07-04T05:30:00.000Z",
      "lastError": null
    }
  }
}
```

### Usage Events: `usage.json`

Default path:

```text
~/.ai-gateway/usage.json
```

Stores token usage events for CLI status, web charts, and future desktop statistics.

Example:

```json
{
  "events": [
    {
      "provider": "51talk",
      "tool": "codex",
      "model": "gpt-5.5",
      "source": "doctor_deep",
      "inputTokens": 1200,
      "outputTokens": 800,
      "totalTokens": 2000,
      "createdAt": "2026-07-04T05:40:00.000Z"
    }
  ]
}
```

Token usage must be recorded only from real provider-returned usage data. Do not estimate token usage when the downstream CLI does not expose structured usage data.

### Internal Logs: `.ai-gateway.log`

Default path:

```text
~/.ai-gateway/.ai-gateway.log
```

Stores recent operational events in JSONL format:

- Command usage traces.
- Error messages.
- Provider health checks.
- Fallback and routing strategy execution.
- Doctor diagnostics.

Logs must not store full API keys. Direct command arguments that contain keys must be masked before writing logs.

### Sessions: `sessions.json`

Default path:

```text
~/.ai-gateway/sessions.json
```

Stores launch sessions:

- session id
- tool
- provider
- model
- mode
- project path
- started time
- ended time
- status
- exit code
- fallback source

### Reports: `reports/`

Default path:

```text
~/.ai-gateway/reports/
```

Stores generated session handoff reports. Reports must not contain API keys or estimated token usage.

### Hermes Robots: `hermes.json`

Default path:

```text
~/.ai-gateway/hermes.json
```

Stores AI Gateway-managed Hermes robot definitions. This file is user-editable, similar to `providers.json`.

`hermes.json` must only contain fields users need to configure directly. Internal metadata such as source, created time, updated time, health, sessions, and runtime state must not be written to this file.

Hermes robots must reference providers from `providers.json` by name. They must not duplicate API keys.

Example:

```json
[
  {
    "name": "spacex-monitor",
    "provider": "51talk-cs",
    "model": "claude-opus-4-6",
    "mode": "auto",
    "telegram": {
      "enabled": true,
      "chatId": "7476722078",
      "name": "il gnalnil"
    },
    "tasks": [
      {
        "id": "baf2c13fbe76",
        "name": "SpaceX SPCX Price Monitor",
        "type": "cron",
        "enabled": true,
        "state": "scheduled",
        "provider": "51talk-plus",
        "model": "claude-opus-4-6"
      }
    ]
  }
]
```

Rules:

- `name` must be unique.
- `provider` must reference an AI Gateway provider by name.
- `model` is the robot default model.
- `mode` is `ask` or `auto`.
- Telegram binding is optional.
- Hermes cron jobs are tasks that belong to a robot. They are not robots.
- Task schedule is stored in `hermes.json` so robots can be fully exported and restored on another machine.
- `hermes.json` must not contain API keys. Full export bundles intentionally include referenced provider API keys and must be treated as private secret files.

### Other Internal Files

- `~/.ai-gateway/hermes-state.json`: AI Gateway-managed Hermes robot runtime state.
- `~/.ai-gateway/hermes/<robot-name>/`: AI Gateway-managed isolated Hermes runtime home for each robot.
- `~/.ai-gateway/transport-proxy.json` (target): internal schema-versioned transport limits, worker queue limits, route-lease duration, circuit recovery, and supervisor restart policy. It must not store provider origins, API keys, route nonces, execution ids, prompts, or tool content.
- `.ai-gateway/context.md`: generated project context package for Claude Code and Codex.

## 5. Provider Rules

### Add Flow

Interactive:

```bash
ai add
```

Steps:

1. Input `name`.
2. Input `baseUrl`.
3. Input `apiKey`.
4. Set `mode = auto` by default.
5. Assign `level = current provider count + 1`.
6. Run connectivity test.
7. Discover available models.
8. Select default `model` from discovered models.
9. Write provider config to `providers.json`.
10. Write health status and model cache to `.ai-cache.json`.

Direct:

```bash
ai add 51talk https://example.com sk-xxx
```

If multiple models are discovered in direct mode, select the first model by default. Users can later change it with `ai provider edit`.

### Edit Flow

```bash
ai provider edit
```

Steps:

1. Select provider.
2. Select field: `name`, `baseUrl`, `apiKey`, `mode`, `level`, `model`.
3. Persist changes to `providers.json` immediately.

Rules:

- `mode` must be selected from `ask` and `auto`.
- `level` must be selected from a generated level list based on the current provider count.
- If the selected `level` is already assigned to another provider, swap the two providers' levels.
- `model` must be selected from models discovered in `.ai-cache.json`; it is not typed manually.
- If `name`, `baseUrl`, or `apiKey` changes, refresh health status and model cache.

### Use Flow

Interactive:

```bash
ai use
```

Steps:

1. Select tool: `claude` or `codex`.
2. Select provider, sorted by `level`.
3. Select model, defaulting to the provider's configured `model`.
4. Start the target CLI according to provider `mode`.

Direct:

```bash
ai use claude
ai use codex
ai use claude 51talk claude-opus-4-6
ai use codex 51talk gpt-5.5
```

Default rules:

- If provider is omitted, use the provider with `level: 1`.
- If model is omitted, use the selected provider's default `model`.
- If the provider is unavailable, trigger automatic fallback.
- Claude Code launches must pass `--model <model>` and a temporary `--settings <file>` containing `env.ANTHROPIC_API_KEY` and `env.ANTHROPIC_BASE_URL`.
- Claude Code launches with provider `mode: auto` must also pass `--dangerously-skip-permissions`; `mode: ask` must not pass it.
- Ordinary `ai use` must not mutate `~/.claude/settings.json`.
- Ordinary `ai use` must not use `--bare` by default.
- If a configured provider base URL ends with `/v1`, Claude Code launches must strip the trailing `/v1` before injecting `ANTHROPIC_BASE_URL`.
- Codex/OpenAI-compatible launches must keep the configured `/v1` suffix.
- Runtime logs must include provider, model, mode, baseUrl, command path, launch args, auth injection mode, fallback, and an API key fingerprint.
- Runtime logs must never print the full API key.
- Transport failures must log a sanitized network diagnostic with provider/model, route path, request byte count, input/tool counts, and low-level error name/code/syscall. They must not log prompts, request bodies, tool arguments, authorization, or API keys.
- Codex transport retries must use fresh upstream connections. The local proxy must not forward caller-supplied `content-length` or reuse a failed gateway keep-alive socket across attempts; request length is derived from the final forwarded body by the HTTP client.
- The Codex transport waits at most 45 seconds for upstream response headers. Two consecutive header timeouts open an execution-local short circuit so remaining Codex reconnect attempts fail immediately and Telegram can continue to the next eligible provider. This does not add a proxy-owned model request retry.
- Telegram progress edits and final delivery retry transient network, timeout, connection, and HTTP 5xx failures with bounded backoff. Request validation and formatting errors are not retried.

### Automatic Fallback

When running `ai use claude` or `ai use codex`, or when a specified provider is unavailable:

1. Sort providers by `level` ascending.
2. Skip unavailable providers.
3. Select the first healthy provider.
4. Use that provider's default `model`.
5. If the default model is incompatible with the selected tool, choose a compatible model from the cache.
6. If no compatible model exists, continue to the next provider.
7. If all providers are unavailable, show an error and suggest `ai status` / `ai doctor`.

CLI fallback output should be explicit:

```text
Provider 51talk unavailable, fallback to 1n1.
```

### List Flow

```bash
ai provider list
```

Lists provider configuration from `providers.json` without refreshing provider health. Should use a readable card-style terminal layout.

Show: `level`, `name`, `baseUrl`, masked `apiKey`, `mode`, default `model`.

### Status Flow

```bash
ai status
```

Refreshes all providers before showing results. Refresh must be lightweight: connectivity check and model discovery only. Must not send chat/completion/inference requests or intentionally consume model tokens.

Provider connectivity and downstream runtime readiness are separate:

- Provider health checks whether token-free model discovery works.
- Claude readiness uses Claude's effective base URL and a compatible Claude model.
- Codex readiness uses Codex/OpenAI's effective base URL and a compatible Codex model.
- `health: ok` must not be treated as proof that a real inference request will succeed.

Model discovery should try `{baseUrl}/models` first, then `{baseUrl}/v1/models` when the first endpoint returns non-JSON or fails.

If a provider cannot expose models without a token-consuming request, mark the model cache as unavailable or stale. Token-consuming deep tests should be reserved for `ai doctor --deep`.

Show all providers: `level`, `name`, configured `baseUrl`, Claude runtime state, Claude effective baseUrl, Codex runtime state, Codex effective baseUrl, masked `apiKey`, `mode`, health, last checked time, token usage, usage share.

Should use a card/block layout rather than a wide table so output remains readable in narrow terminal windows.

### Model Rules

Each provider has one default `model` in `providers.json`.

- `ai add` discovers models and lets the user select a default model.
- `ai provider edit` changes model by selecting from discovered models.
- Users do not manually type model names in interactive flows.
- Direct commands may specify a model explicitly.
- If no model is specified in `ai use`, use the provider default model.

### Permission Mode

Each provider has a `mode`:

- `auto`: highest permission mode, default value. For Claude Code this maps to `--dangerously-skip-permissions`.
- `ask`: ask before sensitive execution.

The runner layer should map `mode` to Claude Code or Codex CLI permissions where supported. If a downstream CLI does not support an equivalent setting, enforce the behavior in this tool before launch.

## 6. Hermes Robot

### Product Model

Hermes is integrated as robot management, not as another provider type.

The primary purpose is not to replace Hermes, but to make Hermes robots easier to create, inspect, use, reset, delete, export, and import through the unified `ai` command.

AI Gateway concepts:

- Provider: model endpoint configuration stored in `providers.json`.
- Hermes robot: a named AI Gateway-managed robot that references an existing provider and model.
- Hermes CLI: the downstream runtime used when a robot is launched.

### CLI Commands

Interactive entry:

```bash
ai hermes
```

Interactive menu:

```text
Hermes
  status
  use
  add
  list
  edit
  clear
  delete
  import
  import-local
  export
  exit
```

Direct commands:

```bash
ai hermes status
ai hermes use <robot-name>
ai hermes add
ai hermes list
ai hermes edit
ai hermes clear
ai hermes delete
ai hermes import <file>
ai hermes import-local
ai hermes export
ai hermes export <robot-name>
```

### Add Flow

Steps:

1. Input robot name.
2. Select provider from AI Gateway providers.
3. Select model from the provider model cache.
4. Select mode, defaulting to `auto`.
5. Optionally configure Telegram binding.
6. Save to `hermes.json`.

### Edit Flow

Editable fields: name, default provider, default model, mode, Telegram binding.

The flow should be selection-first. Avoid requiring users to remember provider names or model names.

After add/edit, the CLI automatically syncs the selected robot into native local Hermes config and attempts to restart the local Hermes gateway.

### List Flow

Shows robot configuration only. Does not refresh health. Does not run callable model probes or consume token usage.

Runs lightweight local Hermes self-repair before output.

### Status Flow

Show a card-style status for each robot. Runs lightweight local Hermes self-repair before output.

Checks: Hermes CLI installed, referenced provider exists, provider health, model exists in cache, Telegram binding status, last robot session or error.

### Use Flow

```bash
ai hermes use <robot-name>
```

Launch behavior:

1. Load robot config.
2. Resolve the referenced provider from `providers.json`.
3. Resolve model from robot config.
4. Regenerate the robot-specific Hermes runtime config under `~/.ai-gateway/hermes/<robot-name>/`.
5. Start Hermes CLI with `HERMES_HOME` pointing at that robot-specific runtime home.
6. Do not allow the user's native `~/.hermes/config.yaml` to override the selected robot provider key.
7. Do not mutate the user's native `~/.hermes/config.yaml` by default.
8. Write AI Gateway session and log records.

### Native Local Config Sync

Purpose: Make native local Hermes surfaces (especially Telegram-backed Hermes) use the same provider/model selected in AI Gateway.

Trigger rules:

- `ai hermes add/edit/import` commands sync and restart automatically.
- `ai provider add/edit/delete` record provider revisions only. The next Hermes command detects pending provider changes, syncs native Hermes config, and restarts only from that Hermes command path when runtime changes need to take effect.
- This is separate from `ai hermes use`, which launches Hermes with an isolated AI Gateway-managed `HERMES_HOME`.

Sync behavior:

1. Load the robot from `hermes.json`.
2. Refresh all AI Gateway providers and update the model cache.
3. Resolve the referenced provider from `providers.json`.
4. Write the robot's model, provider kind, base URL, and API key into the top-level `model:` block in `~/.hermes/config.yaml`.
5. Write all AI Gateway providers and discovered model candidates into native Hermes `providers:` and `custom_providers:` so Telegram `/model` lists AI Gateway providers only.
6. Clear native Hermes provider credential entry points in `.env` and `auth.json` that would otherwise make built-in providers appear in `/model`.
7. Replace existing native `providers` and `custom_providers` blocks, including inline empty blocks such as `providers: {}`, and remove duplicate top-level provider blocks.
8. Preserve unrelated native Hermes config blocks (Telegram, toolsets, terminal, cron, memory, MCP servers).
9. Restart the local Hermes gateway. Prefer launchd `ai.hermes.gateway` on macOS; fall back to `hermes gateway restart`.
10. Log only the API key fingerprint, not the full key.

Provider-only sync rules:

- Providers with no callable models must be omitted from the Telegram `/model` listing.
- Model probe token usage must be recorded with source `model_probe`.
- Provider-only sync preserves the existing native Hermes top-level `model:` block.

Compatibility patches:

- If the installed Hermes `model_switch.py` only reads `default_model` for user-defined providers, sync applies a patch so Telegram `/model` reads `providers.<name>.models`. Keep a `.ai-gateway.bak` backup.
- If the installed Hermes gateway calls `switch_model()` without passing the native `providers` dict, sync patches `gateway/run.py` so Telegram picker selections can resolve AI Gateway provider slugs.
- If the installed Hermes gateway treats Telegram picker selections as session-only, sync patches `gateway/run.py` so picker selections are persisted into native Hermes `model:` defaults.
- If the installed Hermes request builder can replay empty-name tool calls from Telegram history, sync patches `run_agent.py` so chat-completions requests drop invalid tool calls and matching empty tool results before sending.

Lightweight self-repair:

- `ai hermes list` and `ai hermes status` run lightweight self-repair before output.
- Self-repair patches Hermes compatibility files, rewrites native provider blocks from `providers.json` plus cached models, restarts gateway only when something changed.
- Must not refresh providers with callable model probes or consume token usage.
- Adopts a native Hermes top-level `model.provider/default` back into the matching AI Gateway robot when that provider exists in `providers.json`.

### Clear Flow

```bash
ai hermes clear
```

Resets robot memory, AI Gateway-managed runtime state, robot tasks, and native Hermes cron jobs owned by that robot while keeping the main robot configuration.

Keeps: name, provider, model, mode, Telegram binding, created time.

Clears: robot session records, last-used state, local robot context, AI Gateway-managed robot memory, isolated Hermes runtime home, robot tasks in `hermes.json`, native Hermes cron jobs matching the robot, robot token usage aggregation, robot error history.

### Delete Flow

```bash
ai hermes delete
```

Removes the robot configuration from `hermes.json` and AI Gateway-managed robot state. Requires destructive confirmation.

### Import And Export

Export:

```bash
ai hermes export
ai hermes export <robot-name>
```

Default exports all robots. Writes a complete replication bundle with referenced provider API keys and model cache. Keep export files private.

Import:

```bash
ai hermes import <file>
ai hermes import-local
```

Import rules:

- Full export bundles include referenced provider API keys and model cache so another machine can fully restore the robots.
- Legacy providerless files can still import, but the referenced provider must already exist locally before sync can succeed.
- If a robot with the same name already exists, prompt to overwrite, rename, or cancel.

Local import rules:

- Scan `~/.hermes/config.yaml` for the default model/provider/base URL.
- Scan `~/.hermes/channel_directory.json` for Telegram binding.
- Scan `~/.hermes/cron/jobs.json` for local Hermes cron jobs and import them as robot tasks.
- Import local Hermes provider credentials into AI Gateway providers.
- Re-running `import-local` after renaming the imported robot must not create a duplicate `hermes-default`; match existing robots by name, source, Telegram chatId, or task ids.
- If no matching AI Gateway provider exists, keep the local provider name and show `provider missing` in status.

### Safety Rules

- Never write API keys to `hermes.json`.
- Full export bundles may include provider API keys and must be kept private.
- Never mutate `~/.hermes/config.yaml` by default (only through explicit sync paths).
- Mask secrets in logs.
- Make destructive operations interactive first.
- Keep output readable in narrow terminals.

## 7. Telegram Bot

Telegram Bot is a separate subsystem with its own detailed specification.

See [telegram-bot-spec.md](telegram-bot-spec.md) for the complete Telegram Bot specification.

## 8. Other Flows

### Log Flow

```bash
ai log
ai log --print
ai log --print 100
```

`ai log` opens `.ai-gateway.log` with the system default app.

`ai log --print` lists recent entries in the terminal. Default limit: 50 entries. Maximum limit: 500 entries.

Each log entry includes: timestamp, level, category, action, message, metadata.

Log categories: `usage`, `error`, `strategy`, `provider`, `system`.

### Context Flow

```bash
ai context
ai context --print
```

Generates a safe project context package at `.ai-gateway/context.md`.

Default behavior: generate context markdown and open with system default app. `--print` prints to terminal.

Context includes: project root, git branch and latest commit, `git status --short`, `git diff --stat`, `package.json` metadata and scripts, shallow file tree, key document excerpts, recent AI Gateway logs.

Excludes: `node_modules`, `dist`, `build`, `.git`, `.ai-gateway`, `providers.json`, `.ai-cache.json`, `usage.json`, `.ai-gateway.log`, `.env`, key and certificate files.

### Session Flow

```bash
ai session
ai session list
ai session resume <session-id>
ai session clear
```

Each `ai use` launch creates a session record in `sessions.json`.

- `ai session list` lists recent sessions.
- `ai session` opens an interactive selector and resumes the selected session launch parameters.
- `ai session resume <session-id>` resumes a specific session launch configuration.
- `ai session clear` removes AI Gateway session records only. Must not delete Claude Code or Codex native conversation history.

Resume means reusing `tool/provider/model/projectPath` launch parameters. It does not guarantee restoration of native chat history.

### Report Flow

```bash
ai report
ai report <session-id>
ai report --print <session-id>
```

Generates a Markdown handoff report. Reports are written to `~/.ai-gateway/reports/<session-id>.md`.

Report content: session context, real token usage from `usage.json` events, tool and model type, provider snapshot, session profile, user profile.

Token usage must be matched from structured `usage.json` events by session time window, tool, provider, and model. Must not estimate missing usage.

### Doctor Flow

```bash
ai doctor
ai doctor --deep
```

Default `ai doctor` must not consume model tokens.

Default checks:

- `providers.json` existence, syntax, and schema.
- Provider name uniqueness.
- `mode` validity.
- `level` continuity and conflicts.
- Default model presence in cache.
- `.ai-cache.json` and `usage.json` readability/writability.
- Claude Code CLI availability.
- Codex CLI availability.
- Lightweight provider connectivity.
- Token-free model discovery where supported.

Output grouped: Config, Providers, Models, Local CLIs, Cache, Usage, Suggestions.

`--deep` may run a minimal real inference request. Rules:

- Must warn about possible token usage and require confirmation.
- Use the highest-priority available provider by default.
- If selected provider fails, fallback to next.
- If no provider is usable, fall back to regular `ai doctor` behavior.
- Use the smallest safe test prompt.
- Record token usage if provider returns usage data.
- Never run as part of `ai status`.

## 9. Web Control Panel Direction

Command:

```bash
ai web
```

Planned capabilities:

- Provider list, health, usage share, cost curves.
- Visual provider add/edit.
- Drag-and-drop level ordering.
- Default model switching from dropdown.
- Manual model list refresh.
- Provider/model statistics.
- Hermes robot list, status, provider/model, Telegram binding, usage share, token curves, recent errors.
- Hermes robot import/export, clear, delete.
- Hermes native local config sync and task management.

## 10. Governed Automatic Memory And Learning

This section defines target Runtime behavior. It is planned until the corresponding phase exit criteria in `memory-system-spec.md` are implemented and verified; documentation must not report it as shipped earlier.

### Automatic Experience

- Every eligible execution produces durable, privacy-filtered outcome signals without blocking the user response on extraction, embedding, evaluation, or consolidation.
- The Runtime automatically extracts low-risk explicit preferences, facts, goals, constraints, and failures according to category policy. Model output is always a candidate and cannot directly activate, supersede, delete, promote, or grant permission.
- Repeated successful procedures become Skill candidates. Failed procedures become environment-bound negative memory. Risk-specific replay, sandbox, shadow, policy, and human gates control activation.
- Memory consolidation runs automatically on duplication, interference, growth, milestone, source-change, and periodic triggers. It creates reversible summaries, profiles, skill parameterizations, and storage-tier projections while preserving authoritative Claim/Evidence provenance.
- The Runtime estimates retrieval coverage, conflict, temporal ambiguity, skill applicability, policy ambiguity, and goal impact. It chooses a bounded action: proceed, search, verify, ask one high-value question, or proceed cautiously.
- Users retain explicit `pin`, `correct`, `forget`, `purge`, `export`, read/write privacy modes, and audit controls. Automatic behavior cannot remove or weaken these controls.

### Learning Control

The governed learning sequence is `RuntimeEvent -> LearningSignal -> LearningDecision -> LearningCandidate or no artifact -> EvaluationResult -> PolicyDecision -> CapabilityGain`.

- A versioned deterministic Learning Governor selects the learning action against explicit Learning Objectives, uncertainty, budget, policy, and authority.
- `no artifact` is the default when durable reuse value is not demonstrated.
- Fact confidence derives from Evidence. Retrieval and outcome utility are separate and must not self-reinforce factual confidence.
- Attribution distinguishes retrieved, injected, referenced, decision changed, and outcome changed. Retrieval frequency alone is not evidence of usefulness.
- Capability Gain combines task success, correction reduction, verified reuse, latency and cost improvement, stale-memory error, harm, and privacy/policy violations. Artifact count and retrieval count are not success metrics.
- Privacy violations, forbidden leaks, or high-impact safety regressions block production promotion regardless of aggregate quality gain.
- User-to-project-to-team-to-organization promotion creates a separately governed, sanitized candidate; it never changes the original private artifact's scope or exports private Evidence.

### Unified Transport Proxy And Memory Extension Behavior

The existing OpenAI Usage Proxy is a shipped execution path with Responses-to-Chat compatibility translation, usage/cost records, metrics, and direct Codex/Telegram callers. Per-turn automatic memory must enhance it into one provider-agnostic Runtime Transport Proxy. The product must not launch or chain a separate Memory HTTP proxy.

- One execution has one listener, one route lease, one upstream path, and one base-URL override.
- `startOpenAiUsageProxy()` remains a stable compatibility facade. Existing translation, records, metrics, cost source, `usage.json`, and error behavior remain available and pass parity tests.
- Streaming Responses requests use native Responses first. The transport may translate to Chat Completions only when the upstream explicitly rejects or does not expose the Responses protocol; transient upstream failures, including Cloudflare `52x`, must remain execution failures and must not trigger protocol oscillation.
- The current Codex transport facade isolates its upstream connection pool per execution and disables upstream connection reuse. This allows the Codex CLI retry loop to recover from a stale gateway socket without adding a second proxy-level request retry.
- Upstream response headers have a 45-second deadline. After two consecutive header timeouts, the execution-local transport route short-circuits later reconnects so the delivery adapter can rotate providers instead of displaying an unchanged progress state for the 15-minute task ceiling.
- A protocol-specific rejection is an adapter compatibility signal, not sufficient evidence that the provider is unavailable. Provider fallback applies only after the compatible protocol path fails, and only providers whose discovered catalog contains an explicitly requested model are eligible.
- Delivery adapters resolve the ordered provider candidates once. An execution adapter must run the selected provider/model exactly and must not perform a second hidden routing decision. Runtime-opened provider circuits enter a half-open probe state after cooldown instead of remaining disabled because of stale `status: error` metadata.
- Usage is read-only with respect to transport payloads and is the sole writer of accounting state. Memory is a separately controlled extension. Neither owns a server or forwards requests independently.
- Critical request decoding and Responses/Chat/provider compatibility belong to the transport core, not UsageObserver or MemoryExtension. UsageObserver exclusively owns usage normalization, cost calculation, records, metrics, and `usage.json`; MemoryExtension must not estimate billable usage or persist a second usage ledger.
- The compatibility facade reads route state from Transport and accounting state from the single UsageObserver. It must not keep a legacy listener, duplicate counter, or independent persistence path after migration.
- Canonical events identify execution, logical request, actual upstream attempt, provider event when available, and sequence. Usage writes are idempotent per actual attempt so compatibility retry, CLI retry, worker replay, or facade access cannot double count.
- Usage and Memory consume separate bounded channels from one canonical event source. Memory queue pressure cannot drop Usage events. Usage loss or overflow is surfaced as degraded, recovered from a bounded journal or reconciled from the completed response, and blocks parity claims until resolved.
- A single transform coordinator applies an allowlisted Memory patch to a canonical AST before approved Responses/Chat/provider compatibility translation. Every changed path is recorded in a transform manifest.
- The minimal forwarder streams to the CLI before dispatching bounded copies to separate Usage and Memory channels. Non-critical response parser or Memory-worker failure narrows Memory without interrupting the stream or Usage; Usage-worker failure is explicitly degraded and recovered or reconciled. Total forwarder failure may fail the current request; the next request is supervised back to a known listener and no success memory is produced.
- Raw authorization, full instructions, reasoning, tool arguments, tool output, and attachments are ephemeral. Durable stores receive only recursively redacted allowlisted envelopes, hashes, and encrypted TTL content references.
- Transport modes are `stopped`, `usage_only`, and `extensions`. Memory modes are independently `disabled`, `passthrough`, `shadow_capture`, `read_only`, and `full`. Health may narrow Memory but cannot silently disable verified Usage behavior.
- Unknown major versions, unknown turn relations, fixture regressions, parser failures, resource pressure, or an open Memory circuit degrade Memory to shadow, pass-through, or disabled.
- Route nonces and self-loop detection are required. Random loopback ports do not provide tenant isolation; mutually untrusted tenants require separate OS-user, container, or network isolation.
- Prompt-cache hit ratio, cached/uncached input tokens, effective input cost, time to first token, and task quality are release metrics for every injection profile.
- Adapter and MemoryExtension rollback/kill switches are independent from the transport facade, UsageObserver, Memory Store schema, and learned-artifact state.
- `ai doctor transport-proxy` is the planned diagnostic surface; `ai doctor memory-proxy` remains a compatibility alias during migration.

### Mature Capability Reuse Behavior

The product must preserve its governed Runtime semantics while preferring mature implementations for commodity capability internals.

- Extractors are add-only. Mem0-compatible or other providers may propose create, reinforce, supersede, archive, or ignore, but the Runtime appends a candidate/evidence proposal and performs every authoritative transition through local identity, Evidence, conflict, and Policy evaluation.
- Retrieval may combine mature semantic, BM25/FTS, entity-linking, temporal, graph, and reranking providers. External ranking cannot bypass local scope, authority, temporal validity, conflict resolution, token budget, or privacy filtering.
- Vector providers must apply Runtime-supplied authorization metadata filters during search. A provider that only supports account-wide retrieval followed by application filtering is not production-compatible.
- Temporal graph support should use a Graphiti-compatible `TemporalGraphProjection` when enabled. Graph nodes and edges are rebuildable projections over internal Claim/Evidence ids; local mode may degrade to temporal SQL rather than implement a second incomplete graph engine.
- Context compilation may expose Letta-style named, versioned, attachable, and shared memory blocks. Blocks are read-only projections; agent edits become candidates, and sharing a block cannot widen the audience of private Evidence.
- Procedure induction uses a provider-neutral `ProcedureMiner` over sanitized action signatures and should reuse a maintained PrefixSpan or equivalent sequence-mining implementation. Its output is an add-only Skill candidate and never an active capability.
- Workflow persistence follows LangGraph-style separation between thread-scoped checkpoints and cross-thread Memory. Checkpoint rollback cannot reverse committed Memory events, and checkpoints cannot persist raw reasoning, secrets, or transport bodies.
- Durable jobs preserve Runtime operation-id, lease, retry, dead-letter, purge, and trace semantics behind a provider-neutral backend. Protected payloads use audited cryptography and SecretStore or KMS/HSM adapters; Runtime business code does not implement cryptographic primitives or manage raw master keys.
- Policy uses a provider-neutral `PolicyEngine` compatible with mature side-effect-free evaluators such as OPA or Cedar. The product must not require a new general-purpose policy language.
- Evaluation may reuse versioned LoCoMo, LongMemEval, BEAM, and mature tracing/evaluation adapters, but production gates use reproducible runs with a declared model stack, dataset version, retrieval budget, token budget, and domain-specific authority/privacy suites.
- Local, team, and enterprise deployment profiles may replace indexes, queues, graphs, stores, and telemetry exporters without changing public contracts, authoritative ids, policy decisions, explicit user controls, or purge semantics.
- A managed service is optional. Disabling an external extractor, graph, vector, reranker, policy, or evaluation provider falls back by capability and never sends data to an unapproved provider.
- Every adapter declares its data egress, region, retention, deletion behavior, license, pinned version, health, cost, and fallback. Raw prompts, reasoning, secrets, and private Evidence are denied by default.

### Feature And Release Gates

Automatic extraction, low-risk activation, consolidation, active learning, causal attribution, scope promotion, and parametric promotion use independent `memory.autoWrite`, `memory.autoActivateLowRisk`, `memory.autoConsolidate`, `memory.activeLearning`, `memory.causalAttribution`, `memory.scopePromotion`, and `memory.parametricPromotion` flags. Disabling advanced learning must return to a stable Claim/Evidence plus required/local-retrieval baseline without disabling explicit memory control or primary task execution.

Required release gates include:

- deterministic Learning Decisions for the same versioned input;
- zero model paths that directly mutate activation or permission state;
- complete source coverage and rollback for active compressed projections;
- no task-success regression or stale-memory-error increase after compression;
- no private Evidence in team or organization promotion candidates;
- 100% existing Usage Proxy API/records/metrics/translation parity before Memory is enabled;
- exactly one terminal outcome per actual upstream attempt, at most one usage/cost contribution when usage exists, and one explicit `noUsage` contribution for a successful usage-less response across compatibility retry, CLI retry, observer restart, and event replay fixtures;
- Memory queue saturation or worker termination does not change Usage records, metrics, `usage.json`, response bytes, or compatibility behavior;
- exactly one listener and upstream route when Usage and Memory are enabled together;
- 100% response-byte consistency in pure pass-through and canonical-AST consistency outside declared transform paths;
- zero raw authorization, full instructions, reasoning, or raw tool arguments/output in durable envelopes, jobs, events, and logs;
- zero dangerous active-memory creation from failed, cancelled, partial, or unknown Proxy exchanges;
- Proxy local forwarding overhead p95 at or below 20 ms, excluding memory retrieval;
- worker failure does not interrupt the active provider stream; total forwarder failure cannot create false success and the next request is supervised back to a known state;
- cache-read ratio regression no greater than 5 percentage points and effective input-cost regression no greater than 10%, unless an approved objective-specific ADR sets a stricter or explicitly justified exception.
- swapping a mature capability provider preserves public contracts, internal authoritative ids, scope/authority decisions, purge reachability, and the stable local fallback on contract fixtures;
- dependency and adapter releases include an ADR, SBOM, license/vulnerability checks, pinned versions, data-egress classification, kill switch, and tested export/replacement path.

## 11. Acceptance Criteria

- `ai` enters interactive mode.
- `ai help` opens the Chinese HTML usage guide.
- `ai add` adds a provider and writes `providers.json`.
- `ai provider edit` can change `mode`, `level`, and `model`.
- `ai provider list` lists provider config without refreshing health.
- `ai session list` lists recent sessions.
- `ai session` opens an interactive selector to resume a recent session launch configuration.
- `ai log` opens the log file, and `ai log --print` lists recent logs in the terminal.
- `ai context` generates `.ai-gateway/context.md`.
- Level conflicts are resolved by swapping levels.
- `ai status` lists health for all providers.
- `ai status` shows weekly token usage from real `usage.json` events.
- `ai doctor` prints a diagnostic report without consuming tokens by default.
- `ai use claude` and `ai use codex` start the matching CLI with the default provider/model.
- Unavailable providers trigger automatic fallback.
- Manual changes to `providers.json` are recognized on the next command run.

## 12. Todo / Roadmap

### High Priority

- Automatic provider fallback.
- `ai doctor`.
- `ai last`.
- Local proxy mode with an OpenAI-compatible endpoint.
- Stable Runtime contracts for execution events, learning objectives, learning signals, learning decisions, uncertainty, evaluation, and capability gain.
- Governed memory Phase 0/0.5 foundations: migrations, evaluation baseline, deterministic Learning Governor, feature flags, and rollback baseline.
- Mature capability adapter foundation: add-only extractor, hybrid retrieval, temporal graph projection, workflow checkpoint, policy engine, evaluation harness, local fallback profiles, dependency ADR/SBOM, and provider replacement tests.
- Unified Runtime Transport Proxy migration behind the existing Usage facade: parity tests, single listener, transform coordinator, isolated workers, MemoryExtension modes, route-loop detection, recursive redaction, cache/cost gates, kill switch, and diagnostics.
- Smart routing command: `ai do`.
- Git workflow commands: `ai review`, `ai fix`, `ai commit`, `ai pr`.
- Project-level profile: `.ai-gateway/project.json`.
- Project-level last selection: `ai last --cwd`.
- Unified MCP and skill management.
- Sensitive file protection.
- Project-level default provider/model.
- Token usage statistics.
- Web provider list.
- Web drag-and-drop level ordering.
- Web default model switching.

### Medium Priority

- Unified MCP management for Claude Code and Codex CLI.
- Unified skills registry with per-client adapters.
- Context packaging: `ai context`.
- Task modes: `ai task bugfix`, `ai task review`, `ai task refactor`, `ai task docs`.
- Session aliases: `ai save <name>`, `ai resume <name>`.
- Model fallback chains.
- Model and provider benchmark: `ai bench`.
- Rule-based routing by task, project, directory, or file type.
- Command replay: `ai replay`.
- Model aliases: `fast`, `cheap`, `best`.
- Task-based default models: `coding`, `review`, `fast`, `cheap`.
- Provider/model latency benchmark.
- Provider error details.
- Cost estimation.
- Daily and weekly budgets with warnings.
- Session history.

### Low Priority

- Automatically choose Claude or Codex based on task.
- Team shared configuration.
- Full per-terminal isolation for cache, logs, and last selection.
- Flutter desktop app.
- Advanced rule-based routing.

## 13. Extension Management Direction

### MCP Direction

- MCP is a shared protocol supported by both Claude Code and Codex CLI.
- Claude Code and Codex CLI do not use one identical configuration file.
- AI Gateway should maintain its own MCP registry and sync entries to each client's native configuration.
- The registry should support per-client enablement.

### Skills Direction

- Claude Code and Codex CLI both have a skills concept.
- Skills should be modeled as reusable workflow packages.
- AI Gateway should store skill metadata once, then adapt installation or activation to each client.
- Skill execution can be security-sensitive; future implementation needs trust, source, and permission metadata.

## 14. Multi-Terminal Isolation Decision

Full per-terminal isolation is not a near-term priority.

Current `ai use` launches Claude Code or Codex CLI with provider-specific environment variables in the child process. Different terminals can use different providers at the same time without sharing the active chat process configuration.

Shared management files still exist: `.ai-cache.json`, `.ai-gateway.log`, `usage.json`, global `lastSelection`.

Current decision:

- Keep global `ai last` for now.
- Prefer project-level state next: `.ai-gateway/project.json` and `ai last --cwd`.
- Add session management before considering full per-terminal isolation.
- Treat full per-terminal isolation as low priority unless real conflicts appear.
