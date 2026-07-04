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

`ai help` opens `USAGE.html`.

Direct:

```bash
ai help
ai use claude
ai use codex
ai use claude 51talk claude-opus-4-6
ai use codex 51talk gpt-5.5
ai add 51talk https://example.com sk-xxx
ai edit
ai status
ai web
```

## Configuration Philosophy

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

Internal files:

- `.ai-cache.json`: provider health, model discovery cache, last checked time, last error.
- `usage.json`: token usage events for status, charts, and future analytics.

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
- `ai edit` changes model by selecting from discovered models.
- Users do not manually type model names in interactive flows.
- Direct commands may specify a model explicitly.
- If no model is specified in `ai use`, use the provider default model.

## Permission Mode

Each provider has a `mode`:

- `auto`: highest permission mode, default value.
- `ask`: ask before sensitive execution.

The runner layer should map `mode` to Claude Code or Codex CLI permissions where supported. If a downstream CLI does not support an equivalent setting, enforce the behavior in this tool before launch.

## Status And Usage

`ai status` should list all providers and include health.

`ai status` refreshes all providers before rendering the table. This refresh must be lightweight: connectivity check and model discovery only. It must not send chat, completion, or inference requests by default, so it should not intentionally consume model tokens.

If a provider cannot expose models without a token-consuming request, keep the model cache stale or unavailable and reserve deeper checks for an explicit diagnostic mode such as `ai doctor --deep`.

Status fields:

- level
- name
- baseUrl
- masked apiKey
- mode
- default model
- health
- last checked time
- token usage
- usage share

Token usage should be stored as events in `usage.json`.

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
- Product direction is CLI first, with web and Flutter desktop planned.
- Implementation has not started yet.

## Next Implementation Steps

1. Initialize TypeScript CLI project.
2. Implement core config types and stores.
3. Implement provider add/edit/status flows.
4. Implement model discovery cache.
5. Implement fallback selection.
6. Implement Claude Code and Codex runner adapters.
7. Add README and verification commands.
