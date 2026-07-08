# Development Conventions

## Architecture Direction

Use a layered architecture:

```text
src/
  core/    — business logic, config, provider management, health, usage, fallback, runner
  cli/     — command parsing, interactive prompts, table output
  server/  — local HTTP API for web and future Flutter desktop clients
  web/     — local control panel
```

CLI, web, and desktop must call core APIs. They should not directly implement provider business rules.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full technical architecture details.

## Configuration Philosophy

Provider configuration is global by default at `~/.ai-gateway/providers.json`. `AI_GATEWAY_HOME` can override the config directory.

Principles:

- `providers.json` is user-facing and should stay minimal.
- Only include fields users need to configure directly.
- Internal runtime data belongs in internal files (`.ai-cache.json`, `usage.json`, `.ai-gateway.log`).
- Internal runtime data should not pollute `providers.json`.
- JSON runtime stores should tolerate trailing duplicate content and rewrite clean JSON on the next save.
- Writes should use temp-file plus rename semantics to reduce corruption from concurrent CLI processes.
- Validate configuration at read time.
- Preserve user edits.

## Development Conventions

- Keep AI-facing project documents in English when practical.
- Keep user-facing documentation in Chinese.
- Keep project documents under `docs/`, except the root `README.md`.
- Prefer clean core APIs over CLI-specific logic.
- Keep `providers.json` stable and human-editable.
- Avoid adding fields to `providers.json` unless users need to edit them directly.
- Add tests around config normalization, level swapping, fallback, and model selection.

Documentation update rules:

- Update `SPEC.md` when product behavior or requirements change.
- Update `USAGE.md` when CLI command behavior changes.
- Update `USAGE.html` when user-facing usage documentation changes.
- Update `ARCHITECTURE.md` when system architecture changes.

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

## Progress Sync Rules

When new work is completed, update the project record before finishing the task.

Update `SPEC.md` when:

- A new product decision is made.
- A command behavior changes.
- A new configuration field is added.
- A new surface is introduced (web, desktop).
- A todo item is completed or reprioritized.
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

- Foundation CLI implemented with no runtime third-party dependencies.
- Implemented commands: `ai`, `ai help`, `ai add`, `ai provider list`, `ai provider edit`, `ai provider delete`, `ai session`, `ai session list`, `ai session clear`, `ai report`, `ai status`, `ai log`, `ai context`, `ai doctor`, `ai doctor --deep`, `ai use`, `ai last`, placeholder `ai web`.
- Implemented core stores: `providers.json`, `.ai-cache.json`, `usage.json`.
- Implemented real token usage recording for provider responses with usage data (from `ai doctor --deep`).
- Implemented provider level normalization, level swapping, model discovery with `/v1/models` fallback, lightweight health checks, status rendering, fallback resolution, and runner environment setup.
- Implemented operational logging and `ai log` for recent log inspection.
- Implemented project context generation.
- Implemented CLI command resolution fallback for known macOS app paths.
- Implemented Hermes robot foundation: `ai hermes`, add/list/edit/status/use/clear/delete/import/import-local/export, user-editable `hermes.json`, robot store, state store, native local config sync with callable model refresh, deferred provider sync, Hermes `/model` compatibility patching, and isolated Hermes runtime launch.
- Added Node tests for provider normalization, level swapping, model compatibility, usage parsing, provider add/edit, status aggregation, doctor diagnostics, deep usage recording, and provider fallback.
- Added `.gitignore`, Chinese `README.md`, interactive release script, GitLab CI release plan.
- Implemented Telegram Bot subsystem (see `telegram-bot-spec.md`).
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
