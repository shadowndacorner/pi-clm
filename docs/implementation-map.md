# Implementation map: staged batched CLM commits (v7)

Status: implementation-readiness artifact for issue #4 v14. This is a code-change map, not implementation approval. Target: `shadowndacorner/pi-clm` at `3e4e977`; Pi v0.85.0. Scope: CLM mode only; conservative mode unchanged.

## Module ownership

| Module | Responsibility |
|---|---|
| `src/staging.ts` | `RuntimeActive`, `PendingDraft`, `CommitLease`, `effectiveActive()`, draft coverage cursor |
| `src/session-ledger.ts` | physical session ancestry and ordered context-entry ledger |
| `src/state.ts` | durable schema, lifecycle/enable generation, migration, checkpoint provenance |
| `src/mirror-store.ts` | staged and visible mirror publication, conflict detection |
| `src/index.ts` | orchestration: turn-end draft, context render/commit, compaction, tools, status |
| `src/context-document.ts` | draft validation, mirror rendering, tool-group normalization |
| `src/projection.ts` | checkpoint provenance, reanchor/recovery gates |
| `src/overflow.ts` | pure guard simulation and committed materialization |
| `src/observation.ts` | policy-keyed cap cache |
| `src/settings.ts` | settings lease/policy invalidation |
| `src/tidy.ts` | `/clm-tidy` prompt contract |
| `src/viewer.ts`, `src/presentation.ts` | runtime/draft/queued/durable status and timeline |

## 1. Runtime, draft, and coverage cursor

`RuntimeActive` is memory-only and carries:

- volatile revision and checkpoint;
- `baseDurableRevision`;
- `rawCutoff`, entry IDs/ordinals/digests;
- policy/settings digest;
- per-output transitive lineage and representation.

`PendingDraft` carries:

- generation, lifecycle epoch, ancestor leaf ID;
- base durable/runtime revision and active digest;
- base raw-prefix digest;
- `sourceRawCount`, covered entry IDs, ordinals, digests;
- projected messages, origins, removals, normalizations, tombstones, taint;
- document nonce, queued commit state.

`effectiveActive()` returns `runtimeActive` if valid, else the durable checkpoint.

`turn_end` creates or revalidates `pendingDraft`; it does **not** change provider-active or durable checkpoint state. `context` computes two independent things:

1. **Provider output**: `effectiveActive()` plus raw suffix since the runtime cutoff.
2. **Mirror**: `pendingDraft` plus uncovered raw suffix.

Second-edit oracle: an accepted second edit replaces only `pendingDraft` with a new generation/nonce; provider-active and durable state remain unchanged. A rejected second edit preserves the last valid draft, its coverage cursor, and its commit eligibility; the raw suffix is neither skipped nor duplicated.

A covered entry/message advances the draft cursor only if it is represented, explicitly removed, or normalized with transitive lineage. An A-only mirror cannot consume unseen parallel B; B remains raw suffix and is appended only when represented.

## 2. Real Pi v0.85.0 adapters

Replace the `buildSessionProjection()` probe with pinned APIs:

- `buildContextEntries(entries, leafId, byId)`;
- `sessionEntryToContextMessages(entry)`;
- `buildSessionContext(entries, leafId, byId)` for flattened context.

The adapter must expand:

- ordinary message entries;
- `custom_message` entries;
- `branch_summary`;
- `compaction`;
- zero-output entries;
- only verified trailing in-flight provisional messages.

A changed middle entry is upstream mismatch, not provisional reconciliation. Compare the canonical flattened stream to received `event.messages`; fail closed on divergence. Tree tests use the real SessionManager, not synthetic `context_edit` entries.

## 3. Physical ancestry vs context order

Keep two separate helpers.

### Physical ancestry ledger

Use the verified persisted branch entries with `id`/`parentId` to determine:

- the newest verified native-compaction ancestor;
- lifecycle/enable generation validity;
- durable checkpoint validity;
- sibling-branch ancestry.

Checkpoint age/ancestor relation is derived from physical ancestry, not flattened context position or summary equality.

### Context projection ledger

Use `buildContextEntries` plus per-entry expansion to reconstruct the exact ordered context ledger for received-message equality and draft coverage. Note that Pi returns `[latest compaction, retained entries physically before it, later entries]`; this is provider order, not chronological ancestry.

Both ledgers are used in restore, active application, retry/historical recovery, reanchor, reset, and viewer historical-vs-active semantics. Every path is gated by lifecycle/enable generation and the newest verified compaction ancestor.

## 4. Durable schema and migration

Add to durable state/checkpoint:

- lifecycle generation;
- enabled generation;
- checkpoint epoch;
- native-compaction ancestor entry ID/branch provenance.

Update:

- `toOutcomeEntry`;
- `reconstructLiveContextState`;
- `reconstructLiveContextHistory`;
- reset paths;
- settings migration.

`runtimeActive` must never be written into durable `state.revision/checkpoint`. Retry/reanchor history is durable-only. Legacy CLM checkpoints without trustworthy transitive lineage are quarantined/disabled with sanitized fallback; conservative mode remains unchanged.

## 5. Persistence fence

`appendEntry` is not durable acknowledgment. Pi mutates in-memory entries/leaf before `_persist`, and pre-first-assistant writes may be buffered.

Add a read-back disk/verified-snapshot fence:

- mark `persisted` vs `buffered`;
- fail-stop/quarantine on unverified off/on/reset/native-success durability;
- explicit negative acknowledgment;
- no recovery from phantom `getBranch()` entries;
- no blind retry.

A failed append followed by a later ordinary Pi append can flush a phantom ancestor. Require verified reload/repair and fail-stop, not poisoned-branch recovery.

## 6. Staging and atomic activation

Controller sequence:

`prepare -> rename(staging) -> leaseRecheck -> CAS/activate -> publish(visible mirror) -> rollback`

Every await rechecks session/store, lifecycle epoch, ancestry, durable/runtime revision, digest, policy/settings digest, draft generation, raw-prefix digest, leaf, and mirror generation.

Activation is synchronous and generation/epoch-bound. Snapshot and verify old-active and candidate before activation.

Total fallback order:

1. verified old-active if lease still matches;
2. provenance-aware sanitized projection;
3. static emergency `AgentMessage[]` with a Pi-valid custom notice or empty safe array.

Never return unverified `event.messages`. On failed compensation or unknown provenance, quarantine.

## 7. Visible-file publication contract

`MirrorStore` is the single publication coordinator for `LIVE_CONTEXT.md`.

APIs:

- `stage(content, generation, digest, nonce)` writes a private temp file;
- `publish(expectedVisibleDigest, generation)` reads the visible file, compares digest/nonce/generation, then atomically renames the staged file;
- `restore(expectedVisibleDigest, generation)` restores only if its own generation and visible digest still match.

Apply the same coordinator to ordinary context re-renders and queued commits. Publication is serialized through one in-process lane/queue in `MirrorStore`; awaits must not interleave independently. Each writer captures a baseline visible digest/nonce/generation, stages a private file, and publishes only if the expected visible identity still matches. Stale-generation writes are rejected. If an ordinary re-render races a queued commit or an accepted edit, the re-render must not overwrite the draft/queued commit or the accepted-edit generation; the queued commit or edit wins, and the re-render is retried or discarded.

A read/check followed by rename cannot guarantee no-lost edits against an uncooperative writer racing after the final check. The documented promise is **best-effort detection with cooperative ownership**, or use an advisory lock if cooperative locking is required. Without cooperation, an external write after the final comparison may be overwritten; this must be stated, not hidden.

### Publication failure-state table

| Event | Mirror | Runtime | Action | Notification |
|---|---|---|---|---|
| external write before publish check | external content | last active/draft | abort publish; preserve external bytes | detected conflict |
| external write after final check, before rename | external content may be lost | last active/draft | best-effort race; document limitation | conflict warning if detected |
| publish rename failure | old visible | old runtime | restore old generation-bound | failure notice |
| rollback external write before restore | external content | old/new | do not overwrite if digest/generation mismatch | conflict/quarantine |
| rollback failure | inconsistent | inconsistent | quarantine; emergency fallback | error |

Deterministic tests inject external writes at the last pre-publication boundary and during rollback.

## 8. Tool-group normalization

Model groups as:

- `open`: raw suffix; watermark does not advance.
- `complete`: watermark advances.
- `terminalized-coverable`: closed normalized representation; watermark advances exactly once.

Physical occurrence identity: source entry ID + ordinal + digest.
Logical call identity: assistant-call origin + `toolCallId` + branch epoch.

Rules:

- retain assistant prose with unresolved tool-call fields stripped;
- emit only static bounded custom tombstone text in `details`;
- never put raw result bodies or attacker-controlled assistant dumps into custom/user content;
- full completed result content only in a provider-valid assistant-tool-call/tool-result pairing;
- exactly-once replay of one physical occurrence;
- conflicting independent results for one logical call fail closed;
- late B2 gets one static tombstone. Exactly-once identity: only replay of the same `(entryId, ordinal, digest)` is idempotent. Two distinct physical occurrences claiming one logical call fail closed even when their bodies are byte-identical; reject/quarantine/non-promote both and never expose either body as custom/user text. The same `toolCallId` on different assistant origins does not collide.
- close the metadata-only foreign-header path that can enter the headerless full-rewrite branch;
- reject edits to capped/withheld bodies.

## 9. Pure guard and savings

Separate pure post-guard simulation from materialization.

- Cap/withhold cache keys include origin, policy, `maxCharacters`, and `headFraction`.
- Carry transitive per-output lineage/taint.
- Prevent double-capping and withheld resurrection.
- Withheld files are keyed by physical origin/digest, not `toolCallId`.
- Handle aborted staging cleanup and file failures.
- Never copy source bodies into custom tombstones.

Savings:

`Δ_net = E_before(rawSuffix, fixedMask, policy) - E_after(rawSuffix, sameMask, policy)`

over the full candidate, including authored descendants, system framing, continuity, and notices as applicable.

- soft: `E <= L` and `Δ_net >= SOFT_MIN_SAVINGS`;
- hard: `E <= L` and `Δ_net > 0`;
- per-origin gross `S` is diagnostic only;
- avoid counting the 4096 framing reserve twice.

## 10. Pressure scheduler

- `L = overflowGuardLimit(budget, reserve, window)`; require `L > 0`.
- soft trigger near 90% of `L`;
- `SOFT_MIN_SAVINGS = max(256, ceil(0.05 * L))`;
- hard trigger at `L`;
- at most one pressure commit per draft generation;
- no pressure commit without a budget;
- explicit growth under headroom with warning;
- `flushOnOwnerTurn` default off;
- no repeated threshold thrash.

Queue/activation occurs at a verified `context` boundary.

## 11. Max-output-token lifting

### v1 production policy: fail-closed, no lift without a host certificate

`before_provider_request` must not use `lastBudgetReading` alone. The gate is executable, but v1 production does **not** lift output limits unless a host-issued `terminalProviderHookCertificate` is present. The certificate is an external launcher invariant: it asserts CLM is the last registered `before_provider_request` handler in the Pi extension chain and that no later context/provider hook can mutate the payload. It is not inferred from Pi's public API. If absent, every payload denies and leaves its output-limit fields unchanged.

The certificate must be validated by a fixture where a later provider hook mutates the payload; that fixture must deny. If the host cannot provide the certificate, lifting remains disabled. This is the explicit no-lift fallback required by the v7 review.

### Reachable v1 payload subtype

The only positive subtype is a serialized Pi v0.85 `openai-completions` payload produced by `buildParams`/`convertMessages`, with these exact fields:

- top-level allowed: `model` string; `messages` array; `stream` boolean; `stream_options` exact `{include_usage:true}` optional; `prompt_cache_key` string optional; `prompt_cache_retention` exact `"24h"` optional; `store` exact `false` optional; `temperature` finite number optional; `tools` array optional; `tool_choice` exact `{type:"auto"|"none"|"required"|"function", function?:{name:string}}` or string optional; `max_tokens` or `max_completion_tokens` finite positive integer optional; `reasoning_effort` string optional; `thinking` exact `{type:"enabled"|"disabled", clear_thinking?:boolean}` optional; `tool_stream` boolean optional; `priority` finite number optional.
- `messages`: system/developer `{role,content:string}`; user `{role,content:string}` or `{role,content:[{type:"text",text:string}|{type:"image_url",image_url:{url:string}}]}`; assistant `{role,content:string|null, tool_calls?: [...]}`; tool `{role:"tool",content:string,tool_call_id:string,name?:string}`.
- tool calls: `{id:string,type:"function",function:{name:string,arguments:string}}`; `reasoning_details`, `reasoning_content`, custom/grammar tool calls, and opaque blocks deny.
- tools: `{type:"function",function:{name:string,description:string,parameters:JSON object,strict?:boolean}}`; custom/grammar tools deny.
- Unknown keys, wrong types, nulls where not allowed, duplicate `max_tokens` and `max_completion_tokens`, arrays where not allowed, unserializable values, and non-JSON tool parameters deny.

Anthropic, Responses, Google, Kimi deferred-tools, cache-control variants, and any other shape deny. This is a reachable subtype, not general provider support. A positive fixture must be a real serialized Pi v0.85 payload, not a synthetic `{name,description,parameters}` object.

### Conservative bound

Use `B(text) = UTF-8 byte length of the serialized text`, not `estimateTextTokens`. `U(payload) = B(canonicalJson(payload with output-limit fields removed)) + MESSAGE_OVERHEAD_PER_MESSAGE * messageCount`. A tokenizer cannot emit more tokens than bytes for valid UTF-8 serialized payloads, so `B` is a conservative upper bound; the independent oracle must validate the actual model/tokenizer framing, not merely sample text. If the oracle contradicts `U`, deny lift.

Constants, each counted exactly once:

- `FRAMING_RESERVE = 4096`;
- `PROVIDER_OVERHEAD = 2048` (headroom only, not inside `U`);
- `MESSAGE_OVERHEAD_PER_MESSAGE = 16` (per message, inside `U`);
- `UNCERTAINTY = ceil(0.05 * U(payload))`;
- `CONSERVATIVE_HEADROOM = FRAMING_RESERVE + PROVIDER_OVERHEAD + UNCERTAINTY`.

`desired = min(modelMax, window - U(payload) - CONSERVATIVE_HEADROOM)`.

### Final digest bridge and terminal certificate

CLM's `context` handler sees `AgentMessage[]`, not the serialized provider request. v1 defines `clmProjection` as the canonical allowlisted payload CLM itself would emit from its final context transform. `clmCandidateDigest = sha256(canonicalJson(clmProjection with output-limit fields removed))`; `payloadDigest = sha256(canonicalJson(actual payload with output-limit fields removed))`. They must be equal. Hashing both after lifting would be self-attesting, so the digest is computed on the limit-stripped payload before lift.

Pi invokes `before_provider_request` handlers sequentially, so a later handler can replace or grow the payload. CLM cannot observe a mutation that happens after its own hook. Therefore a `terminalProviderHookCertificate` is required for any lift. The certificate is a host/launcher assertion validated by a real later-hook denial fixture; it is not a self-attesting runtime predicate. If it is absent or cannot be validated, deny lift.

### Lift predicates

Lift is permitted only when all hold:

1. `terminalProviderHookCertificate` is present and validated;
2. payload shape is in the reachable v1 subtype and every token-bearing field is enumerated;
3. the stored `clmCandidateDigest` matches the final `payloadDigest` on the limit-stripped domain;
4. runtime/policy lease matches and no downstream context growth/replacement or unknown transform occurred;
5. `desired > 0`, `desired <= modelMax`, and `U(payload) + desired <= window - CONSERVATIVE_HEADROOM`;
6. exactly one existing numeric output-limit field is present: `max_tokens` or `max_completion_tokens`, finite positive integer, and only that one; conflicting simultaneous fields deny;
7. `current < desired`; absent limits are not added.

If any predicate fails, leave all output-limit fields unchanged. Tests: a real Pi v0.85 serialized payload positive subtype; no certificate denies; later context-chain mutation denies; later provider-hook mutation denies; high-token-density Unicode/JSON against an independent bound oracle; nested tool/schema expansion; boundary equality `U + desired == window - CONSERVATIVE_HEADROOM`; unsupported/opaque/provider variants deny; stale reading denies; conflicting output-limit fields deny; untouched limits on denial; one bounded permitted lift under a validated certificate with exact digest match; absent limits are not added.

## 12. Consumer wiring and compaction

Audit every consumer against the runtime/draft/durable model:

- `budgetNotice`;
- `captureObservedUsage`;
- `contextSnapshot`;
- overflow guard;
- continuity annotations;
- status/viewer/timeline;
- settings command and panel lease invalidation;
- `before_provider_request`.

Compaction:

- `session_before_compact` uses the total v14 truth table over enabled, `nativeCompaction=on|auto|off`, reason, estimate freshness, guard availability, post-guard bound, and queued state.
- cancel `auto` threshold only on fresh reproducible post-guard proof `E_post <= L`;
- unknown/stale/no-budget/failed simulation/unguardable allow native;
- `off` may cancel by explicit policy with warning;
- `session_compact` success discards volatile state;
- `session_compact_failed` preserves; quarantine only on independently uncertain durable failure;
- native compaction provenance comes from verified physical ancestry, not `event.compactionEntry`.

## 13. Commit tool and tidy

Add:

- model tool `live_context_commit`;
- slash command `/clm commit`;
- rejection for no draft, changed lease, base mismatch, already queued, dirty, same-batch;
- next-context-only activation.

Update `/clm-tidy`:

- edit;
- commit as second-to-last step;
- last step continue ongoing work or report and stop;
- same-batch edit + commit forbidden;
- commit outcome appears on the next request.

Defer `live_context_tidy` in v1.

## 14. Acceptance fixtures

Use real Pi v0.85.0 SessionManager fixtures, not synthetic `context_edit`.

Required named tests:

- real entry API imports and exact `event.messages` parity;
- prior context handler mutation, upstream non-tail mutation, zero-output entries;
- in-flight provisional -> durable identity;
- actual tree/branch and compaction behavior;
- parallel A(c1,c2) -> B1 -> abort -> commit -> restart -> late B2 -> duplicate B1;
- open A-only vs terminalized-coverable;
- distinct B1 entry IDs with same call ID: different malicious payloads and byte-identical bodies both fail closed; only same `(entryId, ordinal, digest)` replay is idempotent;
- two separate physical results with identical body and conflicting bodies;
- same call ID on different assistant origins does not collide;
- two edits plus interleaved suffix; accepted second edit replaces only the draft with new generation/nonce; rejected second edit preserves the last valid draft and coverage/commit eligibility without suffix skip/duplication;
- draft not provider-active; same-batch edit+commit refusal;
- queued with no next request; exactly one activation;
- internal mirror publication interleaving: ordinary re-render vs queued commit vs accepted edit; stale-generation rejection and non-destructive behavior;
- lease races against tree/settings/off/reset/shutdown;
- injected faults before/after staging rename, CAS, publish, rollback;
- sanitizer failure + invalid old-active + unknown provenance;
- two volatile commits over durable `r` then reload;
- off before first assistant; buffered/failed append with mutated in-memory branch;
- off -> on same revision; legacy checkpoint quarantine;
- native compaction success/failure;
- same-summary C0(S) -> R -> C1(S) with pre-C1 kept entries and sibling branch, failed CLM reset append, reload, and historical recovery; no stale R reactivates;
- failed/buffered write -> later ordinary Pi append -> restart;
- fixed-mask near-offset `Δ_net`, authored replacement/copy taint, capHead change, guard off/on, resurrection/double-cap;
- all compaction truth-table cells, stale estimate + queued failed commit with no subsequent context;
- final-payload max-token gate: one real serialized Pi v0.85 `openai-completions` payload matching the reachable subtype, including nested function tools and tool history; no `terminalProviderHookCertificate` denies; a real later context-chain mutation denies; a real later provider-hook mutation denies; high-token-density Unicode/JSON checked against an independent bound oracle; nested tool/schema expansion; boundary equality `U + desired == window - CONSERVATIVE_HEADROOM`; unsupported/opaque/provider variants deny; stale reading denies; conflicting max-token fields deny; untouched limits on denial; absent limits are not added; one bounded permitted lift under a validated certificate with exact limit-stripped candidate/final digest match;
- no-budget/90%-soft/hard/hysteresis/growth cases;
- full headerless rewrite retaining all owner turns and owner-body-edit allowance;
- external write at last pre-publication boundary and during rollback;
- downstream context handler replacing CLM output: assert CLM-local, not provider-wide, atomicity;
- conservative-mode regression and subagent isolation;
- existing `limitations`, `collapse-gate`, `tree-undo-coupling`, and `edit-trace-alignment` suites adapted without weakening the disk fence.

## 15. Implementation order

1. Add staging types and `effectiveActive()`.
2. Add real Pi session-ledger adapters and physical/context ledgers.
3. Add durable schema/migration and persistence fence.
4. Refactor `turn_end` to create drafts, not durable checkpoints.
5. Refactor `context` to render drafts and commit at verified boundaries.
6. Add mirror staged/visible publication and conflict contract.
7. Add terminalized group normalization and identity rules.
8. Add pure guard/savings and pressure scheduler.
9. Rewrite compaction and consumer wiring.
10. Add `live_context_commit`, `/clm commit`, tidy prompt, status/UI.
11. Add acceptance tests; run `npm run check` and focused regressions.

The performance trial remains unfrozen and unvalidated; missing evidence yields `INCONCLUSIVE`, not PASS.
