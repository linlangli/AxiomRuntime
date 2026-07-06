# Hermes Robot Integration Plan

## Goal

Integrate Hermes into AI Gateway as a robot runtime management surface.

The primary purpose is not to replace Hermes, but to make Hermes robots easier to create, inspect, use, reset, delete, export, and import through the unified `ai` command.

Hermes integration must reuse AI Gateway providers. Users should not need to re-enter provider API keys when creating Hermes robots.

## Product Model

Hermes is modeled as robot management, not as a provider.

AI Gateway concepts:

- Provider: model endpoint configuration stored in `providers.json`.
- Hermes robot: a named AI Gateway-managed robot that references an existing provider and model.
- Hermes CLI: the downstream runtime used when a robot is launched.

Provider configuration remains in:

```text
~/.ai-gateway/providers.json
```

Hermes robot configuration should be stored separately in:

```text
~/.ai-gateway/hermes.json
```

## Configuration Shape

`hermes.json` should stay portable, user-editable, and must not contain API keys.

Only user-facing configuration belongs in `hermes.json`. Do not store internal metadata such as source, created time, updated time, health, sessions, or runtime state there.

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
    ],
    "createdAt": "2026-07-05T00:00:00.000Z",
    "updatedAt": "2026-07-05T00:00:00.000Z"
  }
]
```

Rules:

- `name` must be unique.
- `provider` references an AI Gateway provider by name.
- `model` is selected from the referenced provider's discovered model list when available.
- `mode` follows AI Gateway provider mode semantics: `ask` or `auto`.
- Telegram binding is optional.
- Hermes cron jobs are tasks that belong to a robot. They are not robots.
- Task schedule is intentionally not stored in `hermes.json`; users should change schedules by chatting with the robot or through future task management commands.
- API keys are resolved at launch time from `providers.json`.
- Each robot launches with an AI Gateway-managed isolated `HERMES_HOME` under `~/.ai-gateway/hermes/<robot-name>/`.
- The isolated Hermes runtime config is regenerated from the selected AI Gateway provider before launch, so global `~/.hermes/config.yaml` cannot override the robot's provider API key.
- Import/export files must not include API keys.

## CLI Commands

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

`exit` is only an interactive menu item. Do not implement `ai hermes exit` unless a future need appears.

## Add Flow

Command:

```bash
ai hermes add
```

Interactive steps:

1. Input robot name.
2. Select provider from AI Gateway providers.
3. Select model from provider model cache.
4. Select mode: `auto` or `ask`, defaulting to `auto`.
5. Optionally configure Telegram binding:
   - chat id
   - display name
6. Save to `hermes.json`.

## Edit Flow

Command:

```bash
ai hermes edit
```

Editable fields:

- name
- default provider
- default model
- mode
- Telegram binding

The flow should be selection-first. Avoid requiring users to remember provider names or model names.

After add/edit, the CLI automatically syncs the selected robot into native local Hermes config for Telegram use and attempts to restart the local Hermes gateway.

## List Flow

Command:

```bash
ai hermes list
```

Show robot configuration only. Do not refresh health.

Fields:

- name
- provider
- model
- mode
- Telegram binding
- created time
- updated time

## Status Flow

Command:

```bash
ai hermes status
```

Show a card-style status for each robot.

Checks:

- Hermes CLI is installed.
- Referenced provider exists.
- Referenced provider health from AI Gateway cache/status.
- Referenced model exists in current model cache when available.
- Telegram binding status.
- Last robot session or error if tracked.

Output should be narrow-terminal friendly, similar to `ai status`.

## Use Flow

Command:

```bash
ai hermes use <robot-name>
```

Interactive:

```bash
ai hermes
```

Then choose `use` and select a robot.

Launch behavior:

1. Load robot config.
2. Resolve the referenced provider from `providers.json`.
3. Resolve model from robot config.
4. Regenerate the robot-specific Hermes runtime config under `~/.ai-gateway/hermes/<robot-name>/`.
5. Start Hermes CLI with `HERMES_HOME` pointing at that robot-specific runtime home.
6. Do not allow the user's native `~/.hermes/config.yaml` to override the selected robot provider key.
7. Do not mutate the user's native `~/.hermes/config.yaml` by default.
8. Write AI Gateway session and log records.

Runtime injection:

- Anthropic-compatible robots: write `model.provider: anthropic`, selected base URL, selected API key, and also pass `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
- OpenAI-compatible robots: write `model.provider: auto`, selected base URL, selected API key, and also pass `OPENAI_API_KEY` / `OPENAI_BASE_URL`.

## Native Local Config Sync

Command:

```bash
ai hermes sync <robot-name>
```

Purpose:

- Make native local Hermes surfaces, especially Telegram-backed Hermes, use the same provider/model selected in AI Gateway.
- This command is a manual repair path. Normal add/edit flows sync and restart automatically.
- This is separate from `ai hermes use`, which launches Hermes with an isolated AI Gateway-managed `HERMES_HOME`.

Behavior:

1. Load the robot from `hermes.json`.
2. Refresh all AI Gateway providers and update the model cache.
3. Resolve the referenced provider from `providers.json`.
4. Write the robot's model, provider kind, base URL, and API key into the top-level `model:` block in `~/.hermes/config.yaml` or `AI_GATEWAY_HERMES_HOME/config.yaml`.
5. Write all AI Gateway providers and discovered model candidates into native Hermes `providers:` and `custom_providers:` so gateway `/model` lists AI Gateway providers only.
6. Clear native Hermes provider credential entry points in `.env` and `auth.json` that would otherwise make built-in providers appear in `/model`.
7. Preserve unrelated native Hermes config blocks.
8. Restart the local Hermes gateway when possible.
9. Log only the API key fingerprint, not the full key.

Provider-only sync:

- `ai add` and `ai edit` must refresh all providers, write the AI Gateway provider list and discovered model candidates into native Hermes config, clear native Hermes credential entry points, and restart the local gateway.
- Provider-only sync must preserve the existing native Hermes top-level `model:` block so Telegram keeps using the currently selected robot/model until `ai hermes add/edit/sync` changes it.
- If the installed Hermes `model_switch.py` only reads `default_model` for user-defined providers, sync applies a small compatibility patch so Telegram `/model` reads `providers.<name>.models` from native Hermes config. A `.ai-gateway.bak` backup is kept before patching.

Rules:

- Never write API keys into `hermes.json`.
- Sync is allowed to write API keys into native Hermes config because that is the configuration file the native Hermes service uses.
- After sync, Telegram `/model` should show only AI Gateway-configured providers.
- Restart prefers launchd `ai.hermes.gateway` on macOS and falls back to `hermes gateway restart`.

## Clear Flow

Command:

```bash
ai hermes clear
```

Interactive only in the first version:

1. Select robot.
2. Confirm reset.
3. Clear robot runtime memory and AI Gateway-managed robot state.

`clear` keeps robot configuration.

Keep:

- name
- provider
- model
- mode
- Telegram binding
- created time

Clear:

- robot session records
- last-used state
- local robot context
- AI Gateway-managed robot memory
- isolated Hermes runtime home for that robot
- robot token usage aggregation when tracked per robot
- robot error history

Do not delete unrelated Hermes native global history unless the file is explicitly owned by this robot integration.

## Delete Flow

Command:

```bash
ai hermes delete
```

Interactive only in the first version:

1. Select robot.
2. Require a destructive confirmation.
3. Delete robot configuration.
4. Delete AI Gateway-managed robot state.

`delete` removes the robot from `hermes.json`.

## Import And Export

Export:

```bash
ai hermes export <robot-name>
```

Default output:

```text
~/.ai-gateway/exports/hermes-<robot-name>.json
```

Import:

```bash
ai hermes import <file>
```

Import local Hermes:

```bash
ai hermes import-local
ai hermes import-local --overwrite
```

Import rules:

- Import files must not contain API keys.
- If the referenced provider does not exist locally, import succeeds but status should show `provider missing`.
- If a robot with the same name already exists, prompt to overwrite, rename, or cancel.

Local import rules:

- Scan `~/.hermes/config.yaml` for the default model/provider/base URL.
- Scan `~/.hermes/channel_directory.json` for Telegram binding.
- Scan `~/.hermes/cron/jobs.json` for local Hermes cron jobs and import them as robot tasks.
- Do not import or persist Hermes API keys.
- Match local Hermes models to existing AI Gateway providers when possible.
- If no matching AI Gateway provider exists, keep the local provider name and show `provider missing` in status.

## Web Management Direction

Hermes robot support must be implemented as reusable core services, not CLI-only logic.

Future `ai web` should be able to show:

- robot list
- robot status
- provider/model per robot
- Telegram binding
- usage share
- token curves
- recent errors
- import/export controls
- clear/delete actions
- model switching

## Architecture

Add these modules:

```text
src/core/hermes/hermes-types.ts
src/core/hermes/hermes-store.ts
src/core/hermes/hermes-service.ts
src/core/hermes/hermes-runner.ts
src/cli/commands/hermes.ts
```

Responsibilities:

- `hermes-types.ts`: type definitions.
- `hermes-store.ts`: read/write `hermes.json` and robot state files.
- `hermes-service.ts`: business logic for add, list, status, use, clear, delete, import, export.
- `hermes-runner.ts`: Hermes CLI detection and launch command construction.
- `commands/hermes.ts`: command parsing and interactive prompts only.

Future server route:

```text
src/server/routes/hermes.ts
```

CLI, web, and desktop surfaces must call `core/hermes`.

## Implementation Status

Implemented foundation:

- `ai hermes`
- `ai hermes add`
- `ai hermes list`
- `ai hermes edit`
- `ai hermes status`
- `ai hermes use <robot-name>`
- `ai use hermes <robot-name>`
- `ai hermes import <file>`
- `ai hermes import-local`
- `ai hermes export <robot-name>`
- `ai hermes clear`
- `ai hermes delete`
- robot session tracking through AI Gateway `sessions.json`
- robot runtime state tracking through `hermes-state.json`

Next:

- robot-specific usage aggregation when structured Hermes usage is available
- optional Hermes native task/gateway management
- CLI process-level tests for terminal output

Future:

- Web management API
- Web management UI
- visual provider/model switching
- usage charts and recent error display

## Test Coverage

Add tests for:

- robot store create/read/update/delete
- duplicate robot name validation
- provider missing status
- model missing status
- import/export without secrets
- clear keeps robot configuration
- delete removes robot configuration
- use command resolves provider and model
- Hermes binary detection
- CLI command routing

## Safety Rules

- Never write API keys to `hermes.json`.
- Never export API keys.
- Never mutate `~/.hermes/config.yaml` by default.
- Mask secrets in logs.
- Make destructive operations interactive first.
- Keep output readable in narrow terminals.
