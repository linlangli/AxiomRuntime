# Project Profile: AI Gateway

## Project Positioning

AI Gateway is a local AI provider management platform.

The first product surface is a CLI command named `ai`. Future product surfaces include:

- Local web control panel launched by `ai web`.
- Flutter desktop application.

All product surfaces should share the same core business logic instead of reimplementing provider management separately.

## Current Product Scope

The tool helps users manage and use multiple AI providers for Claude Code and Codex CLI.

Core capabilities:

- Add providers.
- Edit provider configuration.
- Select Claude Code or Codex CLI.
- Select provider and model.
- Set default provider by priority level.
- Set default model per provider.
- View provider health in `ai status`.
- Track token usage.
- Automatically fall back to another healthy provider when the preferred provider is unavailable.
- Manage Hermes robots that reuse AI Gateway providers and launch through Hermes CLI.

## Main User Workflow

Interactive:

```bash
ai
```

Running `ai` without arguments enters interactive mode.

Help:

```bash
ai help
```

`ai help` opens `docs/USAGE.html`.

Direct:

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

## Configuration Philosophy

Provider configuration is global by default and lives at `~/.ai-gateway/providers.json`. `AI_GATEWAY_HOME` can override the config directory for tests or advanced workflows.

`providers.json` is user-facing and should stay minimal.

It should only include fields users need to configure directly:

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

Rules:

- `name` must be unique.
- `mode` must be `ask` or `auto`.
- `level` controls priority. Smaller is higher priority.
- `level: 1` is the default provider.
- `model` is the provider's default model.
- Model candidates come from internal cache, not from `providers.json`.
- Manual changes to `providers.json` must be picked up on the next command run.

Internal runtime data should not pollute `providers.json`.

JSON runtime stores should tolerate a complete JSON value followed by accidental trailing duplicate content, then rewrite clean JSON on the next save. Writes should use temp-file plus rename semantics to reduce corruption from concurrent CLI processes.

Internal files:

- `~/.ai-gateway/.ai-cache.json`: provider health, model discovery cache, last checked time, last error.
- `~/.ai-gateway/usage.json`: token usage events for status, charts, and future analytics.
- `~/.ai-gateway/.ai-gateway.log`: JSONL operational logs for usage traces, errors, provider health checks, and strategy execution.
- `~/.ai-gateway/sessions.json`: launch session records for tool/provider/model/project.
- `~/.ai-gateway/reports/`: generated session handoff reports.
- `~/.ai-gateway/hermes.json`: user-editable AI Gateway-managed Hermes robot definitions. This file must not contain API keys.
- `~/.ai-gateway/hermes-state.json`: AI Gateway-managed Hermes robot runtime state.
- `~/.ai-gateway/hermes/<robot-name>/`: AI Gateway-managed isolated Hermes runtime home for each robot.
- `.ai-gateway/context.md`: generated project context package for Claude Code and Codex.

## Hermes Robot Direction

Hermes integration should focus on robot management.

Hermes is not a provider. A Hermes robot references an existing AI Gateway provider and model. API keys stay in `providers.json` and are resolved only at launch time.

Each robot must launch with an isolated `HERMES_HOME` under `~/.ai-gateway/hermes/<robot-name>/`. AI Gateway regenerates that robot's Hermes runtime config from the selected provider before launch, so the user's global `~/.hermes/config.yaml` cannot override the robot's API key.

`hermes.json` should stay minimal and only include user-facing configuration fields. Do not write internal metadata such as source, created time, updated time, health, sessions, or runtime state into `hermes.json`.

Interactive entry:

```bash
ai hermes
```

Menu:

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

Commands:

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

Behavior rules:

- `add` is interactive and selection-first: input robot name, select provider, select model, select mode, and optionally configure Telegram binding.
- `edit` can update robot name, default provider, default model, mode, and Telegram binding.
- Telegram binding is optional.
- Hermes cron jobs are tasks that belong to a robot. They are not robots.
- Task schedule is stored in `hermes.json` so robots can be fully exported and restored on another machine.
- `list` runs lightweight local Hermes self-repair, then shows robot configuration. It must not run callable model probes or consume token usage.
- `status` runs lightweight local Hermes self-repair, then checks Hermes CLI availability, provider existence, provider health, model cache, Telegram binding status, and recent robot state.
- `use` launches Hermes CLI for the selected robot.
- `add`, `edit`, and `import` automatically sync the selected robot plus all AI Gateway providers into native local Hermes config at `~/.hermes/config.yaml`, refresh discovered provider models, verify callable models with minimal `max_tokens: 1` probes, preserve unrelated Hermes settings, clear native Hermes provider credential entry points, and restart the local Hermes gateway when possible. Telegram `/model` should show only callable models from AI Gateway-configured providers and omit providers with no callable models.
- Native Hermes sync must replace inline empty provider blocks such as `providers: {}` / `custom_providers: []` and remove duplicate top-level provider blocks, otherwise Telegram `/model` can show a provider that native execution later rejects as `Unknown provider`.
- Lightweight self-repair should adopt a native Hermes top-level `model.provider/default` back into the matching AI Gateway robot when that provider exists in `providers.json`. This prevents AI Gateway from overwriting a Telegram `/model` change on the next command.
- Provider `add/edit/delete` record provider revisions only. Hermes detects pending provider changes on the next Hermes command, syncs native Hermes config, and restarts only from that Hermes command path when runtime changes need to take effect.
- Native Hermes sync patches local Hermes `model_switch.py` when needed so Telegram `/model` reads AI Gateway's discovered model list for user-defined providers, not only `default_model`. It also patches `gateway/run.py` when the Telegram picker calls `switch_model()` without passing the native `providers` dict or treats picker selections as session-only; otherwise provider selection can still fail with `Unknown provider` or revert after restart. Keep a `.ai-gateway.bak` backup before patching.
- Native Hermes sync/self-repair also patches local Hermes `run_agent.py` when needed so chat-completions requests drop empty-name tool calls and matching empty tool results before sending. This prevents OpenAI-compatible providers from rejecting Telegram session history with `Invalid input[*].name`.
- `clear` resets robot memory, AI Gateway-managed runtime state, robot tasks, and native Hermes cron jobs owned by that robot while keeping the main robot configuration.
- `delete` removes the robot configuration and AI Gateway-managed robot state.
- `export` defaults to all robots and writes a complete replication bundle with referenced provider API keys and model cache. Keep export files private.
- `import-local` scans local Hermes files and imports the default Hermes robot plus its cron jobs as tasks.
- `import-local` must be idempotent after users rename imported robots; match the local Hermes robot by name, source, Telegram chatId, or cron task ids before creating `hermes-default`.
- If an imported robot references a missing local provider, import should still succeed and status should report `provider missing`.

Implementation must be reusable by future web and desktop surfaces.

Detailed design lives in `docs/HERMES_INTEGRATION.md`.

## Release And CI

The project includes a GitLab CI pipeline in `.gitlab-ci.yml`.

CI rules:

- Normal branch and merge request pipelines run `npm test`.
- Tag pipelines publish to npm.
- npm publishing requires the GitLab CI/CD variable `NPM_TOKEN`.
- A release tag must point to a commit contained in `origin/main`.
- The tag version must match `package.json` version. Both `v0.1.1` and `0.1.1` tag formats are accepted.
- The publish job runs `npm test` and `npm pack --dry-run` before `npm publish --access public`.

Release convention:

```bash
git switch main
git merge develop
npm version patch
git push origin main --tags
```

## Architecture Direction

Use a layered architecture from the first version:

```text
src/
  core/
  cli/
  server/
  web/
```

Responsibilities:

- `core`: business logic, config read/write, provider management, health checks, model discovery, usage tracking, fallback, runner abstraction.
- `cli`: command parsing, interactive prompts, table output.
- `server`: local HTTP API for web and future Flutter desktop clients.
- `web`: local control panel.

Important rule:

CLI, web, and desktop must call core APIs. They should not directly implement provider business rules.

## Provider Priority And Fallback

Provider priority is controlled by `level`.

Rules:

- Levels are generated from current provider count.
- If there are three providers, valid levels are `1`, `2`, and `3`.
- Editing a provider level is selection-based, not free text.
- If the selected level already belongs to another provider, swap the two levels.
- When using a provider fails, fallback checks providers by ascending `level`.
- Fallback must skip unhealthy providers or providers without compatible models.

Example:

```text
Provider 51talk unavailable, fallback to 1n1.
```

## Model Rules

Each provider has one default `model` in `providers.json`.

Model selection rules:

- `ai add` discovers models and lets the user select a default model.
- `ai provider edit` changes model by selecting from discovered models.
- Users do not manually type model names in interactive flows.
- Direct commands may specify a model explicitly.
- If no model is specified in `ai use`, use the provider default model.

## Permission Mode

Each provider has a `mode`:

- `auto`: highest permission mode, default value. For Claude Code this maps to `--dangerously-skip-permissions`.
- `ask`: ask before sensitive execution.

The runner layer should map `mode` to Claude Code or Codex CLI permissions where supported. If a downstream CLI does not support an equivalent setting, enforce the behavior in this tool before launch.

## Status And Usage

`ai provider list` lists provider configuration from `providers.json` without refreshing provider health. It should use a readable card-style terminal layout rather than the dense status table.

`ai log` opens `.ai-gateway.log` with the system default app. `ai log --print` lists recent operational logs in a readable block-style terminal layout. Logs should cover command usage, errors, provider checks, fallback strategy execution, and doctor diagnostics.

Logs must not persist full API keys. Direct command arguments such as `ai add <name> <baseUrl> <apiKey>` must be masked before logging.

`ai context` generates `.ai-gateway/context.md` and opens it by default. `ai context --print` prints the same content in the terminal. Context generation must exclude secrets and noisy directories.

`ai report` generates a Markdown handoff report for a selected session. Reports are written to `~/.ai-gateway/reports/<session-id>.md` and include session context, real token usage, tool/model, provider snapshot, session profile, and user profile. Reports must not include API keys or estimated token usage.

`ai session clear` clears AI Gateway's `sessions.json` records only. It must not delete Claude Code or Codex native conversation history.

Claude Code provider injection should use a temporary `--settings` file that merges the user's existing `~/.claude/settings.json` and overrides `env.ANTHROPIC_API_KEY` plus `env.ANTHROPIC_BASE_URL`. Do not mutate the user's Claude settings for ordinary `ai use`, and do not use `--bare` by default because it disables hooks, plugin sync, auto-memory, and other default Claude Code behavior.

Tool-specific base URL rules:

- Claude Code should receive the Anthropic root base URL. If a provider is configured with an OpenAI-compatible `/v1` suffix, strip the trailing `/v1` before injecting `ANTHROPIC_BASE_URL`.
- Codex/OpenAI-compatible flows should keep the configured `/v1` suffix.

Real `ai use` launches should write provider, baseUrl, model, launch args, auth injection mode, and a non-secret API key fingerprint to logs so provider/key routing can be audited safely without exposing the full key.

`ai status` should list all providers and include health.

`ai status` refreshes all providers before rendering the table. This refresh must be lightweight: connectivity check and model discovery only. It must not send chat, completion, or inference requests by default, so it should not intentionally consume model tokens.

`ai status` must distinguish provider connectivity from downstream runtime readiness. It should show Claude and Codex separately, including each tool's effective base URL and selected compatible model. A provider-level `health: ok` only means model discovery worked; it must not be presented as proof that inference will succeed.

`ai status` should use a card/block layout rather than a wide table so output remains readable in narrow terminal windows.

Model discovery should try `{baseUrl}/models` first and then `{baseUrl}/v1/models` if the first endpoint fails or returns a non-JSON response. This handles providers where the UI root and API root differ.

If a provider cannot expose models without a token-consuming request, keep the model cache stale or unavailable and reserve deeper checks for an explicit diagnostic mode such as `ai doctor --deep`.

Status fields:

- level
- name
- configured baseUrl
- Claude runtime state
- Claude effective baseUrl
- Codex runtime state
- Codex effective baseUrl
- masked apiKey
- mode
- health
- last checked time
- token usage
- usage share

Token usage should be stored as events in `usage.json`.

Token usage must be real provider-returned data. AI Gateway should not estimate token usage when Claude Code or Codex CLI does not expose structured usage. Current real usage recording is implemented for AI Gateway-owned deep diagnostic requests, such as `ai doctor --deep`, when the provider response contains `usage`.

## Web Control Panel Direction

`ai web` should launch a local web control panel.

Planned features:

- Provider list.
- Provider health.
- Usage share.
- Token and cost curves.
- Visual provider add/edit.
- Drag-and-drop level ordering.
- Default model switching.
- Provider/model statistics.
- Hermes robot list, status, provider/model, Telegram binding, edit, native local config sync, tasks, recent errors, usage share, import/export, clear, and delete.

## Extension Management Direction

AI Gateway should eventually manage MCP servers and skills through a unified registry.

MCP direction:

- MCP is a shared protocol concept supported by both Claude Code and Codex CLI.
- Claude Code and Codex CLI do not use one identical configuration file.
- AI Gateway should maintain its own MCP registry and sync entries to each client's native configuration.
- The registry should support per-client enablement, because some MCP servers may only be safe or useful for one client.

Skills direction:

- Claude Code and Codex CLI both have a skills concept.
- Skills should be modeled as reusable workflow packages in AI Gateway.
- AI Gateway should store skill metadata once, then adapt installation or activation to each client.
- Skill execution can be security-sensitive, so future implementation needs trust, source, and permission metadata.

## Advanced Workflow Ideas

These ideas are recorded for future iterations. They should not all be built in the first version.

Recommended early investments:

- Local proxy mode: expose an OpenAI-compatible local endpoint such as `http://localhost:8787/v1`, then route requests through AI Gateway for provider switching, fallback, and usage tracking.
- Smart routing: `ai do "<task>"` chooses Claude Code or Codex CLI, provider, model, and mode based on task context.
- Git workflow commands: `ai review`, `ai fix`, `ai commit`, and `ai pr`.
- Project-level profile: store per-project defaults in `.ai-gateway/project.json`.
- Project-level last selection: prefer `ai last --cwd` or project-scoped last over terminal-scoped state.
- Unified MCP and skill management across Claude Code and Codex CLI.
- Sensitive file protection for `.env`, keys, certificates, private keys, and production config.

Additional ideas:
- Model fallback chains, such as `opus -> sonnet -> gpt -> mini`.
- Task modes: `ai task bugfix`, `ai task review`, `ai task refactor`, and `ai task docs`.
- Session aliases: `ai save <name>` and `ai resume <name>`.
- Session management: `ai session list` and `ai session resume <session-id>`.
- Budget protection with token or cost limits.
- Model and provider benchmark: `ai bench`.
- Rule-based routing by task, project, directory, or file type.
- Command replay: `ai replay` shows commands executed, files changed, and token usage.

## Multi-Terminal Isolation Decision

Full per-terminal isolation is not a near-term priority.

Current `ai use` launches Claude Code or Codex CLI with provider-specific environment variables in the child process. This means different terminals can use different providers at the same time without sharing the active chat process configuration.

Shared management files still exist:

- `.ai-cache.json`
- `.ai-gateway.log`
- `usage.json`
- global `lastSelection`

These shared files affect management state, not the running chat process itself.

Current decision:

- Keep global `ai last` for now.
- Document that `ai last` reuses the last launch parameters and does not restore chat context.
- Prefer project-level state next, such as `.ai-gateway/project.json` and `ai last --cwd`.
- Add session management before considering full per-terminal isolation.
- Treat full per-terminal isolation as low priority unless real multi-terminal conflicts appear.

## Doctor

`ai doctor` is the diagnostic command.

Default `ai doctor` must not intentionally consume model tokens.

It should check:

- `providers.json` existence, syntax, and schema.
- Provider name uniqueness.
- `mode` validity.
- `level` continuity and conflicts.
- Default model presence in cache.
- `.ai-cache.json` readability and writability.
- `usage.json` readability and writability.
- Claude Code CLI availability.
- Codex CLI availability.
- Lightweight provider connectivity.
- Token-free model discovery where supported.

`ai doctor --deep` may send a minimal inference request to validate the full request path. It must warn about possible token usage and require confirmation unless a future non-interactive confirmation flag is provided.

`ai doctor --deep` should use the currently highest-priority available provider by default, following `level` ascending. If that provider fails, it should fallback to the next available provider. If no provider can be used, it should automatically return to regular `ai doctor` behavior without using a model.

## Development Conventions

Keep implementation decisions aligned with these principles:

- Keep AI-facing project documents in English when practical.
- Keep user-facing documentation in Chinese.
- Keep project documents under `docs/`, except the root `README.md`.
- Prefer clean core APIs over CLI-specific logic.
- Keep `providers.json` stable and human-editable.
- Keep internal runtime data in internal files.
- Validate configuration at read time.
- Preserve user edits.
- Avoid adding fields to `providers.json` unless users need to edit them directly.
- Add tests around config normalization, level swapping, fallback, and model selection.
- Update this profile and `PRD.md` whenever product behavior changes.
- Update `USAGE.md` whenever CLI command behavior changes.
- Update `USAGE.html` whenever user-facing usage documentation changes.

## Progress Sync Rules

When new work is completed, update the project record before finishing the task.

Update this file when:

- A new product decision is made.
- A command behavior changes.
- A new configuration field is added.
- Architecture changes.
- A new surface is introduced, such as web or desktop.
- A todo item is completed or reprioritized.

Update `PRD.md` when:

- User-facing requirements change.
- Acceptance criteria change.
- New workflows are added.
- Existing workflows are removed or redefined.

Update `USAGE.md` when:

- A command is added, removed, or renamed.
- Command arguments change.
- Default command behavior changes.

Update `USAGE.html` when:

- `USAGE.md` changes.
- A more visual user-facing command reference is needed.

## Current Status

- Repository started from an empty directory.
- `PRD.md` has been created.
- `USAGE.md` has been created as the concise command reference.
- `USAGE.html` has been created as the visual Chinese usage page.
- Product and usage documents have been moved under `docs/`.
- Foundation CLI has been implemented with no runtime third-party dependencies.
- Implemented commands: `ai`, `ai help`, `ai add`, `ai provider list`, `ai provider edit`, `ai provider delete`, `ai session`, `ai session list`, `ai session clear`, `ai report`, `ai status`, `ai log`, `ai context`, `ai doctor`, `ai doctor --deep`, `ai use`, `ai last`, and a placeholder `ai web`.
- Implemented core stores: `providers.json`, `.ai-cache.json`, and `usage.json`.
- Implemented real token usage recording for provider responses that include usage data, currently from `ai doctor --deep`.
- Implemented provider level normalization, level swapping, model discovery with `/v1/models` fallback, lightweight health checks, status rendering, fallback resolution, and runner environment setup.
- Implemented operational logging to `.ai-gateway.log` and `ai log` for recent log inspection.
- Implemented project context generation to `.ai-gateway/context.md`.
- Implemented CLI command resolution fallback for known macOS app paths, including `/Applications/Codex.app/Contents/Resources/codex`.
- Added Node tests for provider normalization, level swapping, model compatibility, usage parsing, provider add/edit, status aggregation, doctor diagnostics, deep usage recording, and provider fallback.
- Added `.gitignore` to keep API keys and runtime files out of Git.
- Added Chinese `README.md` with install, build, test, and local link instructions.
- Added interactive release script: `npm run release`; script usage lives in `scripts/USAGE.md`.
- Added GitLab CI release plan for tag-triggered npm publishing.
- Implemented Hermes robot foundation: `ai hermes`, `ai hermes add/list/edit/status/use/clear/delete/import/import-local/export`, `ai use hermes <robot>`, user-editable `hermes.json`, robot store, state store, import/export, local Hermes import, native local config sync with callable model refresh, deferred provider sync from Hermes command paths, Hermes `/model` compatibility patching, and isolated Hermes runtime launch.
- Hermes robot integration has been documented in `docs/HERMES_INTEGRATION.md`.
- Product direction is CLI first, with web and Flutter desktop planned.

## Next Implementation Steps

1. Add CLI process-level tests for Hermes command parsing and terminal output.
2. Add Hermes robot usage aggregation once structured Hermes usage is available.
3. Add optional Hermes native task/gateway management after robot launch flow is stable.
4. Harden Claude Code and Codex runner argument and permission mapping.
5. Add project-level profile support.
6. Add sensitive file protection rules.
7. Implement local server foundation for future `ai web`.
8. Implement web control panel foundation, including Hermes robot management.
