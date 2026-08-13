# Development Conventions

> Audience: AI agents and maintainers. This document is normative and must remain in English.

## Constitutional Order

The project is an enterprise AI Runtime. It is not merely a provider gateway, memory system, assistant, or agent framework.

Apply decisions in this order:

1. Constitution summary in `00-overview.md` (mission, north star, three hard invariants; changed only by explicit human direction)
2. `AI_RUNTIME_ARCHITECTURE.md`
3. This document
4. `doc_2.0` normative layer (product spec, acceptance criteria in `enforcement-decisions.md`, per-module design under `modules/`)
5. Chinese user documents

The Runtime is the product. Models, providers, memory, agents, skills, tools, and workflows are capabilities. Models may propose learned artifacts; deterministic policy and human authority govern activation.

## Architecture Direction

Use a layered architecture:

```text
src/
  core/       - Runtime contracts, orchestration, capabilities, policy, execution, learning
  cli/        - command and terminal surface adapter
  telegram/   - Telegram surface adapter
  server/     - local and enterprise API surface
  web/        - control and governance surface
  plugins/    - discoverable adapters and capability packages when introduced
```

CLI, Telegram, web, desktop, schedulers, and APIs must call stable core contracts. They must not directly implement provider routing, memory policy, skill promotion, or tool authorization.

See [AI_RUNTIME_ARCHITECTURE.md](AI_RUNTIME_ARCHITECTURE.md) for the normative target architecture and [00-overview.md](00-overview.md) for the Chinese layered overview plus the current-state implementation snapshot appendix.

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

- Top-level English normative documents (`AI_RUNTIME_ARCHITECTURE.md`, `AGENTS.md`, this file) remain in English.
- The `doc_2.0` documentation layer (`docs/*.md` plus `docs/modules/*.md`) uses Chinese-English hybrid mode: prose in Chinese for readability, while all identifiers (type/port/field names, file paths, rule ids such as R1–R36 / Q1–Q6, config keys, enum values) MUST stay in their canonical English form, never translated. Rationale: translating identifiers forks docs from code and lowers AI retrieval/match accuracy; hybrid mode maximizes accuracy for Chinese-native maintainers.
- Every concept has exactly one Chinese rendering, fixed in `docs/glossary.md`; normative verbs are fixed as 必须=must / 禁止=must not / 应当=should / 可=may.
- Keep user-facing documentation in Chinese.
- Keep project documents under `docs/`, except the root `README.md`.
- Keep the minimum Node.js runtime synchronized across `package.json`, `package-lock.json`, `.gitlab-ci.yml`, and user documentation. CI must execute the declared minimum version, currently `22.19.0`, so newer local runtimes cannot hide dependency incompatibilities.
- Publish npm as `@offerpilot/axiomruntime` and treat its versioned tarball as the sole CLI distribution source. Homebrew Formulae must pin the matching registry URL and SHA256, depend on `node@22`, and pass `ai --version`; the npm publish job must regenerate the Formula after building on the release runner and pass it as an artifact, because npm tarball bytes may differ across operating systems. A tag pipeline may update the Tap only after npm publication and registry checksum verification.
- Prefer clean core APIs over CLI-specific logic.
- Keep `providers.json` stable and human-editable.
- Avoid adding fields to `providers.json` unless users need to edit them directly.
- Add tests around config normalization, level swapping, fallback, and model selection.

Documentation update rules:

- Update the constitution summary in `00-overview.md` only with explicit human approval.
- Update `AI_RUNTIME_ARCHITECTURE.md` when ownership, boundaries, Runtime contracts, plugin rules, or capability evolution changes.
- Update `enforcement-decisions.md` and the affected `modules/` module document when product behavior or acceptance criteria change.
- Update `usage.md` when CLI command behavior changes.
- Update `USAGE.html` when user-facing usage documentation changes.
- Update the current-state snapshot appendix in `00-overview.md` when architecture changes are relevant to users or reviewers.

Required implementation behavior:

- Enhance an existing capability before adding a module.
- New modules require a documented responsibility that cannot fit an existing boundary.
- Use a Build/Adopt/Adapt decision before implementing infrastructure. Build Runtime contracts, authoritative Claim/Evidence, authority, governance, capability security, audit, and purge semantics; adopt mature general-purpose algorithms and backends behind typed adapters.
- Do not hand-roll ANN indexes, graph databases, general policy languages, cryptography, workflow checkpoint engines, queues, object stores, tokenizers, rerankers, or telemetry protocols unless an ADR demonstrates that available implementations cannot meet a specific contract, privacy, deployment, or license requirement.
- Treat Mem0-style extractors, Graphiti-style temporal graphs, Letta-style context blocks, LangGraph-style checkpointers, OPA/Cedar evaluators, and similar integrations as replaceable providers. Their ids, schemas, and SDK types cannot become public Runtime contracts or authoritative foreign keys.
- Third-party outputs are add-only candidates, policy evidence, or rebuildable projections. Rebind identity and scope, validate schema, propagate provenance, scan secrets, and evaluate local policy before any authoritative transition.
- Every external adapter requires contract fixtures, a local or approved fallback, kill switch, timeout/circuit behavior, export and purge semantics, an ADR, pinned versions, SBOM, license/CVE checks, data-egress classification, and replacement tests.
- Cross-module interfaces are typed, stable, and versioned when persisted or exposed.
- Administrative web, CLI, and API surfaces are adapters over the same enterprise control-plane contracts. They must not own identity truth, policy semantics, plugin activation, usage accounting, audit truth, retention, legal hold, or purge behavior.
- Federated identity is normalized through `IdentityDirectoryPort`; OIDC/SAML/SCIM ids cannot become Runtime authority or foreign keys. Bind executions to directory and policy revisions so mid-execution changes cannot silently widen permission.
- Enterprise policy and plugin changes use immutable revisions, validate-before-publish, explicit approval, scoped rollout, and rollback by new revision. Break-glass access remains time-, reason-, and audit-bound.
- Every enterprise deployment profile declares and tests residency, retention, legal hold, audit export, backup/restore, SLO, RTO, and RPO. Uncertain legal hold or residency fails closed for deletion or movement.
- Emit each semantic observation once through the canonical `CapabilityObservation` and `ObservabilitySinkPort`; JSONL, OpenTelemetry, metrics, and dashboards are projections, not separate call-site instrumentation. Observability is non-authoritative, bounded, non-blocking, content-free, and must expose sampling/drop completeness rather than implying a partial trace is complete.
- Treat the `RuntimeEventType`, payload map, `RuntimeErrorCode`, and retry classification in `contracts.md` as closed catalogs. Never persist free-form event names, raw provider errors, or unregistered diagnostic fields.
- Preserve Tool/Workflow/Agent boundaries: a Tool is one typed side effect, a Workflow is a recoverable state machine, and an Agent is an adapter whose tool proposals return to the Kernel for authorization. Hidden retries, permissions, provider switches, or side effects in adapters are forbidden.
- Meet the numeric release gates in `service-level-objectives.md`; hard safety regressions override availability error budgets.
- Provider-specific behavior stays in adapters.
- Treat package-install privilege separately from Runtime execution privilege. Claude launch paths must detect UID 0 before building arguments or temporary settings, must never forward `--dangerously-skip-permissions` from a privileged process, and must record any policy constraint from configured `bypassPermissions` to effective `default`; long-lived Runtime services should use a dedicated non-root OS identity.
- Resolve provider fallback candidates once per execution attempt. After selection, engine adapters execute the exact provider/model and never perform hidden second-stage routing.
- Treat expired runtime circuits as half-open probes. Do not let stale `status: error` metadata permanently disable a provider after its cooldown.
- Keep protocol compatibility distinct from transient upstream failure: native Responses may fall back to Chat only for explicit protocol incompatibility, never for Cloudflare `52x` or similar timeouts.
- When a child CLI splits diagnostics across stdout and stderr, preserve both before filtering benign lines so the provider failure and status code remain observable.
- Treat JSONL stdout as a framed stream rather than one event per process chunk: retain incomplete lines across chunks, flush the final line on close, and extract terminal error/result events before rendering a delivery-surface failure. Never expose protocol initialization envelopes as the primary user error.
- Transport network diagnostics may persist only sanitized request shape (byte count, item/tool counts, route path) and low-level error name/code/syscall. Never log request bodies, prompts, tool arguments, authorization, or API keys.
- Keep transport retries single-owned. Codex may retry a failed Responses request; the local proxy must not add another request retry, must give each caller retry a fresh upstream connection, and must let the HTTP client derive `content-length` from the final body.
- Bound time to first upstream headers independently from total task duration. The current Codex route uses 45 seconds and an execution-local two-timeout short circuit; a delivery retry must never cause model re-execution.
- Retry Telegram API calls only for transient network, connection, timeout, and HTTP 5xx failures. Keep retries bounded, and do not retry deterministic formatting or validation errors.
- Learning outputs retain provenance and remain candidates until policy promotes them.
- Automatic learning must follow the versioned sequence `RuntimeEvent -> LearningSignal -> LearningDecision -> LearningCandidate or no artifact -> EvaluationResult -> PolicyDecision`. Models may propose content or weak evaluations; they must not write final confidence, activation, scope promotion, permission, or LearningDecision state.
- Learning decisions must bind objective ids, input hash, policy and governor versions, reason codes, and budget. The same versioned deterministic input must produce the same authority boundary even when models change.
- Measure learning by capability gain and hard safety regressions, not artifact count, retrieval count, or model self-evaluation. Keep Evidence confidence separate from retrieval and outcome utility.
- Automatic compression may replace only rebuildable projections. Preserve complete source coverage, Claim/Evidence provenance, purge reachability, explicit pins, required audit history, evaluation results, and rollback artifacts.
- Automated forgetting should cool, invalidate, or archive projections before physical deletion. Physical deletion requires TTL, retention policy, or explicit user/organization authority.
- Scope promotion creates a separately governed and sanitized candidate. Never mutate a private artifact into a shared artifact or export private Evidence as a side effect of promotion.
- High-impact execution always passes deterministic permission checks.
- Every durable workflow defines idempotency, failure recovery, observability, and migration behavior.
- The Runtime has one local transport data plane per execution. Enhance the existing OpenAI Usage Proxy behind its stable facade; never chain or run a second Memory HTTP proxy for the same execution.
- The transport owns the listener, route lease, validated upstream, header policy, critical protocol decoding, compatibility transforms, streaming, and bounded extension dispatch. Usage is read-only for transport payloads but is the sole accounting writer; Memory is an independently governed extension. Extensions cannot own listeners or forward requests.
- Split the current proxy by responsibility: UsageObserver alone owns usage/cost records, metrics, and persistence; MemoryExtension owns none of them. The legacy facade is a view over Transport and the single UsageObserver, not a second implementation.
- Fan canonical events into separate bounded Usage and Memory channels. Memory backpressure or failure must not drop Usage; usage writes must be idempotent per actual upstream attempt and observable when degraded.
- `TransformCoordinator` is the only request mutator. Extension changes use declarative allowlisted patches on a canonical protocol AST, run before approved provider compatibility translation, and produce path-level manifests with before/after hashes.
- Keep the minimal forwarder failure-isolated from non-critical response parsers and Memory workers. Critical request parsing and compatibility remain supervised Transport responsibilities. Write downstream before Memory dispatch. Memory worker failure must narrow Memory without blocking the active stream; total forwarder failure must not create successful execution or learning evidence.
- Separate ephemeral transport capture from durable evidence in the type system. Raw authorization, full system/developer instructions, reasoning, tool arguments/output, and attachments cannot enter durable envelopes, jobs, events, logs, or fixtures. Recursive redaction and a persist-schema allowlist are mandatory.
- A transport adapter or extension change requires current Usage-facade parity tests, sanitized fixtures, pure-pass-through byte checks, declared-transform AST checks, streaming/tool completeness tests, bounded resource and process-kill tests, canary replay, compatibility profiles, prompt-cache/cost evaluation, and independent extension kill switches.
- Transport mode and Memory mode are separate. Memory health may narrow `full -> read_only -> shadow_capture -> passthrough -> disabled`; it cannot silently disable verified Usage or compatibility behavior. Models cannot widen mode or close a circuit.
- Detect active-listener and normalized upstream self-loops before launch. Loopback random ports are not a multi-tenant boundary; mutually untrusted tenants require separate OS users, containers, or equivalent network/process isolation.

## Release And CI

The project includes a GitLab CI pipeline in `.gitlab-ci.yml`.

CI rules:

- Normal branch and merge request pipelines run `npm test`.
- Docker dependency stages must provide the native build toolchain required by locked Node addons. Compile those addons in a disposable build stage, prune development dependencies there, and copy the resulting production dependency tree into an ABI-compatible final image; do not repeat `npm ci` in a toolchain-free final stage.
- Pin build and final Docker stages to the same declared minimum Node.js patch release so native addons are compiled and executed with the same Node ABI.
- Tag pipelines publish to npm.
- npm publishing requires the GitLab CI/CD variable `NPM_TOKEN`.
- A release tag must point to a commit contained in `origin/main`.
- The tag version must match `package.json` version. Both `v0.1.1` and `0.1.1` tag formats are accepted.
- The publish job runs `npm test` and `npm pack --dry-run` before `npm publish --access public`.

Release convention:

```bash
git switch main
git merge develop
npm run release:current # only when publishing a pre-set initial version
# npm run release      # subsequent interactive version bumps
git push origin main --tags
```

## Progress Sync Rules

The English normative documentation layer is a living source of truth. When development work is completed, update the project record before finishing the task. A task is incomplete while an affected normative document is stale.

At the end of every development task, explicitly review:

- `AI_RUNTIME_ARCHITECTURE.md` for ownership, boundaries, contracts, data flow, plugin, security, and migration changes.
- `enforcement-decisions.md` (R/Q clauses) plus the relevant `modules/` module and `roadmap.md` for product behavior, commands, configuration, feature flags, acceptance criteria, current status, and roadmap changes.
- `CONVENTIONS.md` for newly established engineering rules, operational lessons, and recurring failure-prevention rules.
- `06-memory.md`, `contracts.md`, `05-transport-proxy.md`, and `enforcement-decisions.md` for governed-memory schema, learning decisions, Proxy protocol contracts, and phased acceptance whenever memory or learning behavior changes.
- The constitution summary in `00-overview.md` only when a human explicitly changes the mission, north star, or constitutional principles.

At every milestone or release, perform a complete documentation audit against the shipped code, migrations, tests, feature flags, and known limitations. Record incomplete behavior honestly; do not describe planned behavior as implemented.

After a production incident, security issue, data-loss risk, or architectural reversal, update the relevant English normative document in the same remediation change so future AI work inherits the lesson.

Update the `doc_2.0` product layer (`enforcement-decisions.md` + affected `modules/` doc + `roadmap.md`) when:

- A new product decision is made.
- A command behavior changes.
- A new configuration field is added.
- A new surface is introduced (web, desktop).
- A todo item is completed or reprioritized.
- User-facing requirements change.
- Acceptance criteria change.
- New workflows are added.
- Existing workflows are removed or redefined.

Update `usage.md` when:

- A command is added, removed, or renamed.
- Command arguments change.
- Default command behavior changes.

Update `USAGE.html` when:

- `usage.md` changes.
- A more visual user-facing command reference is needed.

Documentation review must appear in the task checklist or handoff summary even when no file change is required. Use `no normative documentation impact` only after checking the documents above.

## Current Status

- Foundation CLI implemented with no runtime third-party dependencies.
- Implemented commands: `ai`, `ai version|--version|-v`, `ai setup`, `ai help`, `ai add`, `ai provider list`, `ai provider edit`, `ai provider delete`, `ai session`, `ai session list`, `ai session clear`, `ai report`, `ai status`, `ai log`, `ai context`, actionable `ai doctor` with safe Runtime-home repair, `ai doctor --deep --tool claude|codex`, `ai use`, `ai last`, placeholder `ai web`.
- Implemented core stores: `providers.json`, `.ai-cache.json`, `usage.json`.
- Implemented real token usage recording for provider responses with usage data (from `ai doctor --deep`).
- Implemented provider level normalization, level swapping, model discovery with `/v1/models` fallback, lightweight health checks, status rendering, fallback resolution, and runner environment setup.
- Implemented operational logging and `ai log` for recent log inspection.
- Implemented project context generation.
- Implemented CLI command resolution fallback for known macOS app paths.
- Added Node tests for provider normalization, level swapping, model compatibility, usage parsing, provider add/edit, status aggregation, doctor diagnostics, deep usage recording, and provider fallback.
- Added `.gitignore`, Chinese `README.md`, interactive release script, GitLab CI release plan.
- Implemented Telegram Bot subsystem (see `modules/01-surfaces.md`).
- The current implementation is a CLI-first Gateway foundation for the broader AI Runtime. Web, desktop, API, governed learning, and organizational capability management are planned surfaces and layers, not separate products.

## Next Implementation Steps

1. Introduce stable Runtime execution context, request, event, policy, and capability contracts.
2. Preserve current Gateway behavior while routing CLI and Telegram through shared orchestration.
3. Implement governed memory and learning according to `06-memory.md` and `07-learning-governance.md` without moving policy into surfaces.
4. Harden Claude Code and Codex adapters, permissions, idempotency, and structured execution events.
5. Formalize plugin descriptors and lifecycle rules around the existing registries.
6. Add organization and project scope, federated identity, sensitive-data boundaries, and versioned policy administration.
7. Implement the enterprise control-plane API and Web governance surface for identity, policy, capability/plugin lifecycle, audit, FinOps, compliance, and recovery; keep desktop as another adapter.
