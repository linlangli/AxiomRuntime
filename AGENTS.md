# AI Runtime Repository Instructions

## Product Identity

This repository is building an enterprise AI Runtime, not merely a provider gateway, an assistant, a memory product, or an agent framework.

The Runtime is the product. Providers, models, agents, memory, knowledge, skills, workflows, tools, execution, reasoning, and learning are replaceable Runtime capabilities.

North star: every interaction should make the Runtime more capable, reliable, and reusable for the organization.

Read these documents before making architectural or product changes:

1. `docs/PROJECT_CONSTITUTION.md` - immutable product direction and decision principles.
2. `docs/AI_RUNTIME_ARCHITECTURE.md` - target architecture and module boundaries.
3. `docs/SPEC.md` - normative product behavior and acceptance criteria.
4. `docs/CONVENTIONS.md` - engineering and documentation rules.

## Architecture Rules

- Put reusable business behavior in `src/core`; delivery surfaces must call stable core APIs.
- Treat CLI, Telegram, web, desktop, schedulers, and external agents as adapters, not owners of domain logic.
- Keep provider and model integrations behind replaceable interfaces.
- Prefer enhancing an existing capability over creating a new subsystem. New modules must prove a distinct responsibility.
- Design capabilities for plugin discovery, composition, replacement, versioning, and policy control.
- Learning is governed: models may propose knowledge, skills, or capabilities, but deterministic policy and human authority decide activation.
- Optimize for accumulated organizational capability, not only the success of one response.
- Preserve auditability, tenant isolation, security boundaries, reversibility, and explicit permission checks.
- Keep external interfaces stable while internal implementations evolve.
- Keep one Runtime Transport Proxy data plane per execution. Protocol compatibility is a critical transport responsibility, UsageObserver is the sole owner of usage/cost records and metrics, and MemoryExtension must not create another listener, forwarder, compatibility path, or usage ledger.
- Build only the product-defining control plane and authoritative semantics. Adopt mature extraction, retrieval, vector, temporal-graph, checkpoint, queue, sequence-mining, policy-evaluation, cryptography, storage, and telemetry implementations behind stable adapters; never reimplement a general-purpose engine without an ADR proving a material contract or safety gap.
- External memory components may produce add-only candidates, policy evidence, or rebuildable projections. They may not own Runtime identity, Claim/Evidence truth, activation, scope promotion, permissions, audit, or purge semantics.

## Documentation Audiences

AI-facing and maintainer-facing normative documents are written in English. User-facing documents are written in Chinese.

English normative documents:

- `AGENTS.md`
- `docs/PROJECT_CONSTITUTION.md`
- `docs/AI_RUNTIME_ARCHITECTURE.md`
- `docs/SPEC.md`
- `docs/CONVENTIONS.md`

Chinese user and review documents:

- `README.md`
- `docs/README.md`
- `docs/USAGE.md`
- `docs/USAGE.html`
- `docs/ARCHITECTURE.md`
- `docs/memory-system-spec.md`
- `docs/telegram-bot-spec.md`

Chinese design documents preserve detailed product and review context. When they conflict with an English normative document, do not silently choose one: update both documents in the same change or surface the conflict.

## Required Documentation Updates

- The English normative layer is living documentation. Every development task must assess and update it before completion; documentation sync is part of the definition of done, not a later cleanup task.
- Product direction or acceptance behavior: update `docs/SPEC.md` and the relevant Chinese user document.
- Architecture or ownership boundary: update `docs/AI_RUNTIME_ARCHITECTURE.md` and, when user-visible, `docs/ARCHITECTURE.md`.
- CLI or configuration behavior: update `docs/USAGE.md` and `docs/USAGE.html`.
- A new invariant or development rule: update `docs/CONVENTIONS.md`.
- A constitutional change: requires explicit human approval and an update to `docs/PROJECT_CONSTITUTION.md`.

Required maintenance cadence:

- Per task: review `SPEC.md`, `AI_RUNTIME_ARCHITECTURE.md`, and `CONVENTIONS.md`; update every affected document in the same change.
- Per milestone or release: audit the full English normative layer against current code, migrations, feature flags, tests, and known limitations.
- After a major incident or architectural reversal: record the new invariant, failure mode, and migration consequence immediately.
- Never leave knowingly stale normative text. If implementation and documentation cannot be reconciled in the current task, mark the gap explicitly with status, owner, and exit condition.

`PROJECT_CONSTITUTION.md` is intentionally stable and changes only through explicit human direction. The other English normative documents are living sources of truth and must evolve with implementation.

## CodeGraph

Use the configured CodeGraph MCP server for structural code questions:

- `codegraph_context` for feature or architecture context, followed by one `codegraph_explore` call when source bodies are needed.
- `codegraph_search` for symbol definitions.
- `codegraph_callers` and `codegraph_callees` for direct dependencies.
- `codegraph_trace` for end-to-end call paths.
- `codegraph_impact` before structural refactors.
- `codegraph_files` for indexed directory contents and `codegraph_status` for index health.

Use `rg` and direct file reads for literal text, documentation, configuration values, or files explicitly identified by path. Trust fresh CodeGraph AST results; do not duplicate them with grep. If CodeGraph reports edited files pending sync, read only those stale files directly. If the repository is not initialized, ask before running `codegraph init -i`.

## Delivery Standard

A capability is not complete until its stable interface, policy boundary, failure behavior, observability, tests, migration path, English normative documentation, and Chinese user documentation are defined. Feature flags may defer activation; they may not disguise an incomplete implementation as complete.
