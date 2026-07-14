# AI Runtime Repository Instructions

## Product Identity

This repository is building an enterprise AI Runtime, not merely a provider gateway, an assistant, a memory product, or an agent framework.

The Runtime is the product. Providers, models, agents, memory, knowledge, skills, workflows, tools, execution, reasoning, and learning are replaceable Runtime capabilities.

North star: every interaction should make the Runtime more capable, reliable, and reusable for the organization.

Read these documents before making architectural or product changes:

1. `docs/AI_RUNTIME_ARCHITECTURE.md` - target architecture and module boundaries (English canon).
2. `docs/CONVENTIONS.md` - engineering and documentation rules (English canon).
3. `docs/00-overview.md` - product identity, the three hard invariants, and the migrated project-constitution summary (see its appendices).
4. `doc_2.0` layer (root docs under `docs/` plus per-module docs under `docs/modules/`) - normative product behavior, capabilities, acceptance criteria (`enforcement-decisions.md`, R1–R36 / Q1–Q6), roadmap, and per-module design.

The former `docs/SPEC.md`, `docs/PROJECT_CONSTITUTION.md`, `docs/ARCHITECTURE.md`, `docs/USAGE.md`, `docs/memory-system-spec.md`, and `docs/telegram-bot-spec.md` have been migrated into the `doc_2.0` layer (now flattened into `docs/` and `docs/modules/`); consult `docs/README.md` for the index.

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
- `docs/AI_RUNTIME_ARCHITECTURE.md`
- `docs/CONVENTIONS.md`

Chinese-English hybrid normative layer (`doc_2.0`, living in `docs/` and `docs/modules/`): prose in Chinese; all identifiers (type/port/field names, paths, rule ids R1–R36 / Q1–Q6, config keys, enum values) stay in canonical English, never translated. This layer holds the migrated product spec, constitution summary, memory/learning design, transport protocol, Telegram surface design, acceptance criteria, and roadmap. Index: `docs/README.md`.

Chinese user and review documents:

- `README.md`
- `docs/README.md`
- `docs/usage.md`
- `docs/USAGE.html`

When the `doc_2.0` layer conflicts with an English canon document (`AI_RUNTIME_ARCHITECTURE.md` / `CONVENTIONS.md`), do not silently choose one: update both in the same change or surface the conflict. Identifiers in the `doc_2.0` layer must match code exactly.

## Required Documentation Updates

- The normative layer is living documentation. Every development task must assess and update it before completion; documentation sync is part of the definition of done, not a later cleanup task.
- Product direction or acceptance behavior: update `docs/enforcement-decisions.md` (R/Q clauses) and the relevant `docs/modules/` module document.
- Architecture or ownership boundary: update `docs/AI_RUNTIME_ARCHITECTURE.md` and the affected `docs/modules/` module document.
- CLI or configuration behavior: update `docs/usage.md` and `docs/USAGE.html`.
- A new invariant or development rule: update `docs/CONVENTIONS.md`.
- A change to product mission, north star, or the three hard invariants: requires explicit human approval and an update to the constitution appendix in `docs/00-overview.md`.

Required maintenance cadence:

- Per task: review `docs/AI_RUNTIME_ARCHITECTURE.md`, `docs/CONVENTIONS.md`, and the affected `doc_2.0` documents (`docs/*.md` and `docs/modules/*.md`); update every affected document in the same change.
- Per milestone or release: audit the full normative layer against current code, migrations, feature flags, tests, and known limitations.
- After a major incident or architectural reversal: record the new invariant, failure mode, and migration consequence immediately.
- Never leave knowingly stale normative text. If implementation and documentation cannot be reconciled in the current task, mark the gap explicitly with status, owner, and exit condition.

The constitution summary (mission, north star, hard invariants) in `docs/00-overview.md` is intentionally stable and changes only through explicit human direction. The other normative documents are living sources of truth and must evolve with implementation.

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
