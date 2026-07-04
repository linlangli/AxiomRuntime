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
ai list
ai status
ai web
ai doctor
ai last
```

## 4. Configuration Files

### User Editable: `providers.json`

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

Stores token usage events for CLI status, web charts, and future desktop statistics.

Example:

```json
{
  "events": [
    {
      "provider": "51talk",
      "tool": "codex",
      "model": "gpt-5.5",
      "inputTokens": 1200,
      "outputTokens": 800,
      "totalTokens": 2000,
      "createdAt": "2026-07-04T05:40:00.000Z"
    }
  ]
}
```

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

## 9. Status Flow

## 9. List Flow

```bash
ai list
```

`ai list` lists provider configuration from `providers.json` without refreshing provider health.

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

Show all providers:

- `level`
- `name`
- `baseUrl`
- masked `apiKey`
- `mode`
- default `model`
- health
- last checked time
- token usage
- usage share

Provider health comes from `.ai-cache.json`.

If a provider does not support a token-free model discovery endpoint, mark the model cache as unavailable or stale. Token-consuming deep tests should be reserved for explicit diagnostic commands such as `ai doctor --deep`.

## 11. Doctor Flow

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
- Never run as part of `ai status`.

## 12. Web Control Panel

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

## 13. Architecture Requirements

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

## 14. Todo

### High Priority

- Automatic provider fallback.
- `ai doctor`.
- `ai last`.
- Local proxy mode with an OpenAI-compatible endpoint.
- Smart routing command: `ai do`.
- Git workflow commands: `ai review`, `ai fix`, `ai commit`, and `ai pr`.
- Project-level profile: `.ai-gateway/project.json`.
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
- Flutter desktop app.
- Advanced rule-based routing.

## 15. First Version Acceptance Criteria

- `ai` enters interactive mode.
- `ai help` opens the Chinese HTML usage guide.
- `ai add` adds a provider and writes `providers.json`.
- `ai edit` can change `mode`, `level`, and `model`.
- `ai list` lists provider config without refreshing health.
- Level conflicts are resolved by swapping levels.
- `ai status` lists health for all providers.
- `ai doctor` prints a diagnostic report without consuming tokens by default.
- `ai use claude` and `ai use codex` start the matching CLI with the default provider/model.
- Unavailable providers trigger automatic fallback.
- Manual changes to `providers.json` are recognized on the next command run.
