# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build        # Clean + compile TypeScript + chmod executable
npm test             # Build then run tests (Node.js built-in test runner)
npm run dev          # Run CLI with source maps
npm link             # Install globally as `ai` command
```

Single test file: `npm run build && node --test test/core.test.js`

Node.js >= 22.19.0 required. TypeScript compiles to ES2022 with NodeNext modules.

## Architecture

This is an enterprise AI Runtime — not merely a provider gateway or assistant. The Runtime is the product; providers, models, memory, skills, and tools are replaceable capabilities.

### Source Layout

```
src/
  core/       Runtime business logic (contracts, routing, config, usage, memory)
  cli/        CLI surface adapter (command registry → `ai` binary)
  telegram/   Telegram bot surface adapter (grammY, long-polling)
```

### Key Principle: Surfaces are Adapters

CLI, Telegram, and future surfaces call stable core APIs. They must not implement provider routing, memory policy, or tool authorization directly.

### Core Modules

- `core/config/` — JSON stores with temp-file-rename writes, schema validation
- `core/runner/` — OpenAI-compatible proxy, tool execution, fallback logic, usage recording
- `core/providers/` — Provider CRUD, health tracking
- `core/models/` — Model discovery and filtering across providers
- `core/memory/` — Embedding configuration
- `core/usage/` — Token/cost tracking and pricing
- `core/sessions/` — Session recording

### Configuration

Global config lives at `~/.ai-gateway/` (override with `AI_GATEWAY_HOME`):
- `providers.json` — user-facing provider config (keep minimal, human-editable)
- `.ai-cache.json`, `usage.json`, `sessions.json` — internal runtime data
- `telegram.json`, `telegram.sqlite` — Telegram bot state

## Normative Documentation

Three documents under `docs/`. Read before making architectural changes:

1. `docs/architecture.md` — mission, three hard invariants, target architecture, current-state map, Mermaid diagrams
2. `docs/prd.md` — product positioning, capability inventory, release plan, delivery risks, acceptance gates
3. `docs/usage.md` — user-facing behavior of every shipped command

All three use status markers: 🟢 shipped / 🟡 partial / 🔴 planned. **Never treat a 🔴 item as available.** A capability may only be marked 🟢 when it is verifiable in `src/`.

Documentation is part of done: every task must update the affected documents in the same change. Do not add a fourth normative doc — extend one of the three. `AGENTS.md` and `CLAUDE.md` are English; the `docs/` set uses Chinese prose with English identifiers (never translate identifiers).

## Design Rules

- Enhance an existing capability before adding a new module.
- Prefer adopting mature libraries behind typed adapters over reimplementing general-purpose engines.
- JSON stores use temp-file + rename to avoid corruption from concurrent processes.
- `providers.json` is stable and human-editable; internal runtime state goes in separate files.
- Keep the Node.js minimum version synchronized across `package.json`, `.gitlab-ci.yml`, and docs.

## Testing

Tests use Node.js built-in `node:test` module. Test files live in `test/*.test.js` and run against the compiled `dist/` output. The three test files cover core logic, services, and Telegram integration.
