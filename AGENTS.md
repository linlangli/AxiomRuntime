# AI Runtime Repository Instructions

## Product Identity

This repository is building an AI Runtime, not merely a provider gateway, an assistant, a memory product, or an agent framework.

The Runtime is the product. Providers, models, agents, memory, knowledge, skills, workflows, tools, execution, reasoning, and learning are replaceable Runtime capabilities.

North star: every interaction should make the Runtime more capable, reliable, and reusable for the organization.

Read these documents before making architectural or product changes:

1. `docs/architecture.md` - target architecture, module boundaries, the three hard invariants, and the implemented-vs-planned state map.
2. `docs/prd.md` - product positioning, capability inventory, release plan, delivery risks, and acceptance gates.
3. `docs/usage.md` - user-facing behavior of every shipped command.

All three documents mark implementation status explicitly (🟢 shipped / 🟡 partial / 🔴 planned). Never treat a 🔴 item as available.

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

`AGENTS.md` and `CLAUDE.md` are English maintainer instructions. The three documents under `docs/` use Chinese prose with canonical English identifiers: type/port/field names, paths, config keys, and enum values stay in English and are never translated. Identifiers in `docs/` must match code exactly.

| Document | Audience | Content |
|---|---|---|
| `docs/usage.md` | End users | How to use every shipped command |
| `docs/architecture.md` | Developers | Design, layering, ownership boundaries, Mermaid diagrams |
| `docs/prd.md` | Developers and product | Positioning, capability inventory, releases, risks, gates |
| `docs/USAGE.html` | End users | HTML command manual opened by `ai help`; the only doc shipped in the npm package |

Do not add new normative documents under `docs/`. Extend one of the three above instead. The consolidated set replaces the former `doc_2.0` layer (`00-overview.md`, `AI_RUNTIME_ARCHITECTURE.md`, `CONVENTIONS.md`, `enforcement-decisions.md`, `roadmap.md`, `contracts.md`, `glossary.md`, `testing.md`, `service-level-objectives.md`, `extraction-readiness.md`, `architecture-map.md`, `AI_RUNTIME_PORTABLE_SPEC.md`, and `docs/modules/*`); consult git history for the superseded text.

## Required Documentation Updates

- The three documents are living documentation. Every development task must assess and update them before completion; documentation sync is part of the definition of done, not a later cleanup task.
- CLI or configuration behavior: update `docs/usage.md` and `docs/USAGE.html`.
- Architecture, ownership boundary, or a new engineering rule: update `docs/architecture.md`.
- Product direction, capability status, release plan, or acceptance behavior: update `docs/prd.md`.
- A change to product mission, north star, or the three hard invariants: requires explicit human approval and an update to `docs/architecture.md` section 2.
- Any status change (🔴 → 🟡 → 🟢) must be reflected in every document that lists that capability. A capability may only be marked 🟢 when it is verifiable in `src/`.

Required maintenance cadence:

- Per task: review all three documents and update every affected one in the same change.
- Per milestone or release: audit the full set against current code, migrations, feature flags, tests, and known limitations.
- After a major incident or architectural reversal: record the new invariant, failure mode, and migration consequence immediately.
- Never leave knowingly stale normative text. If implementation and documentation cannot be reconciled in the current task, mark the gap explicitly with status, owner, and exit condition.

The mission, north star, and three hard invariants in `docs/architecture.md` are intentionally stable and change only through explicit human direction. Everything else must evolve with implementation.

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

### Local Web Control Plane

- Local Web settings must call shared core configuration APIs and retain loopback Host, Origin, and token checks. Never expose the management adapter through generated reverse-proxy configuration.
- Service exposure is configured in `service-exposure.json`; server authentication must enforce the intersection of global enabled capabilities and a caller credential's capabilities before dispatch. Credential values are shown only at creation and persisted as SHA-256 digests.
- Managed configuration snapshots contain secrets and must use restricted file permissions. Restore operations must preserve the current service credential set so revoked credentials are never reactivated by restoring an older snapshot. Codex user configuration, usage ledgers, and databases are outside snapshot scope.

A capability is not complete until its stable interface, policy boundary, failure behavior, observability, tests, migration path, English normative documentation, and Chinese user documentation are defined. Feature flags may defer activation; they may not disguise an incomplete implementation as complete.
