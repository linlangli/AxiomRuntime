# PRD: AI Gateway

## 1. Product Goal

Build a local `ai` tool, named AI Gateway, to manage providers, models, permission modes, priority, health status, and usage across Claude Code and Codex CLI.

The first version is CLI-first, but the architecture must support a future local web control panel and Flutter desktop app.

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

## 3. Command Entry

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

ai edit
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
ai hermes sync <robot-name>
ai hermes clear
ai hermes delete
ai hermes import <file>
ai hermes import-local
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
- `mode`: permission mode, either `ask` or `auto`.
- `level`: provider priority. Smaller numbers have higher priority. `level: 1` is the default provider.
- `model`: default model for this provider.

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

Stores generated session handoff reports.

Reports must not contain API keys or estimated token usage.

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
        "name": "SpaceX SPCX 价格监控",
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
- Task schedule is not stored in `hermes.json`; users should change schedules by chatting with the robot or through future task management commands.
- Exported robot files must not contain API keys.

## 5. Add Flow

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

If multiple models are discovered in direct mode, select the first model by default. Users can later change it with:

```bash
ai edit
```

## 6. Edit Flow

```bash
ai edit
```

Steps:

1. Select provider.
2. Select field:
   - `name`
   - `baseUrl`
   - `apiKey`
   - `mode`
   - `level`
   - `model`
3. Persist changes to `providers.json` immediately.

Rules:

- `mode` must be selected from `ask` and `auto`.
- `level` must be selected from a generated level list based on the current provider count.
- If the selected `level` is already assigned to another provider, swap the two providers' levels.
- `model` must be selected from models discovered in `.ai-cache.json`; it is not typed manually.
- If `name`, `baseUrl`, or `apiKey` changes, refresh health status and model cache.

## 7. Use Flow

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
- Ordinary `ai use` must not mutate `~/.claude/settings.json`.
- Ordinary `ai use` must not use `--bare` by default.
- If a configured provider base URL ends with `/v1`, Claude Code launches must strip the trailing `/v1` before injecting `ANTHROPIC_BASE_URL`.
- Codex/OpenAI-compatible launches must keep the configured `/v1` suffix.
- Runtime logs must include provider, model, mode, baseUrl, command path, launch args, auth injection mode, fallback, and an API key fingerprint.
- Runtime logs must never print the full API key.

## 8. Automatic Fallback

When running:

```bash
ai use claude
ai use codex
```

or when a specified provider is unavailable, the system should:

1. Sort providers by `level` ascending.
2. Skip unavailable providers.
3. Select the first healthy provider.
4. Use that provider's default `model`.
5. If the default model is incompatible with the selected tool, choose a compatible model from the cache.
6. If no compatible model exists, continue to the next provider.
7. If all providers are unavailable, show an error and suggest:

```bash
ai status
ai doctor
```

CLI fallback output should be explicit:

```text
Provider 51talk unavailable, fallback to 1n1.
```

## 9. List Flow

```bash
ai provider list
```

`ai provider list` lists provider configuration from `providers.json` without refreshing provider health.

Show:

- `level`
- `name`
- `baseUrl`
- masked `apiKey`
- `mode`
- default `model`

## 10. Status Flow

```bash
ai status
```

`ai status` should refresh all providers before showing results.

Refresh must be lightweight:

- Check provider connectivity.
- Discover or update model cache.
- Model discovery should try `{baseUrl}/models` first, then `{baseUrl}/v1/models` when the first endpoint returns non-JSON or fails.
- Do not send chat/completion/inference requests.
- Do not intentionally consume model tokens.

Provider connectivity and downstream runtime readiness are separate:

- Provider health checks whether token-free model discovery works.
- Claude readiness uses Claude's effective base URL and a compatible Claude model.
- Codex readiness uses Codex/OpenAI's effective base URL and a compatible Codex model.
- `health: ok` must not be treated as proof that a real inference request will succeed.

Show all providers:

- `level`
- `name`
- configured `baseUrl`
- Claude runtime state
- Claude effective baseUrl
- Codex runtime state
- Codex effective baseUrl
- masked `apiKey`
- `mode`
- health
- last checked time
- token usage
- usage share

Provider health comes from `.ai-cache.json`.

If a provider does not support a token-free model discovery endpoint, mark the model cache as unavailable or stale. Token-consuming deep tests should be reserved for explicit diagnostic commands such as `ai doctor --deep`.

## 11. Log Flow

```bash
ai log
ai log --print
ai log --print 100
```

`ai log` opens `.ai-gateway.log` with the system default app.

`ai log --print` lists recent entries in the terminal.

Default limit: 50 entries.

Maximum limit: 500 entries.

Each log entry should include:

- timestamp
- level
- category
- action
- message
- metadata

Log categories:

- `usage`
- `error`
- `strategy`
- `provider`
- `system`

## 12. Context Flow

```bash
ai context
ai context --print
```

`ai context` generates a safe project context package at:

```text
.ai-gateway/context.md
```

Default behavior:

- Generate context markdown.
- Open the generated file with the system default app.

`--print` prints the generated context to the terminal.

The context should include:

- Project root.
- Git branch and latest commit.
- `git status --short`.
- `git diff --stat`.
- `package.json` metadata and scripts.
- A shallow file tree summary.
- Key document excerpts.
- Recent AI Gateway logs.

The context must exclude sensitive or noisy paths:

- `node_modules`
- `dist`
- `build`
- `.git`
- `.ai-gateway`
- `providers.json`
- `.ai-cache.json`
- `usage.json`
- `.ai-gateway.log`
- `.env`
- key and certificate files

## 13. Session Flow

```bash
ai session
ai session list
ai session resume <session-id>
ai session clear
```

Each `ai use` launch creates a session record in `~/.ai-gateway/sessions.json`.

`ai session list` lists recent sessions.

`ai session` opens an interactive selector and resumes the selected session launch parameters.

`ai session resume <session-id>` resumes a specific session launch configuration.

`ai session clear` removes all AI Gateway session records from `~/.ai-gateway/sessions.json`.

Current scope:

- Resume means reusing `tool/provider/model/projectPath` launch parameters.
- It does not guarantee restoration of Claude Code or Codex CLI's native chat history.
- Clearing sessions must not delete Claude Code or Codex native conversation history.

## 14. Report Flow

```bash
ai report
ai report <session-id>
ai report --print <session-id>
```

`ai report` opens an interactive selector for recent sessions and generates a Markdown report.

Reports are written to `~/.ai-gateway/reports/<session-id>.md`.

Report content:

- session context for agent handoff
- token usage from real recorded provider usage events
- tool and model type
- provider snapshot
- current session profile
- user profile

Token usage must be matched from structured `usage.json` events by session time window, tool, provider, and model. AI Gateway must not estimate missing usage.

## 15. Doctor Flow

```bash
ai doctor
```

`ai doctor` generates a diagnostic report for local setup and provider configuration.

Default doctor checks must not consume model tokens.

Default checks:

- Verify `providers.json` exists or can be created.
- Validate `providers.json` JSON syntax.
- Validate provider fields: `name`, `baseUrl`, `apiKey`, `mode`, `level`, and `model`.
- Detect duplicate provider names.
- Detect invalid `mode` values.
- Detect missing, duplicate, or out-of-range `level` values.
- Check whether configured default models exist in the current model cache.
- Check whether `.ai-cache.json` and `usage.json` are readable and writable.
- Check whether Claude Code CLI is installed.
- Check whether Codex CLI is installed.
- Run lightweight provider connectivity checks.
- Run token-free model discovery when supported.
- Print clear fix suggestions.

Output should be grouped:

```text
Config
Providers
Models
Local CLIs
Cache
Usage
Suggestions
```

Deep diagnostics:

```bash
ai doctor --deep
```

`--deep` may run a minimal real inference request to verify the full request path.

Rules for `--deep`:

- Must warn that it may consume tokens.
- Must require confirmation unless a future `--yes` flag is provided.
- Use the currently highest-priority available provider by default.
- Provider selection follows `level` ascending.
- If the selected provider fails, fallback to the next available provider.
- If no provider is usable, automatically fall back to regular `ai doctor` behavior without using a model.
- Use the smallest safe test prompt.
- Record token usage if the provider returns usage data.
- If the provider does not return usage, report that usage was not returned and do not write a fake usage event.
- Never run as part of `ai status`.

## 16. Hermes Robot Flow

Hermes is integrated as robot management, not as another provider type.

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
ai hermes sync <robot-name>
ai hermes clear
ai hermes delete
ai hermes import <file>
ai hermes import-local
ai hermes export <robot-name>
```

`ai hermes add` steps:

1. Input robot name.
2. Select provider from AI Gateway providers.
3. Select model from the provider model cache.
4. Select mode, defaulting to `auto`.
5. Optionally configure Telegram binding.
6. Save to `hermes.json`.

`ai hermes edit` can update:

- name
- default provider
- default model
- mode
- Telegram binding

`ai hermes list` lists robot configuration only and does not refresh health.

`ai hermes status` checks each robot:

- Hermes CLI installed.
- referenced provider exists.
- provider health.
- model exists in model cache when available.
- Telegram binding status.
- last robot session or error if tracked.

`ai hermes use <robot-name>` starts Hermes CLI for the selected robot. It must resolve API credentials from the referenced AI Gateway provider at launch time.

Launch rules:

- Launch with an AI Gateway-managed isolated `HERMES_HOME` under `~/.ai-gateway/hermes/<robot-name>/`.
- Regenerate that robot's Hermes runtime config from the selected provider before launch.
- The user's global `~/.hermes/config.yaml` must not be able to override the selected robot provider API key.
- Do not mutate `~/.hermes/config.yaml` by default.
- Write AI Gateway logs and session records.
- Mask all secrets.

`ai hermes add` and `ai hermes edit` automatically write the selected robot and AI Gateway provider list into the native local Hermes config file at `~/.hermes/config.yaml`, then restart the local Hermes gateway when possible.

`ai hermes sync <robot-name>` keeps the same behavior as a manual repair command.

Sync rules:

- Replace only the top-level `model:` block.
- Write AI Gateway providers into native Hermes `providers:` and `custom_providers:` so Telegram `/model` lists AI Gateway providers only.
- Clear native Hermes provider credential entry points in `.env` and `auth.json` that would otherwise make built-in providers appear in `/model`.
- Preserve other native Hermes configuration such as Telegram, toolsets, terminal, cron, memory settings, and MCP servers.
- Use the referenced AI Gateway provider from `providers.json`.
- Never write secrets into `hermes.json`; secrets are written only to the native Hermes config during `add`, `edit`, or explicit `sync`.
- Restart the native Hermes gateway automatically after sync. Prefer launchd `ai.hermes.gateway` on macOS; fall back to `hermes gateway restart`.

`ai hermes clear` resets robot memory and AI Gateway-managed robot runtime state while keeping robot configuration.

`ai hermes delete` removes the robot configuration and AI Gateway-managed robot state.

Import/export:

- `ai hermes export <robot-name>` writes a portable JSON file.
- `ai hermes import <file>` imports a portable robot definition.
- `ai hermes import-local` scans local Hermes files and imports the default Hermes robot plus its cron jobs as tasks.
- Import/export must never include API keys.
- Import should succeed even if the referenced provider is missing locally; status should show `provider missing`.

Detailed design lives in `docs/HERMES_INTEGRATION.md`.

## 17. Web Control Panel

Command:

```bash
ai web
```

Planned capabilities:

- Show provider list.
- Show provider health.
- Show token usage share.
- Show usage and cost curves.
- Add provider visually.
- Edit provider visually.
- Drag to reorder provider `level`.
- Select default model from a dropdown.
- Refresh model list manually.
- Switch current provider/model.
- View provider and model statistics.
- Manage Hermes robots.
- Show Hermes robot status, usage share, token curves, provider/model, Telegram binding, and recent errors.
- Import, export, clear, and delete Hermes robots visually.

## 18. Architecture Requirements

The first version must use an extensible architecture:

```text
src/
  core/
  cli/
  server/
  web/
```

Principles:

- `core` owns business logic.
- `cli` only handles commands and interaction.
- `server` exposes local APIs for web and future Flutter desktop clients.
- `web` is the local control panel.
- Future Flutter desktop app should call the same local server API.

## 17. Todo

### High Priority

- Automatic provider fallback.
- `ai doctor`.
- `ai last`.
- Local proxy mode with an OpenAI-compatible endpoint.
- Smart routing command: `ai do`.
- Git workflow commands: `ai review`, `ai fix`, `ai commit`, and `ai pr`.
- Project-level profile: `.ai-gateway/project.json`.
- Project-level last selection, such as `ai last --cwd`.
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
- Context packaging command: `ai context`.
- Task modes: `ai task bugfix`, `ai task review`, `ai task refactor`, and `ai task docs`.
- Session aliases: `ai save <name>` and `ai resume <name>`.
- Session management: `ai session list` and `ai session resume <session-id>`.
- Model fallback chains.
- Model and provider benchmark: `ai bench`.
- Rule-based routing by task, project, directory, or file type.
- Command replay: `ai replay`.
- Model aliases, such as `fast`, `cheap`, and `best`.
- Task-based default models, such as `coding`, `review`, `fast`, and `cheap`.
- Provider/model latency benchmark.
- Provider error details.
- Cost estimation.
- Daily and weekly budgets.
- Budget warnings.
- Session history.
- `ai resume`.

### Low Priority

- Automatically choose Claude or Codex based on task.
- Team shared configuration.
- Full per-terminal isolation for cache, logs, and last selection.
- Flutter desktop app.
- Advanced rule-based routing.

## 18. First Version Acceptance Criteria

- `ai` enters interactive mode.
- `ai help` opens the Chinese HTML usage guide.
- `ai add` adds a provider and writes `providers.json`.
- `ai edit` can change `mode`, `level`, and `model`.
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
