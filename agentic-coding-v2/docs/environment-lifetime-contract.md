# Independent root idle expiry and dependency references

**Status: proposed contract for developer review; not implemented or approved for execution.**

This document adds no configuration fields, tools, permissions, live leases, migrations or runtime behavior. Names below describe a prospective native contract, not accepted API/schema inputs. Existing requests keep their exact approved semantics. In particular, reading or agreeing with this design is not approval to execute an environment action, share credentials/workspaces, publish configuration or operate a real runtime.

## 1. Baseline and reference evidence

The native implementation currently has:

- One exclusive held **run** acquisition batch per native owner; a second run acquisition is refused while that owner holds runs. One-off build/test actions have separate conflict rules. Complete identical live-plan reuse adds no lease.
- One owner-wide environment-activity clock, including unrelated roots requested together. Default TTL is 30 minutes; the file-only policy is re-read on throttled 60-second sweeps, with the existing unusable-policy fallback.
- Atomic dependency expansion/reservation and a coupled dependency-batch lifetime. Selecting or losing a member cleans the approved batch dependent-first, not just one root.
- Native intent/receipt journaling plus server-private live process/resource capabilities. Reopened records quarantine uncertainty; stored IDs do not restore permission to observe/control a process or runtime.

Source boundaries: [approval](../src/environment/approval.ts), [admission](../src/environment/acquisitions.ts), [dependency expansion](../src/environment/dependencies.ts), [resource conflicts](../src/environment/resources.ts), [idle lifecycle](../src/environment/idle.ts), [manager cleanup](../src/environment/manager.ts), [native state](../src/environment/state.ts), and [live diagnostic authority](../src/environment/authority.ts).

Read-only reference evidence, **not code or authority to import**:

- The previous host's [Lifecycle and wait descriptions](../../agentic-coding/docs/agent-environments.md) describe per-app activity, protecting waiting owners, atomic multi-app acquisition, and wait-for cycle detection while owners retain holdings.
- Its [dependency lease implementation](../../agentic-coding/src/server/runtime/leases.ts) distinguishes owned dependencies from shared/external steps that own nothing; owned-target stop is blocked while dependents remain. It also adopts durable leases on restart. That adoption behavior is explicitly **not** proposed for v2.

Therefore, “a managed owned dependency referenced by several roots” and “a shared/external service we do not own” must not be conflated. Per-app timestamps alone cannot provide either reference-safe cleanup or safe hold-and-wait admission. See the [parity ledger](environment-parity.md) for implemented versus pending capabilities.

## 2. Proposed decisions

All decisions in this table await developer review. They are conservative proposed boundaries, not permissions inferred from the parity goal.

| Decision | Proposed contract |
| --- | --- |
| Opt-in | A versioned lifetime contract is part of each new exact execution approval. Existing coupled requests remain the default and are never silently upgraded. |
| First executable slice | Independent **agent-owned standalone shell app roots**, in one atomically approved request, without `requires`, cross-owner sharing, a second held run batch, or new diagnostic transports. Operator requests retain their current lifetime behavior. |
| Dependency follow-up | Same-owner roots may reference one managed owned dependency generation only after reference-fenced cleanup and diagnostics are implemented together. |
| Additional batches | Later opt-in immediate atomic extension only: reuse exact compatible live resources or grant all new resources without waiting. If blocked while holding runs, refuse; do not retain a wait edge. |
| Waiting parity | Retained waits while holding runs require a separately reviewed transactional wait-for graph/cycle protocol. Until then, retain no-hold-and-wait; do not claim legacy wait parity. |
| Cross-owner sharing | Deferred and refused until independent service workspace retention, controller authority, two-sided sharing approval and data-isolation rules exist. |
| Shared/external services | Separate observation/binding contract; no native creation/stop ownership or managed-reference lease inferred from reachability. Deferred from the first slices. |
| Restart | Persist audit and quarantine blockers, never process capabilities, active activity clocks, live queue entries or restored control authority. |

No new runtime/transport is implied by these choices. Compose networks, Pod replicas, shell process groups, private receivers and adapter children remain indivisible resource groups unless their existing adapter provides a narrower **approved and verified** cleanup boundary. No partial Compose-service or Pod-replica expiry is proposed.

The first slice is not just a timer change. Current manager stop/authority paths latch by acquisition batch (`stopped`, queue removal and diagnostic checks). Independent roots need distinct version-aware closing/operation barriers: stopping B must not invalidate A's live endpoint, telemetry, future operations or clock merely because A and B share an acquisition receipt. A batch remains the immutable atomic admission journal, not automatically the independent-mode cleanup unit. Legacy stop/cascade/replay behavior must remain unchanged.

## 3. Exact approval boundary

A prospective approval must bind, in addition to the current complete resolved execution plans:

1. Contract version and selected lifetime semantics: legacy coupled batch versus independent roots. Unknown versions or mixed lifetime semantics within current held run plans fail closed; one-off build/test actions retain their separate conflict rules.
2. The exact native owner, request identity, app roots and workspace bindings; the resolved dependency DAG and runtime-specific indivisible groups; and the explicit resource-sharing policy for each dependency.
3. For each root, a stable root identity within that request, its resource/reference closure and the policy describing which scoped actions renew it. The TTL policy source, fallback and permitted live reload must be disclosed, rather than pretending a reloadable TTL is a frozen numeric grant.
4. Which resources may be newly created, which exact live resource generations may be joined, and any allowed immediate-extension behavior. A changed plan/closure, replacement generation or additional root requires fresh approval; a saved receipt cannot authorize a different generation.
5. Root stop/expiry effects, dependency-loss effects, last-reference cleanup, uncertainty quarantine, diagnostic access boundaries and workspace-retention consequences.

Secret values, unsalted secret hashes, private machine output and serialized live handles do not belong in approval/history/status. Resolve referenced credentials only through the approved private path. A same-owner resource join must compare all execution-relevant frozen inputs privately, including resolved secret bindings, runtime/socket/context, workspace/cwd, environment, mounts, image/command, ports, network and probe configuration. The prerequisite resource generations and their approved graph bindings must also match; an identical cache command does not permit joining a cache attached to a different database generation. A public plan digest alone cannot establish compatibility. Mutable workspace bytes must not be described as content-frozen; a join neither applies edits nor restarts a process.

An approval that permits joining a managed dependency is not HTTP write, SQL query, log disclosure, credential disclosure or cross-owner permission. Existing exact per-operation reviews remain required. Profiles and skills grant none of these powers.

## 4. Native record model versus live authority

Proposed durable records, using native storage rather than an imported lease subsystem:

- **Acquisition intent:** exact versioned request identity, approved plan/closure, queue ordinal where allowed, atomic admission outcome and immutable replay references.
- **Root generation:** owner, request/root identity, immutable plan binding, versioned lifetime mode, membership revision, current recorded phase and release/expiry reason. Reacquisition creates a fresh generation.
- **Managed resource generation:** execution binding, creating intent, indivisible adapter group, recorded phase/revision and runtime observations. Only its corresponding current private live capability can authorize effects.
- **Reference:** unique root-generation/resource-generation pair. A root references every managed resource reachable in its approved DAG once, including diamond dependencies; duplicate graph paths do not increment a counter. States distinguish reserved, active, releasing, quarantined and released.
- **Cleanup intent/outcome:** root/resource generations, expected revisions, affected references, operation identity and observed result. Issued or uncertain effects are never automatically resent after interruption.

Reference counts are derived from reference records, not an independently mutable integer. Reserved, active, releasing and quarantined references all block incompatible reuse and last-reference deletion. Historical released references count as audit only. An infrastructure resource can itself depend on another resource. A root's transitive reference closure remains blocking until the resource cleanups that need it settle: references are released along the reverse dependency DAG, not all at once when the app process exits. Every non-released dependent reference must retain its prerequisite closure, including through uncertainty.

Live handles, original frozen secrets, current observation ports, activity clocks and in-flight operation barriers remain host-private. A serialized reference never constructs one. Public status may expose bounded identities/counts/reasons but must label “recorded reference” versus “current verified live holder.” No cross-owner logs, private inputs or tokens are exposed by that metadata.

## 5. Admission and start transaction

1. Resolve the bounded closed graph before approval, retaining the current 16-project ceiling and adapter-specific bounds. Refuse cycles, unsupported lifecycle modes, foreign repositories and ambiguous defaults before effects.
2. Validate native owner/task authority, exact approved request, workspace bindings, all conflicts and any eligible live resource generations again at atomic admission. Keep port/name/image-writer safeguards; do not bypass `runsConflict` merely because two roots name a dependency alike.
3. In one native transaction reserve **all** roots, needed resources and references, or none. Preserve FIFO for conflicting eligible requests; independent non-conflicting progress is allowed. A shared-resource join must not jump an earlier conflicting stop/replacement/writer intent.
4. Register the live dispatch barrier only with native commit/failure semantics that cannot publish uncommitted permission. A poisoned/failed storage session cannot continue effects. Start newly owned groups dependency-first and wait for their declared readiness; do not restart already joined resources.
5. Publish the acquisition as ready only when every requested root is ready and its complete live reference closure is valid. Partial startup is not a successful atomic acquisition.

Before the wait-for protocol exists, an owner with holdings may not queue or retain a blocked extension. Release no existing root merely to make admission succeed, and reserve/hold nothing new while refusing or waiting. Existing legacy coupled acquisitions keep their current stricter second-acquisition refusal even if a future contract supports immediate extension.

On startup failure, withdraw admission for the new roots, join their dependent-first cleanup and release only this intent's new references after cleanup confirmation. Preserve existing roots/resources and their references. A newly created last-reference resource is eligible for cleanup only after its failed dependents have settled. If a failed root/group cannot be cleaned confidently, keep its references and prerequisites quarantined; failed startup must not undercount dependency use.

## 6. Activity and independent idle expiry

For the proposed independent mode:

- A root-specific environment operation renews **that root**, not unrelated roots. A dependency diagnostic must identify one requiring root and verify its current reference; ambiguity is refused rather than silently selecting a root or renewing every dependent.
- Owner-wide `env_list`/unfiltered status may conservatively renew all that owner's eligible roots, but the tool/review must disclose this explicitly. Passive host/dashboard/historical reads never renew agent activity. A live authenticated developer action does not become an agent heartbeat.
- Dependency use is protected by active root references, not by a competing autonomous dependency TTL. A root's required resources cannot expire underneath it. No separate idle reaper may delete a referenced managed resource.
- Operator/unknown owners are not agent-expiry candidates. In-flight operation protection and revalidation are root/resource scoped; related uncertain membership protects the known dependency closure. If the closure itself cannot be established, fail closed over the affected known owner holdings rather than guessing independence.
- A valid live retained wait protects its owner's needed holdings only in a contract that actually permits hold-and-wait. A persisted waiting record, pending review or model claim cannot manufacture that protection or restore queue authority.

At each throttled sweep, select eligible expired roots, then transactionally revalidate activity sequence, task state, root/membership revisions, valid references, pending operations and current live ownership immediately before committing an immutable stop intent. Latch closing admission before dispatch. Activity arriving before that latch cancels the proposed expiry; activity after it cannot resurrect the closing generation. Any fresh reacquisition needs normal approval and admission after confirmed release.

An expiry stops only selected root groups and relinquishes their references through the normal cleanup path. It neither cancels coding nor permanently revokes future environment authority. The dashboard must show root scope, policy, last activity, protection, shared managed-reference counts, pending releases, cleanup uncertainty and the distinction from old coupled receipts. Clock-only polls must preserve focused controls and diagnostic forms.

## 7. Release, last-reference cleanup and races

1. Stop/expiry/task cancellation first closes the affected roots' admission and diagnostic dispatch, cancels their pending acquisitions and joins their in-flight operations. Persist the exact input-bound stop intent before external effects.
2. Stop each affected root group using its current receipt-fenced live capability. Wait for process-group/resource/receiver closure; no saved-ID cleanup. Failure or ambiguity keeps the root quarantined and its prerequisite references blocking release.
3. After confirmed root-group cleanup, mark its reference closure releasing and walk the reverse dependency DAG. For each resource with other non-released references, settle only this root's reference; those other roots must retain their own complete prerequisite closures. For a last reference, keep it blocking and atomically close attach admission at the resource generation/revision before dispatching cleanup. Only one last-reference cleanup intent may win.
4. Stop last-reference resources dependent-first, then settle the closing reference after confirmed cleanup; only then advance to its prerequisite references. If cleanup is uncertain, retain this reference and the prerequisite closure. A resource with a closing or uncertain generation cannot be joined, replaced or restarted by a later attachment.
5. A racing attach either commits a valid reference **before** the closing latch (therefore preventing last-reference cleanup), or waits/refuses without a reference. It never revives a closing generation. Repeated exact requests replay the recorded outcome; they do not add references or duplicate a stop.

Ordinary stop of managed infrastructure with remaining dependents is refused. A developer-requested cascade must separately identify/review the full current affected roots, revisions and data/workspace effects; “stop infrastructure” is not permission to stop other owners. Task cancellation/revocation releases only its own root references and never a surviving root's dependency. Native task/worktree cleanup must retain every workspace still needed by an owned process/resource; it must not remove a working directory before environment cleanup settles.

Unexpected dependency loss closes operation admission for all roots transitively requiring that generation, then attempts their owned dependent-first cleanup. Unrelated roots are not stopped merely because they share an owner. Readiness loss, confirmed exit, identity replacement and failed observation must remain distinct observations; none permits automatic restart, replacement adoption or force deletion. Uncertain local CLI cleanup or lost mutating outcomes stay quarantined even if later inspection reports absence.

## 8. Deferred sharing and restart requirements

**Same-owner managed sharing** initially means roots from one approved request and workspace can retain one exact dependency generation as siblings expire. It is not cross-task service management. Additional same-owner acquisitions must wait for the separately implemented immediate-extension admission/diagnostic contract.

**Cross-owner managed sharing** remains refused until all of these are reviewed and implemented:

- A service controller/workspace lifetime independent of its first requesting task, with durable workspace retention and no task-cancellation authority over another root's live reference.
- Explicit producer opt-in and consumer join approval binding the same live generation, trust/repository scope, mutable files, exposed endpoints and diagnostic/secret disclosure. A coincident plan hash or matching labels is not consent.
- Safe private compatibility of frozen execution inputs; differing task workspace, owner-specific variables, credentials or receiver attribution cannot be papered over by a “shared” flag.
- Root/reference-scoped HTTP, SQL, telemetry and log authority, including admission/cleanup races. Possessing a reference alone grants no read/write diagnostic operation.

**Shared-observed/external** resources are not native owned resources: no create/stop lease, automatic credential/endpoint injection, adoption or last-reference deletion. Any probe/binding requires its own bounded explicit contract; even HTTP GET is not guaranteed side-effect-free.

**Restart/crash:** interrupted roots, references, reserved intents and closing generations remain blockers. Neither durable counts nor an observed empty engine release a quarantine or reconstruct controller/queue authority. Authenticated revision-fenced operator inspection may record an acknowledgement under the existing inspection boundary; it must not start/kill/adopt resources from saved IDs, silently revoke other owners or resurrect the old generation. Any fresh run uses fresh authority and a new generation. This does not claim distributed fencing, exactly-once remote execution, automatic rollback or live runtime compatibility.

## 9. Representative acceptance scenarios and delivery gates

These are future public-boundary acceptance criteria, **not tests already passing**. Avoid helper-layout, exact-argv or exhaustive matrix tests.

| Slice | Required representative outcome |
| --- | --- |
| Independent standalone roots | Approve two standalone shell roots together; scoped activity renews A, B alone expires, A and coding survive. A's live diagnostic authority and subsequent approved operations still work, not just its process. Passive UI reads do not renew B. Legacy coupled approval still renews/stops its original group. |
| Admission/replay | Changed lifetime mode or roots cannot borrow approval; identical replay adds no process/reference. The first slice still refuses a second held run acquisition; unsupported dependency modes fail before effects. |
| Same-owner dependency references | A and B require one cache (including a diamond path): one actual cache start. Expire/stop A after confirmed root cleanup; B and cache remain. Releasing B stops cache and its prerequisites once, after dependents. Direct dependency stop while referenced is refused. |
| Failure/rollback | New B fails while referencing A's compatible live cache: only B's new effects/references settle, A/cache survive. An uncertain B cleanup retains its references and protects cache, even if an observation reports no B container. |
| Attach versus last release | Exercise an actual bounded response/cleanup boundary: attach wins before closing and prevents deletion, or closing wins and attach gains no reference. No duplicate start/delete, no closing-generation resurrection. |
| Diagnostics and cancellation | Exact-root approved SQL/HTTP operation is fenced to an active reference/generation; release waits for in-flight settlement. Foreign/stopped/ambiguous references cannot dispatch or select a later holder. Cancelling one root/owner preserves other live references. |
| Idle race and crash | Activity before expiry commit prevents stop. SIGKILL after issuance then reopen leaves quarantine and replay sends nothing. Old reference/queue/status records cannot regain live authority. In a live-host root expiry, unrelated verified roots are not stopped; after host death, all remaining generations have lost live authority, even if an external process survives. |
| Deferred boundaries | Cross-owner joins, shared/external ownership, unsupported runtimes/groups and blocked extensions while holding runs are refused without effects until separately approved implementation exists. |

Proposed delivery order, each separately verified and recorded in the parity ledger:

1. Developer review of this contract and the first-slice scope; resolve objections without treating discussion as execution approval.
2. Versioned opt-in approval/root identity and scoped activity for agent-owned standalone shell roots within one atomic acquisition. Preserve legacy/operator defaults, no second held batch, no dependency references or automatic migration. This deliberately does **not** yet allow reacquiring an expired sibling while another root remains held: that is an additional acquisition and belongs to step 4, with fresh approval. Disclose that limitation before the first opt-in execution.
3. Same-owner reference graph plus last-reference cleanup **and** reference-scoped diagnostic barriers; only then enable dependency-bearing independent roots. Do not temporarily bypass current same-batch SQL/HTTP authority checks.
4. Immediate compatible extension with no hold-and-wait; subsequently review cycle-checked waits, cross-owner service ownership and external binding as distinct work.

For implementation slices: small native functional scenarios and disposable browser checks, zero-diagnostic Biome, whole-project type-check, applicable full tests/build/compiled help, legacy boundary gates and honest Desloppify measurements. Do not add a fixture matrix to simulate the proposed scheduler, use real credentials/providers/engines/clusters, restart existing apps, import legacy runtime/storage, or describe a passing fixture/score as parity.
