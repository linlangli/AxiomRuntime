# AI Runtime Portable Specification

> Audience: AI systems, architects, maintainers, and implementation teams.
> Language: English because this is an AI-facing context artifact.
> Snapshot date: 2026-07-15.
> Status: PORTABLE CONTEXT SNAPSHOT. Outside this repository, this document is a self-contained product and implementation context pack. Inside this repository, `AGENTS.md`, `AI_RUNTIME_ARCHITECTURE.md`, `CONVENTIONS.md`, `contracts.md`, `enforcement-decisions.md`, and the module documents remain authoritative.

## 0. How To Use This Document

This file consolidates the complete product specification into one portable artifact. It preserves product scope, architectural boundaries, canonical identifiers, safety invariants, required capabilities, enforcement decisions, delivery gates, SLOs, tests, compatibility guarantees, data evolution, and operational behavior. Detailed code listings and repeated UI copy are normalized into their governing behavior rather than duplicated.

When using this file with another AI:

1. Treat every `MUST`, `MUST NOT`, `SHOULD`, and `MAY` as normative.
2. Do not narrow the product to a gateway, assistant, memory service, or agent framework.
3. Do not invent a second authority for identity, policy, usage, memory truth, audit, or capability activation.
4. Keep canonical identifiers in English exactly as written.
5. Distinguish target architecture from the implementation state without allowing implementation gaps to narrow the target.
6. Preserve all features. If a feature is difficult, use the stated adapter, fallback, staged rollout, replay, or governance solution rather than deleting it.
7. For in-repository implementation, re-open the source documents before coding because this portable copy can become stale.

## 1. Product Constitution

### 1.1 Product identity

This repository builds an enterprise AI Runtime. The Runtime is the product. Providers, models, agents, memory, knowledge, skills, workflows, tools, execution engines, reasoning systems, learning systems, and storage engines are replaceable Runtime capabilities.

It is not merely:

- a provider gateway;
- a chatbot or assistant;
- a standalone memory product;
- an agent framework;
- a Telegram bot;
- a model router;
- or an enterprise control-panel shell.

The initial wedge may be a developer-facing gateway and governed automatic memory, but that does not change the long-term product identity.

### 1.2 North Star

Every interaction should make the Runtime more capable, reliable, explainable, and reusable for the organization without weakening safety, privacy, authority, reversibility, or user control.

### 1.3 Three hard invariants

1. **Stable contracts and replaceable capabilities.** Callers depend on provider-neutral L0 contracts and Ports, never provider SDK types or storage schemas.
2. **High cohesion and low coupling.** Each module owns one responsibility and one authority boundary. Surfaces and adapters contain no reusable domain policy.
3. **Governed accumulation.** Models may propose knowledge, skills, or capabilities. Deterministic policy, evidence, evaluation, and human authority decide activation, scope promotion, permission, rollback, and deletion.

### 1.4 Non-negotiable authority rules

- Orchestration owns canonical execution context, session lifecycle, trace creation, and working-memory checkpoints.
- Execution Kernel owns execution-time permission enforcement, retry ownership, idempotency, cancellation, side-effect classification, and structured execution events.
- Policy Engine owns deterministic policy semantics and immutable policy revisions.
- UsageObserver is the sole owner and writer of usage and cost records and metrics.
- Memory Ledger is the sole authority for Claim/Evidence and typed cross-execution memory truth.
- Learning & Governance owns LearningDecision, evaluation, promotion, rollback, and CapabilityGain, but cannot change factual confidence without evidence.
- Security owns credentials, capability handles, redaction enforcement, and isolation mechanisms.
- Storage owns bytes and indexes, not semantic policy, retention meaning, authority, or activation.
- Audit records authoritative actions. Observability is diagnostic and non-authoritative.
- External components may emit add-only candidates, evidence, or rebuildable projections. They may not own Runtime identity, permissions, scope promotion, active state, purge semantics, or audit truth.

## 2. Feasibility Assessment

### 2.1 Overall conclusion

The target architecture is technically feasible. Nearly every general-purpose engine is intentionally adopted behind a stable adapter: model providers, lexical and vector retrieval, temporal graphs, checkpoints, durable queues, sequence mining, policy evaluation, cryptography, object storage, and telemetry. The product-specific work is the Runtime contract system, authority model, governed learning loop, unified transport semantics, policy integration, evidence ledger, observability semantics, and operational control plane.

The full Phase 13 product is not a single-release project. It is feasible only as staged vertical releases with local reference adapters, feature flags, compatibility fixtures, explicit exit gates, and rollback. Attempting to implement all subsystems together would create an untestable distributed monolith.

### 2.2 Feasibility by capability

| Area | Feasibility | Main reason |
|---|---|---|
| Runtime contracts and orchestration | High | Conventional typed architecture; current repository already contains partial foundations |
| Unified Transport Proxy and Usage parity | High but sensitive | Existing proxy behavior can be preserved behind a facade; protocol replay is mandatory |
| Governed Memory and Profile Compiler | Medium-high | Mature extraction/retrieval components exist; authority, purge, and evidence semantics are product work |
| Automatic learning and causal attribution | Medium | Deterministic governance is feasible; proving causal contribution requires offline evaluation and bounded counterfactual sampling |
| Skill mining and self-healing | Medium | PrefixSpan, anti-unification, replay, and sandboxing are known techniques; safe activation is difficult |
| Enterprise Control Plane | Medium-high | Standard identity/policy/audit/FinOps capabilities, but broad operational scope and compliance burden |
| Multi-device/team replication | Medium | Signed event replication is feasible; key lifecycle, causal ordering, and purge are complex |
| Parametric promotion | Experimental | Compiled rules and local classifiers are feasible; model adaptation remains opt-in and reversible |
| Complete Phase 13 as one delivery | Low | Scope and cross-module validation are too large for a big-bang release |

### 2.3 Major strengths

- Clear product identity and authority ownership.
- One transport data plane per execution.
- ADD-only candidate/evidence flow prevents model-driven destructive writes.
- Working Memory is separated from cross-execution Memory truth.
- Profile, vector, graph, summary, and compressed memory are rebuildable projections.
- Mature engines are reused instead of reimplemented.
- Failure behavior, kill switches, replay, rollback, and observability are first-class.
- Releases are vertical user outcomes rather than lists of internal components.
- Explicit SLO, RTO, RPO, capacity, recovery, and test gates exist.

### 2.4 Primary delivery risks and required responses

| Risk | Consequence | Required response |
|---|---|---|
| Documentation and contract breadth | Phase 0 becomes endless | Freeze a minimal R0.1 contract subset, version later additions, and use contract fixtures |
| Protocol/provider drift | Corrupt streams, duplicate tools, wrong usage, unsafe memory capture | Compatibility profiles, sanitized fixture corpus, streaming state machines, canary replay, narrow Memory on unknown versions |
| Memory poisoning or authority laundering | False profile or unsafe behavior | Origin-bound authority, add-only candidates, category policy automata, independent evidence, explicit confirmation |
| Incorrect identity/scope mapping | Cross-user or cross-tenant leaks | Canonical `PrincipalRef`, `ScopeRef`, directory revisions, SQL-level authorization filters, fail-closed identity resolution |
| Duplicate retry or metering ownership | Duplicate side effects or cost | One retry owner, one UsageObserver, attempt-level idempotency, reconciliation events |
| Weak causal learning claims | Runtime optimizes noise | Separate retrieved/injected/referenced/decisionChanged/outcomeChanged and use fixed evaluation plus bounded counterfactual sampling |
| Unsafe Skill activation | Repeated harmful actions | Typed Skill IR, trace alignment, static risk analysis, replay/sandbox/shadow gates, execution-time permission checks |
| Enterprise scope overload | Control plane delays core Runtime | Deliver R0-R2 locally first; run enterprise track in parallel on the same contracts |
| Premature service extraction | Distributed monolith and latency | Keep orchestration, recall, governor, and policy semantics in-process; extract only natural product boundaries |
| Telemetry leakage or false authority | Privacy breach or incorrect decisions | Content-free observations, view-specific query schemas, tenant-bound cursors, audit, non-authoritative semantics |
| SLO overcommitment | Unreliable release claims | Measure per deployment profile, expose degraded states, and block release when exit gates fail |

#### 2.4.1 Required response playbooks for the six critical risks

The following playbooks are release requirements, not optional implementation advice.

1. **Oversized one-shot delivery scope.** The owner is Runtime architecture and release governance. Freeze only the `R0.1` public contract subset needed for one vertical `Surface -> Orchestration -> Agent -> Kernel -> Transport -> Provider -> Event` path, then add compatible contract versions by release. Every increment must be independently deployable, observable, reversible, and usable with advanced learning disabled. Exit requires contract fixtures, one demonstrated vertical path, declared deferred capabilities, and no claim that a later-phase target is already available. If a gate fails, hold the affected increment and continue operating the last accepted baseline.
2. **Provider, protocol, streaming, tool, and usage correctness.** The owners are Runtime Transport Proxy and UsageObserver. Maintain a versioned compatibility matrix and sanitized fixture corpus for every supported CLI/provider/protocol combination; test unknown events, fragmented SSE, tool-call assembly, retry identity, terminal detection, byte pass-through, and usage parity. Canary a new profile before production activation. Unknown or failed profiles narrow Memory to `shadow_capture` or `passthrough`, preserve verified compatibility/Usage behavior, and never guess protocol semantics. Exit requires one listener/upstream per execution, declared-transform AST equality, exactly-once attempt metering, and zero raw sensitive persistence.
3. **Identity, Scope, and Evidence quality.** The owners are Orchestration, Identity Directory, Memory Ledger, and Policy. Resolve every external subject to a canonical `PrincipalRef`, pin directory and policy revisions, apply tenant/scope/audience/purpose filters in storage queries and again in core, and reject unresolved identity. Extractors emit add-only candidates; active Claims require origin-bound authority, category policy, independent evidence where required, conflict/temporal checks, and explicit confirmation for sensitive inference. Exit requires cross-tenant and cross-scope leak tests at zero, deterministic authority fixtures, correction lineage, and purge reachability through every projection. Failure is fail-closed for identity and activation while explicit local controls remain available.
4. **Causal attribution versus retrieval correlation.** The owners are Learning Governor and Evaluation Harness. Record `retrieved`, `injected`, `referenced`, `decision_changed`, and `outcome_changed` as distinct evidence; retrieval frequency never raises factual confidence. Promotion and ranking changes require a fixed baseline, verified outcome metric, minimum sample size, uncertainty bounds, and bounded counterfactual or shadow evaluation for high-impact artifacts. Exit requires deterministic replay, no hard safety regression, and measured CapabilityGain rather than model self-rating. Insufficient evidence produces `no_artifact` or retains the candidate without promotion.
5. **Safe Skill mining and activation.** The owners are ProcedureMiner, Skill lifecycle, Kernel, Policy, and human approvers. Mine only verified successful episodes with mature sequence-mining implementations; require cross-execution support, anti-unification, complete trace alignment, typed Skill IR, static risk analysis, replay, sandbox, shadow, environment fingerprinting, and risk-based confirmation. Runtime permissions are re-evaluated for every step even when the Skill is active. Exit requires `stepCoverage=1.0`, no unsupported step, verified postconditions, zero secret-derived features, and all risk gates for the declared side effects. Failure retains a candidate, marks `needs_revalidation`, deprecates repeated failures, or falls back to direct governed execution.
6. **Enterprise Control Plane scope and operational burden.** The owner is the Enterprise Control Plane track, using the same core contracts and ledgers as local Runtime releases. Deliver CP0-CP3 independently: resource/admin foundations; federated identity and policy; capability/operations; compliance and resilience. Web, CLI, and API remain peer Surfaces over identical mutations. Exit requires parity of Policy/Audit results across Surfaces, delegated-admin isolation, canary/rollback, quota and FinOps reconciliation, legal-hold/residency fail-closed behavior, and restore drills meeting RTO/RPO. An unfinished enterprise feature cannot block local R0-R2, but it also cannot be represented as enterprise-ready.

### 2.5 Residual specification gaps before coding every feature

- Cross-process JSON Schemas and compatibility matrices must be generated for each frozen TypeScript contract.
- The complete action-specific `CapabilityObservation` payload schemas need implementation artifacts, not only tables.
- Language/domain-specific business event schemas belong in integration specifications, not free-form Runtime events.
- Enterprise data classification, region catalog, legal-hold authority, and retention defaults require deployment policy.
- Benchmark datasets and hard numeric quality thresholds must be fixed before learned ranking or Skill promotion.
- The Web control plane needs screen-level contracts, but must remain a Surface over core APIs.
- Each adopted dependency needs an ADR, license/CVE review, SBOM entry, replacement fixture, and data-egress decision.

These are implementation tasks, not architectural blockers.

## 3. System Architecture

### 3.1 Layer model

```text
Business users and platform operators
                  |
        Surfaces / Runtime API
                  |
             Orchestration
                  |
       Capabilities + Registry
                  |
          Execution Kernel
                  |
   Single Runtime Transport Proxy
        |                    |
 UsageObserver         MemoryExtension

Cross-cutting: Policy, Security, Audit, Capability Observability

Execution evidence -> Learning Governor -> candidates -> evaluation
                   -> Policy/human activation -> governed reuse

Stable Ports -> replaceable adapters -> mature engines/infrastructure

Authoritative ledgers and rebuildable projections -> Storage mechanisms
```

### 3.2 End-to-end request lifecycle

1. A Surface converts user or system intent into `RuntimeRequest`.
2. Orchestration resolves canonical identity, tenant, membership, `ScopeRef`, project, session, trace, directory revision, and `OrganizationPolicySnapshot`.
3. Pre-run hooks request bounded Memory recall and compile a read-only context patch.
4. Capability Registry resolves an approved, healthy, versioned capability implementation.
5. Execution Kernel evaluates permission, side effects, confirmation, deadline, budget, idempotency, retry owner, and cancellation.
6. One Runtime Transport Proxy creates one listener, route lease, upstream route, and transform sequence.
7. TransformCoordinator applies the approved Memory patch to canonical AST, then applies declared compatibility transforms.
8. UsageObserver observes the stream and is the sole usage/cost writer. MemoryExtension receives sanitized bounded evidence and owns no transport or usage state.
9. Runtime emits append-only lifecycle events with exactly one terminal state per operation.
10. The response returns without waiting for Post-Run learning.
11. A durable Post-Run job extracts add-only candidates and evidence.
12. Learning Governor chooses `no_artifact`, extract, verify, ask, consolidate, evaluate, promote, or rollback.
13. Policy and, where required, a human authorize activation or scope promotion.
14. Recall and evaluation measure whether the activated artifact creates real CapabilityGain.

### 3.3 Dependency direction

- `core/contracts` has zero runtime dependencies.
- Surfaces depend on L0 contracts and the Orchestration facade only.
- Orchestration, Capabilities, Kernel, Memory, Learning, Policy, and Security depend on L0 contracts, not sibling implementations.
- Adapters implement Ports and translate vendor types at the boundary.
- Storage backends implement mechanisms without redefining domain semantics.
- No delivery surface, plugin, model, or external agent may bypass core policy and authority boundaries.

### 3.4 External coding Agent placement

Claude Code and Codex CLI each occupy three related but distinct architectural roles:

- the product-facing role is a versioned `agent` capability resolved by Capability Registry;
- the governed runtime role is an Agent run supervised by Execution Kernel for permission, budget, event resume, retry ownership, cancellation, and tool reauthorization;
- the vendor/process integration role is a replaceable `AgentAdapterPort` implementation that launches and normalizes the concrete CLI.

Telegram occupies only the Surface role. It turns a remote message into `RuntimeRequest`, renders normalized events, and returns bound confirmation decisions. Its local engine wrapper is a compatibility facade and does not own Agent selection, provider routing, permission, Memory, learning, Usage, or execution truth.

```text
Telegram Surface
  -> Orchestration
  -> claude-code-agent | codex-cli-agent Capability
  -> Execution Kernel
  -> ClaudeCodeCliAgentAdapter | CodexCliAgentAdapter
  -> single Runtime Transport Proxy
  -> selected ModelProvider adapter
```

Native CLI tools remain Tool capabilities from the Runtime's perspective. A native tool request is normalized to an Agent proposal and re-authorized by Kernel. When a CLI cannot expose an enforceable interception boundary, its descriptor declares the limitation and Policy restricts the run through supported native permission mode, process/container isolation, filesystem/network bounds, and explicit confirmation; the adapter may not claim stronger enforcement than it can prove.

## 4. Canonical Runtime Contracts

### 4.1 Identity and scope

```typescript
type PrincipalKind = "user" | "service" | "agent" | "team" | "organization";

type PrincipalRef = {
  tenantId: string;
  kind: PrincipalKind;
  id: string;
};

type ScopeKind = "user" | "bot" | "agent" | "project" | "team" | "organization";

type ScopeRef = {
  tenantId: string;
  kind: ScopeKind;
  id: string;
  owner: PrincipalRef;
  audience: "private" | "delegated" | "shared";
  purposes: string[];
};
```

External issuer subjects, group ids, provider ids, and storage aliases may not become authoritative Runtime foreign keys. Every execution pins a directory revision and policy snapshot. Mid-execution directory changes may narrow authority but may not silently widen it.

### 4.2 Policy

```typescript
type PolicyEffect = "allow" | "deny" | "require_confirmation" | "constrain";

type PolicyDecision = {
  schemaVersion: 1;
  decisionId: string;
  effect: PolicyEffect;
  policyVersion: string;
  matchedRuleIds: string[];
  constraints: Record<string, unknown>;
  expiresAt?: number;
};
```

`OrganizationPolicySnapshot` is an immutable effective view containing tenant, organization, environment, revision, policy bundle version, validity, residency, retention, quota, allowed/denied capabilities, rule hash, approvers, and issue time. Publish and rollback always create new revisions.

### 4.3 Runtime events and errors

`RuntimeEvent` is versioned, append-only, idempotent, scoped, traced, and schema-validated. Required fields include `eventId`, `eventType`, `eventVersion`, `operationId`, optional `executionId`, `correlationId`, optional `causationEventId`, monotonic `sequence`, `idempotencyKey`, `occurredAt`, producer, actor, scope, trace, and typed payload.

The closed event families are:

- execution accepted/started/completed/failed/cancelled;
- capability resolved/invocation started/completed/failed;
- workflow started/checkpointed/waiting/compensating/completed/failed;
- tool started/completed/failed/cancelled;
- agent started/event/completed/failed/cancelled;
- transport request started/response started/completed/failed;
- usage recorded/reconciled;
- memory candidate created/claim activated/claim superseded/purged;
- learning decision/evaluation/promotion/rollback recorded;
- policy decision recorded;
- security confirmation requested/capability issued/revoked;
- admin mutation requested/completed/failed;
- audit export requested/completed/failed.

Each execution, capability invocation, tool invocation, agent run, and transport attempt has at most one start and exactly one terminal event. Workflow may have many checkpoints and waits but one terminal. Replay deduplicates stable event/idempotency ids. Reconciliation appends correction events and never rewrites history.

`RuntimeErrorCode` is closed and includes request/schema, identity/scope/tenant, policy/confirmation, capability, quota/rate/deadline/cancel, revision/idempotency/dependency, provider/protocol/transport, tool/workflow/compensation/agent, storage/integrity/legal-hold/residency, secret/redaction/audit, and internal errors. Retry classification is `never`, `same_attempt`, `new_attempt`, `after_confirmation`, or `after_operator_action`. `safeDetails` is allowlisted per error code and never contains raw prompts, provider bodies, stacks, secrets, authorization, or tool content.

### 4.4 Tool, Workflow, and Agent

- `SideEffectClass`: `none | read | reversible_write | external_write | irreversible`.
- Every invocation has execution id, invocation id, idempotency key, deadline, policy decision id, optional capability handle, and trace.
- Tool descriptors have versioned input/output schemas, permissions, side-effect class, cancellation support, and optional compensation tool.
- Same idempotency key with a different input hash returns `idempotency_conflict`.
- `unknown` side-effect state requires reconciliation/manual recovery and may not be retried automatically.
- Workflow definitions are versioned state machines with schema-checked signals, declarative JSON Pointer input mapping, per-step retry policy, checkpointing, waiting, compensation, and maximum duration.
- Workflow checkpoint, step state, and outbox event share an atomic boundary.
- Agent event streams are monotonic, resumable, and deduplicated. Agent tool requests are proposals and are re-authorized by Kernel.
- Agent adapters cannot switch providers, expand scope, issue capabilities, bypass confirmation, or persist reasoning.

### 4.5 Memory public facade

```typescript
interface MemoryService {
  preRead(input: MemoryPreReadInput): Promise<MemoryPreReadResult>;
  search(input: BoundedMemorySearchInput): Promise<MemorySearchResult>;
  enqueuePostRun(input: MemoryPostRunInput): Promise<MemoryPostRunReceipt>;
  list(query: MemoryListQuery): Promise<MemoryPage>;
  pin(input: ExplicitMemoryInput): Promise<MemoryEntry>;
  correct(input: MemoryCorrectionInput): Promise<MemoryEntry>;
  forget(input: MemoryForgetInput): Promise<void>;
  purge(input: MemoryPurgeInput): Promise<PurgeReport>;
  export(input: MemoryExportInput): Promise<string>;
}
```

`search` is bounded, read-only, and subject to the same identity, scope, privacy, authority, temporal, and token filters as `preRead`. Default per-turn bounds are one search, eight results, and 1,200 tokens. Callers cannot select another user, deleted content, secrets, raw Evidence, or auth storage.

### 4.6 Learning contracts

- `LearningObjective`: versioned objective, scope, metrics, hard regressions, minimum evidence.
- `LearningSignal`: normalized outcome, correction, reuse, failure, cost, and latency.
- `LearningDecision`: deterministic selected action and reason.
- `LearningCandidate`: proposed knowledge, skill, workflow, or capability plus evidence.
- `EvaluationResult`: versioned deterministic and model-assisted evidence.
- `UncertaintyAssessment`: factual, retrieval, conflict, temporal, applicability, policy, and objective uncertainty plus next action.
- `CapabilityGain`: baseline versus candidate with sample size and hard regressions.
- `CompressionManifest`: complete reversible mapping from authoritative sources to compiled projection.

### 4.7 Replaceable Ports

Required stable Ports include `ModelProviderPort`, `ToolPort`, `WorkflowExecutorPort`, `AgentAdapterPort`, `CandidateExtractor`, `RetrievalBackend`, `VectorRetrievalBackend`, `TemporalGraphProjection`, `WorkflowCheckpointBackend`, `DurableJobBackend`, `ProtectedPayloadCodec`, `ObjectStore`, `SecretStore`, `AuditSink`, `ObservabilitySinkPort`, `ObservabilityQueryPort`, `IdentityDirectoryPort`, `AuditQueryPort`, `MeteringExportPort`, `ProcedureMiner`, `PolicyEngine`, and `EvaluationHarness`.

Local reference implementations must keep the product usable without managed services. Enterprise implementations may replace mechanisms but not contracts or authority semantics.

## 5. Module Specifications

### 5.1 Surfaces

Surfaces translate user/system intent into stable Runtime requests and render results. CLI, Telegram, Web, Desktop, API, and Scheduler are peer adapters. They own edge protocol parsing, UI state, presentation, and edge rate limits. They do not own provider selection, memory policy, Skill promotion, tool authorization, or durable truth.

All Surfaces call one Orchestration facade. Disabling one Surface leaves all other Surfaces and core behavior unchanged. Telegram progress, permission confirmation, session selection, and command handling are presentation of core decisions, not independent policy.

### 5.2 Orchestration

Orchestration owns context construction, canonical tenant/scope resolution, sessions, lifecycle hooks, append-only event emission, trace creation, and thread-scoped Working Memory checkpoints. It does not execute tools, choose providers, extract memory, or make learning decisions.

Identity failure is fail-closed. A non-critical hook may fail open with an event. Checkpoint failure may reduce an execution to one turn but may not corrupt cross-execution Memory truth.

### 5.3 Capabilities and Registry

Capabilities expose versioned descriptors with id, semantic version, permissions, config schema, health, dependencies, lifecycle, adapter identity, and compatibility. Kinds include provider/model, memory, knowledge, skill, workflow, tool, agent, retrieval, learning, policy, and reporting/integration capabilities.

Registry resolution is policy-controlled and pins the selected version and adapter for an in-flight invocation. Lifecycle is:

```text
discovered -> validated -> approved -> active -> draining -> disabled -> removed
                         -> failed                 -> failed
```

Discovery parses manifests without executing plugin code. Upgrade uses version coexistence and drain. Rollback restores the prior validated descriptor/config adapter and never rolls back authoritative Runtime data.

### 5.4 Execution Kernel

Kernel owns governed execution plans, execution-time permission checks, retry ownership, idempotency, cancellation, isolation, side-effect classification, tool orchestration, workflow supervision, agent supervision, and structured events. It consumes Policy decisions but never defines policy. Memory and Skill are advisory and cannot grant permission.

Policy failure is fail-closed for governed actions. High-impact or irreversible actions require explicit confirmation. Compensation is a new invocation with its own policy, idempotency, deadline, events, and possible failure.

### 5.5 Runtime Transport Proxy

Each execution has one listener, one route lease, one upstream route, one base URL override, and one ordered TransformCoordinator. The proxy owns transport decode, verified upstream connection, header policy, canonical protocol AST, compatibility transforms, streaming, backpressure, and isolated extension dispatch.

`UsageObserver` is read-only with respect to transport payloads and is the only writer of usage/cost/metrics. `MemoryExtension` may observe bounded sanitized events and request an allowlisted instruction patch. It cannot own a listener, forward a request, translate provider protocols, or write usage.

Transport modes are `stopped | usage_only | extensions`. Memory modes are independently `disabled | passthrough | shadow_capture | read_only | full`. Unknown protocol, unhealthy Memory, or failed replay narrows Memory without disabling verified Usage or transport compatibility. The existing `startOpenAiUsageProxy()` remains a compatibility facade, not a second server.

### 5.6 Memory

Memory is the governed learning and knowledge foundation. It owns `memory_units`, Claim/Evidence truth, typed Knowledge/Skill/Experience semantics, recall, Context Compiler, and user controls.

Memory dimensions include:

- lifetime: conversation/working context, short-term, long-term, episodic retention;
- category: semantic fact, preference, profile, constraint, goal, episode, failure/negative memory, procedure/Skill, prospective memory, relationship, project context, artifact observation;
- scope: user, bot, agent, project, team, organization with audience and purposes;
- temporal validity, confidence, authority, privacy, provenance, utility, status, and derivation.

Stable facts are split into mutable Claim heads and immutable add-only Evidence. Corrections add supporting/refuting evidence or superseding claims; they never silently overwrite history. Factual confidence is derived from evidence, not retrieval count, model confidence, or utility.

The recall pipeline is:

```text
plan -> required cache -> lexical/vector/graph/temporal/episode routes
     -> authorization and authority filtering
     -> conflict and temporal filtering
     -> fusion/rerank -> category/token budget
     -> Context Compiler -> read-only injection manifest
```

Vector and graph backends must apply Runtime authorization filters during retrieval, followed by a local defense-in-depth check. Failure of one optional route degrades only that route. Explicit user controls and authoritative storage remain available.

Pre-Read has a bounded latency budget. Post-Run is a durable job, not an in-process promise. Periodic distillation consolidates projections under bounded batches and cursors.

`MemoryCandidate` proposals are `create | reinforce | supersede | archive | ignore` and include scope, lifetime, category, content, tags, temporal data, explicitness, evidence references, reason, and sensitivity. Extractors only emit candidates/evidence. A deterministic materializer rechecks scope, evidence, policy, conflict, and temporal validity before changing active state.

Profile is not a writable truth blob. Profile Compiler produces versioned audience/purpose-specific snapshots from active Claim, Evidence, Preference, Constraint, Goal, and Privacy Policy. Every snapshot stores source claim ids, compiler version, content hash, and validity. Source changes invalidate and rebuild it.

Compression replaces projections, never Claim/Evidence provenance. Every compression requires source coverage 1.0, version, QA result, and rollback artifact. Forgetting cools, invalidates, or archives projections first; physical purge follows retention, legal hold, and explicit authority through the full derivation graph.

### 5.7 Learning and Governance

Learning converts authoritative execution evidence into governed reusable artifacts. The deterministic Governor evaluates objective, policy, privacy, uncertainty, novelty, reuse value, evidence, risk, budget, and existing artifacts. `no_artifact` is a valid and preferred decision when durable value is not demonstrated.

The loop is:

```text
RuntimeEvent -> LearningSignal -> LearningDecision
             -> candidate or no_artifact
             -> evaluation -> Policy/human decision
             -> active/retained/rollback -> CapabilityGain
```

Attribution distinguishes retrieved, injected, referenced, decision changed, and outcome changed. Facts use evidence confidence; ranking uses utility. A retrieved item is not automatically useful or causal.

Automatic consolidation, low-risk activation, compression, and evaluation may run after release gates pass. Scope promotion, high-risk Skills, permissions, security policy, and irreversible actions remain policy/human governed.

### 5.8 Policy

Policy Engine is a deterministic, side-effect-free typed evaluator. It does not call models, networks, or storage. It returns `allow`, `deny`, `require_confirmation`, or `constrain`. Category-specific activation automata define accepted evidence, minimum independent evidence, minimum authority, required verifiers, automatic activation eligibility, expiry, and conflict policy.

Policy outage fails closed for privileged execution, activation, scope promotion, plugin changes, and legal-hold changes. Drafts are schema/semantically validated, approved, published as immutable revisions, canaried, inspected, and rolled back by creating a new revision.

### 5.9 Security

Security owns credential/session handling, recursive redaction, tenant/process isolation, and execution-time capability enforcement. Credentials and browser session state are capabilities, never prompt memory. Secret values live in SecretStore/KMS/HSM and are referenced by opaque handles.

Capability handles are short-lived, scoped, purpose-bound, permission-bound, caveated, auditable, revocable, and invalid across inappropriate execution boundaries. Browser or tool data exits through DLP/redaction policy. OIDC/SAML, SCIM, delegated administration, and break-glass access are issuer/audience/nonce/session validated, time-bound, reason-bound, alerted, and audited.

Random loopback ports are not tenant isolation. Mutually untrusted enterprise tenants require OS-user, container, process, network, key, and storage isolation appropriate to the deployment profile.

### 5.10 Adapters and Plugins

Adapters translate stable Runtime Ports to provider/model/agent/tool/MCP/workflow, extraction, retrieval, vector, graph, policy, storage, identity, cryptography, queue, evaluation, and telemetry implementations.

Adapters own no Runtime authority. Vendor ids, SDK errors, schemas, database tables, and hosted API responses are mapped at the boundary and cannot leak into public contracts or authoritative foreign keys.

Build only product-defining contracts and semantics. Adopt or adapt mature extraction, BM25/hybrid retrieval, embeddings, vector indexes, entity linking, reranking, temporal graphs, workflow checkpoints, durable queues, sequence mining, policy evaluation, cryptography, DLP, object storage, benchmarks, and telemetry. Do not reimplement a general-purpose engine without an ADR proving a material safety or contract gap.

Every dependency needs fixed version, ADR, license/CVE review, SBOM, data-egress policy, health model, fallback, upgrade/rollback plan, and replacement contract fixture.

Commands, engines, Telegram handlers, integration status providers, capability kinds, and plugin packages use registries rather than central switch statements or closed implementation unions. A registration descriptor supplies canonical id, version, schemas, permissions, lifecycle, health, and factory/handler references. Discovery is side-effect-free; activation remains Registry plus Policy work. Removing a plugin must not require editing unrelated Surface code.

### 5.11 Storage

Storage supplies SQL/transaction, lexical/vector/graph indexes, object storage, secret storage, audit persistence, durable jobs, checkpoints, exports, and Observation projections. It owns bytes and indexes, not semantic truth.

Authoritative ledgers are append-only or revisioned and require integrity checks, backups, versioned schema evolution, upgrade verification, rollback evidence, and purge evidence. Rebuildable projections may be sampled, expired, invalidated, or rebuilt. Storage failure cannot silently widen scope, lose an acknowledged durable audit/usage record, or redefine legal hold and retention.

## 6. Memory Intelligence and Skill System

### 6.1 Origin-bound authority

Authority order is:

```text
external < assistant/model_inferred < tool_verified < user_stated < user_confirmed < system_policy
```

Derived artifacts inherit the lowest relevant source cap. Summarization, repetition, embeddings, distillation, profiles, graphs, Skill mining, and repeated parsing cannot launder authority. Only user confirmation bound to a specific Claim hash or an independently verifiable allowlisted tool outcome may add stronger Evidence.

### 6.2 Temporal and conflict semantics

Claims support valid time and transaction time. Fuzzy or relative time preserves the original expression, timezone, anchor, precision, and candidate range. New evidence produces new versions rather than silent overwrite.

Conflict detection groups claims by fact key and cardinality. Resolvers consider authority, independent evidence, temporal overlap, recency where appropriate, explicit correction, and policy. Unresolved single-cardinality conflicts are injected as explicit conflict context or omitted; contradictory values are never all presented as ordinary facts.

### 6.3 Skill mining

`ProcedureMiner` consumes successful episodes with verifiable outcomes. It groups by `intent_key`, applies a mature PrefixSpan implementation, and requires default support of at least three independent executions. It excludes secrets, capability handles, and protected arguments.

Anti-unification turns variable aligned values across at least two episodes into typed slots. Constant values remain constants. Models cannot invent slots or steps not supported by trace alignment.

Skill IR contains typed steps, preconditions, invariants, expected outcomes, postconditions, risk, environment fingerprint, confirmation requirements, rollback/checkpoint semantics, and allowed capabilities. It is advisory until validated and never grants permission.

Validation levels include schema, trace alignment, static risk, replay, sandbox, shadow invocation, and environment compatibility. Trace alignment requires full step coverage, supported steps, correct order, exact tool/constants, and valid slots. Risk determines the required gate; confidence cannot bypass it.

If an active Skill degrades or the environment changes, it enters `needs_revalidation`. New successful episodes produce an add-only replacement version. Default two consecutive remine failures deprecate it. An old active version is not blindly restored when a critical environment fingerprint fails.

Positive Skill reuse requires adequate adherence, passed postconditions, successful task outcome, no hard regression, no correction, and explicit contribution evidence. Retrieval or application alone is not success.

### 6.4 Active learning and intelligent forgetting

The Runtime may ask a user only when expected uncertainty reduction and objective impact exceed interruption cost. Repeated questions have daily budgets and cooldowns. Security ambiguity never permits model guessing.

Utility tracks retrieval, answer, action, harm, token, and correction dimensions separately. Bounded counterfactual evaluation is asynchronous, reproducible, cached, budgeted, and focused on high-impact samples.

Intelligent forgetting first reduces retrieval priority or invalidates rebuildable projections. It does not destroy pinned content, provenance, audit, legal hold, purge reachability, or authoritative evidence without explicit policy and authority.

Default intelligent feature states are:

```text
memory.autoWrite             false until Phase 2 exit gates pass
memory.autoActivateLowRisk  false until category policy is calibrated
memory.autoConsolidate      false until compression replay passes
memory.activeLearning       false until question budget and UX pass
memory.causalAttribution    shadow
memory.scopePromotion       proposal_only
memory.parametricPromotion  experimental
```

Disabling any advanced feature returns to the stable Claim/Evidence plus required/FTS baseline without breaking execution or explicit pin, correct, forget, purge, import, and export controls. A feature flag controls activation; it does not convert unfinished implementation into a delivered feature.

## 7. Capability Observability

### 7.1 Canonical model

`CapabilityObservation` is a provider-neutral, content-free, non-authoritative diagnostic envelope. Orchestration creates the trace. Capability, Kernel, Memory, Skill, Learning, Policy, and Security derive spans and emit each semantic observation once through `ObservabilitySinkPort`.

Generic call tree:

```text
capability.resolve -> capability.invoke -> capability.result
```

Memory call tree:

```text
memory.plan
-> memory.retrieve.route*
-> memory.filter -> memory.rank -> memory.budget
-> memory.compile -> memory.inject
-> asynchronous extract/candidate/conflict/write/feedback/compress
```

Skill call tree:

```text
skill.match -> skill.select -> skill.apply -> skill.step* -> skill.outcome
-> asynchronous distill/validate/lifecycle/evaluation
```

Post-Run, distillation, validation, and evaluation keep the source `traceId` but use explicit `ObservationLink` relations rather than extending synchronous request duration.

### 7.2 Safety and authority

Observations may contain authorized canonical ids, hashes, lengths, counts, bounded rounded scores, versions, status, duration, and reason codes. They must never contain prompts, Memory/Skill content, Skill step text, trigger keywords, reasoning, secrets, raw Evidence, or tool inputs/outputs.

Observations cannot drive Claim/Skill state, Policy, billing, activation, promotion, or factual decisions. `RuntimeEvent`, Audit, Usage Ledger, Claim/Evidence, PolicyDecision, Skill lifecycle, and EvaluationResult remain authoritative.

### 7.3 Sink, projection, query, and sampling

- `tryEmit()` is bounded and non-blocking; local p95 <= 2 ms and p99 <= 5 ms.
- Normal and critical queues use bounded capacity; critical events have reserved capacity and a permission-restricted bounded spool.
- Exporter recovery replays by `observationId` idempotently. Exhaustion drops observations, increments low-cardinality counters, alerts, and never blocks Runtime.
- JSONL, OpenTelemetry, OTLP/APM, metrics, and dashboards are projections of the same emission.
- High-impact, error, degraded, policy deny, Ledger write, activation, lifecycle, promotion, rollback, and explicit debug traces are never intentionally sampled. Infrastructure loss remains possible and is reported.
- Trace, execution, user, project, memory, Skill, and invocation ids are forbidden metric labels.

`ObservabilityQueryPort` returns closed view-specific records for `summary`, `explain`, or `internal`. Cursors are signed, expiring, and bound to tenant, scope, view, filters, cutoff, and watermark. `internal` does not imply cross-tenant access. Break-glass investigation remains one tenant per query and is separately authorized and audited.

Completeness is:

- `complete`: closed trace, inside retention, projection caught up, no known sampling/drop/gap;
- `sampled`: omissions are only intentional sampling;
- `partial`: open trace, sink drop, export lag, retention boundary, missing parent, or corrupt projection.

Cost and latency views join latency observations with the UsageObserver-owned read model through operation/execution/invocation and authoritative attempt events. They never copy or estimate usage/cost into the Observation store.

## 8. Enterprise Control Plane

The Enterprise Control Plane governs organizations, tenants, environments, identity federation, membership, roles, delegated administration, policy revisions, plugin lifecycle, quotas, FinOps, residency, retention, legal hold, audit, backup, recovery, and disaster recovery. It does not carry model traffic or own execution semantics.

Required domains:

- Organization and Identity: OIDC/SAML, SCIM, canonical mapping, role bindings, delegated admin, break-glass.
- Policy and Approvals: draft, diff, validate, approve, effective inspection, canary, publish, rollback, confirmation queue.
- Capabilities and Plugins: discovery, risk/permission manifest, compatibility, approval, activation, drain, disable, replacement, removal.
- Memory and Learning Governance: Claim/Evidence inspection/correction, pin/forget/purge, candidates, evaluations, Skill promotion/rollback, CapabilityGain, Shadow comparison.
- Execution and Audit: traces, failures, permissions, audit queries, signed exports, lifecycle operations and completion evidence.
- FinOps and Reliability: provider health, usage/cost/latency, attribution, quotas, budgets, SLO, alerts, backup/restore, DR exercises.
- Provider and Agent Operations: provider/model configuration and health; agent status, binding, task transfer, cleanup, and errors; secret values are never displayed.

All Web, CLI, and API mutations call the same core contract. Each mutation includes requester, scope, policy snapshot, idempotency key, reason, expected revision, approval evidence, and trace. Long work returns a durable operation instead of blocking the request.

Audit and metering exports use opaque tenant-bound cursors, recipient-bound encrypted artifacts, hashes, integrity checkpoints, idempotent retry, cancellation, expiration, and cleanup. Metering export reads only the UsageObserver ledger.

## 9. Enforcement Decisions

### 9.1 Quality decisions Q1-Q6

- **Q1 Retrieval sources:** enable required/local lexical sources first; add vector, graph, temporal, and episode routes independently with contribution metrics and kill switches.
- **Q2 Learned ranking:** collect features and outcomes before learning; deploy only after offline and shadow improvement with no safety regression.
- **Q3 Embedding versioning:** key embeddings by model/version/dimension; re-embed progressively; never mix incompatible vectors silently.
- **Q4 Cold start:** prioritize explicit import, pin, correction, and confirmed seeds before relying on passive extraction.
- **Q5 Falsifiable improvement:** CapabilityGain requires reduced correction and improved task success without retrieval, safety, latency, or cost regression. Artifact/retrieval counts are not success.
- **Q6 Memory/transport decoupling:** Memory can be fully disabled while execution, Usage, compatibility, and explicit user controls remain stable.

### 9.2 Risk decisions R1-R36

- **R1 Identity binding:** resolve cross-source identities before Memory; support auditable merge/unlink and prevent shared-device contamination.
- **R2 Extraction cost/latency:** Post-Run extraction is durable, batched, budgeted, and asynchronous; local rules precede optional cheap models.
- **R3 Poisoning defense:** external/untrusted content never becomes active automatically; preserve provenance and taint through derivation.
- **R4 Confidence policy:** confidence is derived through category-specific Policy Automata, evidence, authority, and verifiers; models do not set final state.
- **R5 Schema and data evolution:** upgrades are versioned, resumable, idempotent, backed up, reversible where possible, and verified before destructive cleanup.
- **R6 Injection budget:** enforce hard total/category/token caps, deterministic trimming, and safe fallback.
- **R7 Group safety:** group/non-private contexts use hard scope guards and do not expose private Memory.
- **R8 Cross-platform secrets:** use OS SecretStore locally and KMS/HSM/Vault in enterprise; never store plaintext credentials in Memory/config.
- **R9 Concurrent central writes:** use transactions, WAL/appropriate DB concurrency, idempotency, leases, and bounded retries; avoid multi-process file corruption.
- **R10 Forget/export:** list, pin, correct, forget, purge, import, and export are first-class audited user operations with completion evidence.
- **R11 Retrieval evaluation:** establish golden datasets before retrieval changes; include public long-memory benchmarks plus project scope/authority/purge/Skill cases.
- **R12 Bitemporal facts:** model valid time and transaction time, including uncertainty and timezone.
- **R13 Conflict resolution:** detect fact-key conflicts, preserve supporting/refuting evidence, resolve deterministically or expose explicit conflict.
- **R14 Knowledge graph:** temporal graph is a rebuildable projection over authoritative entities/claims/events/episodes/actions/outcomes/artifacts.
- **R15 Utility feedback:** separate retrieval from reference and causal contribution; utility does not alter factual confidence.
- **R16 Three memory layers:** preserve episodic, semantic, and procedural memory; episodes are captured early and distilled later.
- **R17 Observability:** trace Memory/Skill/Capability calls through one non-authoritative, content-free emission and policy-controlled query plane.
- **R18 Telegram progress:** show safe memory/Skill progress through existing ProgressReporter without leaking content or delaying response.
- **R19 Authority laundering:** every derivation carries origin authority/taint; only bound confirmation or independent trusted tool evidence can raise authority.
- **R20 Planned/iterative retrieval:** use Query Planner and bounded on-demand search rather than one unstructured vector query.
- **R21 Rich profiles/memory:** Profile Compiler supports prospective, constraint, negative, project, privacy, and relationship slices as projections.
- **R22 Skill validation:** validate Skill IR with schema, alignment, risk, replay, sandbox, shadow, postconditions, and environment fingerprint.
- **R23 Capability security:** capabilities are execution-bound handles with caveats and expiry, never ordinary Memory or prompt-granted authority.
- **R24 Shadow/integrity/reversible compile:** replay and shadow all risky evolution; protect events with hash chains/checkpoints; keep compiled promotion reversible.
- **R25 Derivation and confirmation:** maintain a derivation DAG and bind user confirmation to exact structured Claim/action hashes.
- **R26 Protocol state machine:** parse protocol exchanges with versioned streaming/tool state machines and replay fixtures; unknown relations fail safe.
- **R27 Layered latency:** enforce separate L0/L1/L2 budgets and degrade routes independently.
- **R28 Fuzzy time/graph rebuild:** preserve temporal expressions and rebuild graph indexes from authoritative sources.
- **R29 Skill DSL/risk ceiling:** use a restricted typed DSL; risk class determines maximum automation and required validation.
- **R30 Utility/counterfactual budget:** retain multidimensional utility and run fixed, cached, reproducible counterfactual checks asynchronously within budget.
- **R31 Replication/team keys/artifacts:** replicate signed events, not databases; use causal ordering, team key rotation, tombstones, crypto erasure, and derivation-aware artifact deletion.
- **R32 Parametric promotion/simulation:** promote progressively from rules to classifiers/context adapters; model adaptation is experimental; require long-horizon simulation and rollback artifacts.
- **R33 Intelligent learning control:** version objectives, use deterministic decisions, capture outcomes, distinguish attribution states, govern active questions, compression, and scope promotion.
- **R34 Unified transport governance:** one proxy; isolated Usage/Memory workers; one mutator; sanitized envelopes; compatibility profiles; bounded resources; independent modes and rollbacks; parity and doctor gates.
- **R35 Mature reuse/supply chain:** own semantics, adopt engines, isolate vendor ids, enforce authorized retrieval, review dependencies, restrict egress, and prove replacement parity.
- **R36 Skill mining/self-healing:** mine verified success with PrefixSpan, parameterize by anti-unification, require exact alignment, revalidate on drift, deprecate repeated failure, and attribute only followed successful use.

## 10. Reliability and Operations

### 10.1 Deployment profiles

- `local`: single-user, offline-capable, best effort.
- `team`: single-region team service, monthly availability >= 99.5%.
- `enterprise`: production organization service, monthly availability >= 99.9%.

Third-party provider availability is measured separately, but correct fallback, explicit failure, and non-expansion of authority remain Runtime SLOs.

### 10.2 Key online SLOs

| Boundary | Team | Enterprise |
|---|---:|---:|
| Context build, cache hit | p95 50 ms / p99 120 ms | p95 30 ms / p99 80 ms |
| Policy local/cache | p95 30 ms / p99 80 ms | p95 20 ms / p99 50 ms |
| Capability resolve | p95 20 ms / p99 50 ms | p95 15 ms / p99 40 ms |
| Transport local overhead | p95 20 ms / p99 50 ms | p95 15 ms / p99 40 ms |
| Memory L0 required cache | p95 10 ms | p95 10 ms |
| Memory L1 local retrieval | p95 100 ms / p99 200 ms | p95 80 ms / p99 160 ms |
| Memory L2 local semantic | p95 300 ms / p99 500 ms | p95 250 ms / p99 450 ms |
| Observation enqueue | p95 2 ms / p99 5 ms | p95 2 ms / p99 5 ms |
| Admin read | p95 300 ms / p99 800 ms | p95 200 ms / p99 500 ms |
| Admin mutation accept | p95 500 ms / p99 1 s | p95 300 ms / p99 800 ms |

Provider/model latency is reported separately as upstream TTFT, total latency, retry, and fallback time.

### 10.3 Durable completion targets

- Accepted RuntimeEvent to durable Audit: team p95 5 s; enterprise p95 2 s.
- Usage observation to durable ledger: team p95 5 s; enterprise p95 2 s.
- Post-Run durable enqueue: team p95 50 ms; enterprise p95 30 ms.
- Observation to query projection: team p95 10 s; enterprise p95 5 s.
- Policy canary publish: team 5 min; enterprise 2 min.
- Policy rollback: team 10 min; enterprise 5 min.
- Purge without legal hold: team 24 h; enterprise 4 h.
- SCIM propagation: team 15 min; enterprise 5 min.
- Export <= 1 GB: team 60 min; enterprise 15 min.

Operations remain in their true state after deadline. Unknown side effects enter manual recovery and are never reported as success.

### 10.4 Recovery and capacity

Team/enterprise RPO after acknowledged durable accept is zero for Usage and Audit. Policy/config and Claim/Evidence target RPO is 5 min/1 min. Rebuildable projections have rebuildable RPO but require source data, compiler version, and manifests.

Every environment declares execution concurrency, queued jobs, maximum queue age, audit buffer, usage journal, and export concurrency. Limits return explicit throttle/quota errors; queues are never unbounded. Tenant quotas prevent noisy-neighbor starvation.

Fast error-budget burn pages at 10% in one hour and freezes release at 25% in six hours. Any hard safety regression immediately freezes the affected policy/plugin/learning rollout. Team recovery drills are quarterly; enterprise drills are monthly.

## 11. Testing and Release Gates

Required test families:

- L0 contract valid/invalid fixtures and version compatibility.
- RuntimeEvent catalog, terminal invariants, replay deduplication, and error safe-detail allowlists.
- Identity merge/unlink, membership change, scope isolation, group safety, and cross-tenant denial.
- Memory schema evolution, add-only Evidence, conflicts, temporal validity, authority propagation, retrieval authorization, token budgets, profile rebuild, purge reachability, and export/import.
- Retrieval quality: recall, precision, stale-memory error, forbidden leak, conflict correctness, temporal QA, unsupported personalization, and fixed-budget comparisons.
- Tool/Workflow/Agent: idempotency, unknown side effects, checkpoint recovery, signals, compensation, manual recovery, event resume, tool reauthorization, cancellation, and reasoning non-persistence.
- Transport: protocol fixtures, streaming/tool assembly, pure pass-through bytes, declared-transform AST equality, retry ownership, usage parity, worker kill, backpressure, loops, mode narrowing, and prompt-cache/cost regression.
- Auth and Security: secret stores, capability expiry/revocation, DLP, redaction failure, key rotation, browser isolation, and break-glass.
- Enterprise: policy revision/canary/rollback, plugin lifecycle/drain, SCIM, delegated admin, quotas, legal hold, exports, backup/restore, and degraded states.
- Learning: deterministic decisions, no-artifact behavior, evaluation evidence, attribution, compression coverage, Skill mining/alignment/revalidation, promotion rollback, and long-horizon simulation.
- Observability: action schemas, call trees, async links, view authorization, cursor binding, completeness, sampling, critical spool, cardinality, sink failure, usage separation, and latency overhead.
- SLO/RTO/RPO: load, saturation, journal recovery, dependency outage, restore exercises, and error-budget behavior.

No feature is complete until it has a stable interface, policy boundary, failure behavior, observability, tests, versioned data/API evolution, English normative documentation, and Chinese user documentation.

## 12. Delivery Roadmap

### Release R0 - Runtime Foundation

Users can call multiple providers/agents through one governed Runtime and inspect execution, usage, and failures. Deliver in increments:

- R0.1 Contracted Runtime: canonical identity/scope/policy/event/error; Tool/Workflow/Agent Ports; local adapters; secret references; contract fixtures.
- R0.2 Reliable Execution Plane: single proxy, Usage parity, permissions, idempotency, cancellation, side effects, resumable Agent events, audit, recovery.
- R0.3 Governed Operations: local directory, admin mutations, policy revision lifecycle, plugin lifecycle, audit query, backup/restore, SLO dashboard.

### Release R1 - Governed Execution and Memory

Users receive automatic but controllable cross-execution Memory and can inspect, correct, pin, forget, purge, import, and export. Exit requires Claim/Evidence authority, policy-controlled writes, zero scope leak, provable purge, retrieval quality/latency, and stable execution with Memory disabled.

### Release R2 - Verified Learning

Repeated verified success becomes validated Skill and organizations can explain activation, rollback, and CapabilityGain. Exit requires replay/sandbox/shadow, high-risk confirmation, deterministic decisions, failure auto-disable/revalidation, source completeness, and rollback.

### Release R3 - Enterprise Organizational Runtime

Organizations federate identity, delegate administration, govern shared capability, and meet compliance/operations requirements. Exit requires OIDC/SAML, SCIM, policy rollout/rollback, plugin governance, quota/FinOps, residency/retention/legal hold, audit export, backup/restore, and SLO/RTO/RPO.

### Technical phases

0. Freeze contracts, evaluation baseline, data protection, mature-provider adapters, and transport parity fixtures.
0.5. Establish Learning Objectives, deterministic Governor, outcomes, uncertainty, and CapabilityGain control plane.
1. Move Memory into core; establish identity/scope; build read path, Observation baseline, and unified transport facade.
2. Add durable Post-Run automatic Memory MVP and evidence candidates.
3. Add long/short/project separation, profiles, controls, retention, and governance.
4. Build Auth Session Broker in parallel.
5. Add planner, lexical/hybrid retrieval, rerank, Context Compiler, and bounded iterative search.
6. Add versioned vector retrieval and progressive re-embedding.
7. Add semantic distillation, profile AST, and Skill candidates.
8. Add retrieval evaluation, bitemporal truth, and conflict correctness.
9. Add temporal graph, utility feedback, three-layer Memory, and sequence mining foundation.
10. Add validated self-mined Skill IR and self-healing.
11. Add active recall, uncertainty questions, causal feedback, Shadow Memory, and advanced compression.
12. Add multi-agent/team scopes, signed event replication, team keys, and multimodal artifact Memory.
13. Add integrity proofs and reversible parametric promotion.

Observability is implemented continuously, not as a final phase.

## 13. Existing Foundation and Evolution Guarantees

The target specification is ahead of implementation. Existing foundations include CLI, Telegram, provider/model configuration, Claude/Codex execution paths, sessions, progress streaming, usage records, reports, local configuration, an OpenAI Usage Proxy with compatibility behavior, and an early Telegram Memory implementation.

Evolution guarantees:

- Preserve existing CLI, Telegram, provider selection, translation, usage records, metrics, error behavior, and user controls while introducing core contracts.
- Move reusable behavior from Surfaces into core modules without breaking callers.
- Preserve `startOpenAiUsageProxy()` as a facade while delegating to the unified transport data plane.
- Do not chain a new Memory proxy.
- Treat `usage.json`, `memories`, scope aliases, and Telegram-specific types as internal storage or delivery encodings, not public Runtime contracts.
- Use expand/upgrade/verify/contract for schema evolution, with backups, cursors, idempotency, and rollback evidence.
- Feature flags may defer activation but may not present an incomplete feature as complete.

## 14. User and Operator Surfaces

The product retains CLI commands for interactive mode, help, provider add/edit/list/delete/use/status, Claude/Codex launch, Telegram lifecycle, sessions, reports, logs, context generation, diagnostics, continuation, Web control plane, and Memory controls.

Expected Memory controls include list/show/history, pin, correct, forget, purge, import/export, Skill list/show/approve/deprecate/edit, and trace/explain views. User-facing documentation is Chinese. Dangerous operations show scope and consequence, require confirmation where policy demands it, return durable progress, and expose completion evidence.

Telegram uses safe progress states for thinking, Memory recall/injection/learning, Skill apply/learning, tool calls, writing, and completion. Progress is best effort and never delays the authoritative response or leaks content.

### 14.1 Provider configuration and routing

User-editable provider configuration is global by default at `~/.ai-gateway/providers.json`; `AI_GATEWAY_HOME` may override the directory. The file contains only fields users need to edit:

```json
[{ "name": "example", "baseUrl": "https://provider.example", "apiKeyRef": "secret://provider/example", "mode": "auto", "level": 1, "model": "model-id" }]
```

- `name` is unique.
- `baseUrl` and `apiKeyRef` identify the endpoint and an opaque SecretStore reference.
- `mode` is `ask | auto`; it affects user confirmation/presentation but cannot override Kernel policy.
- Lower numeric `level` is preferred; level 1 is the default.
- `model` is the provider default. Discovered model candidates belong to internal cache, not this file.
- Manual edits are recognized on the next command. Writes use validate, temporary file, atomic rename, and clean rewrite.
- New plaintext API keys are never persisted when SecretStore is unavailable.

Fallback sorts providers by level, skips unhealthy or model-incompatible candidates, selects the first valid provider/model, reports the fallback explicitly, and does not change defaults. Engine adapters execute the exact selected provider/model and cannot perform hidden second-stage routing. Failed-provider session ids are not resumed across providers.

`ai status` performs token-free connectivity and model discovery. It does not call chat/completion merely to show status. Provider reachability and downstream Runtime readiness are separate statuses. Expired circuit errors become bounded half-open probes rather than permanent disablement.

### 14.2 Configuration and operational data

- `.ai-cache.json`: internal provider health, discovery time, models, and safe error summary.
- `usage.json`: UsageObserver-owned provider-returned token/cost events; usage is never estimated when structured data is unavailable.
- `.ai-gateway.log`: redacted operational JSONL for commands, health, fallback, diagnostics, and errors.
- `sessions.json`: launch/session metadata including tool, provider, model, mode, project, times, status, exit code, and fallback source.
- `reports/`: secret-free session handoff reports.
- `transport-proxy.json` and other internal stores: versioned, validated, bounded, and excluded from user-editable provider semantics.

Internal state does not pollute user configuration. Logs, reports, caches, exports, crash output, and diagnostics never contain full API keys, authorization, cookies, passwords, prompts, reasoning, or raw tool arguments.

### 14.3 Auth Session Broker

Auth Session Broker lets tools use logged-in websites without exposing credentials to models. It is an `auth` capability routed by Capabilities; credential truth remains in Security.

The user performs password, MFA, or captcha entry in a user-controlled isolated browser. The Broker encrypts storage state through `ProtectedPayloadCodec`, with keys from SecretStore/KMS/HSM, per-profile key version, authenticated metadata, and rotation. Models see only a named capability and typed visible-page results, never passwords, cookies, headers, storage APIs, browser context, or storage paths.

Auth profiles bind canonical user, unique name, exact allowlisted HTTPS hosts, login/check URLs, opaque storage key, status `active | expired | revoked`, login time, expiry, data class, and audit metadata. URLs are canonically parsed; wildcards, userinfo, `javascript:`, `data:`, and non-development plaintext HTTP are rejected. Redirects are checked at every hop.

Commands include `ai auth login`, list, status, refresh, logout, and clear. Chat messages never carry passwords. Each task gets an isolated browser context destroyed at completion; concurrent refresh uses a lease. Every execution rechecks profile status, expiry, domain, requested action, data class, and Policy before issuing a short-lived capability.

External page content remains untrusted. Reads of sensitive financial/medical/personal data and cross-domain output can require confirmation. Actions are classified as read, navigate, form write, submit, financial, or destructive; submit/financial/destructive actions require execution-time confirmation of final target and parameters. Memory or Skill cannot waive this requirement.

### 14.4 Telegram execution experience

Telegram supports Claude and Codex engines through one engine contract, one Orchestration lifecycle, and per-session serialization. It maps engine output into text, progress, tool calls, confirmation requests, files, diffs, completion, failure, cancellation, and session state without owning execution policy.

Permission requests use typed callback data, expire, bind the requesting user/chat/session/action hash, and are idempotent. Group/private rules and administrator checks apply at the edge and core. Callback approval only returns a decision to Kernel; it does not execute the action directly.

`ProgressReporter` owns one editable status message per task, throttles frequent updates, deduplicates identical text, tolerates Telegram 429/network/edit errors, and is a no-op in silent mode. Short results replace the status message; long results or attachments replace it with a safe summary and send the artifacts. `finally` cleanup prevents stale progress messages. Progress failure never changes task outcome.

Sessions record launch configuration and safe resume metadata. Runtime provider fallback never reuses an incompatible downstream engine session id. Cancellation propagates through Surface, Agent/Workflow/Tool, and Transport. Unknown cancellation state is reported honestly rather than displayed as cancelled.

## 15. Product Extraction and Deployment Guidance

Swappability is not the same as standalone product readiness. A module can become standalone only when it has:

1. a process/network API in addition to in-process Port;
2. its own schema lifecycle and upgrade path;
3. independently versioned SDK/API;
4. isolated dependency closure;
5. its own edge authentication and authorization.

Runtime must dogfood the same extracted product through the same Port. No embedded/extracted fork is allowed.

- Transport Proxy is the strongest extraction candidate.
- Memory/Skill is a strong but large candidate and must carry Policy, Learning, and Security semantics.
- Provider routing normally belongs with Transport.
- Recall is not meaningful without the ledger.
- Learning Governor is core Runtime IP and should remain internal.
- Policy should adopt OPA/Cedar rather than become a new product.
- Storage engines should be adopted, not recreated.

Prefer extracting asynchronous Memory write/extraction before remote synchronous recall because the read/injection path has a strict 300 ms fail-open budget.

## 16. Integration Guidance for External Applications

An external business application normally integrates as a Surface/API client. It submits typed Runtime requests and domain events under canonical identity, scope, purpose, idempotency, and trace. It reads governed projections through Runtime APIs.

The application implements an Adapter only when it supplies a replaceable underlying capability such as a model, speech evaluator, domain retriever, tool, workflow, identity directory, or enterprise system connector.

Applications must not write Profile snapshots, active Claims, permissions, usage ledgers, or policy state directly. Domain profiles are compiled from authoritative Evidence/Claims. Domain event catalogs must be versioned integration specifications rather than free strings.

## 17. AI Implementation Rules

When proposing or implementing work from this specification:

- State the affected authority owner and module before changing code.
- Reuse existing Ports, adapters, mature libraries, and local patterns.
- Add a new subsystem only when its responsibility is distinct and proven.
- Preserve stable external interfaces and provide explicit versioning and upgrade paths for changes.
- Keep models advisory; deterministic code owns policy, state transitions, permission, and final confidence.
- Treat every external output as untrusted until mapped, validated, scoped, and authorized.
- Keep explicit user controls available even when advanced backends fail.
- Define failure behavior, kill switch, observability, SLO impact, tests, and rollback with every capability.
- Never claim implementation completion from target documentation alone.
- Update English canon and the affected Chinese normative/user documents in the same change.

## 18. Specification Completeness

This document is complete at the product and architecture level. It includes product identity, constitutional invariants, all Runtime layers, authority ownership, stable contracts, execution semantics, Memory and Skill intelligence, governed learning, observability, enterprise control, security, storage, replaceable adapters, all Q1-Q6 and R1-R36 decisions, SLO/RTO/RPO, tests, releases, technical phases, user/operator capabilities, application integration, and implementation rules.

Repeated implementation listings and presentation strings are represented by their stable behavior and acceptance criteria. They cannot override the contracts, authority rules, failure semantics, or feature set defined here.
