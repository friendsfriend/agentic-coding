// The transactional kernel: `WorkflowEngine`'s public API (start, dispatch,
// status, list, capability issuance/authorization delegates, effect
// claiming) and the `reduce()` command-type dispatch table that replaces the
// former private-method branch chain. Every reducer, and every leaf helper
// (store/evidence/capability/dialogue/migration/view/kernel), is imported
// rather than reimplemented here — this file is the residue once all of
// that is moved out.
//
// Migrated to Effect (migrate-workflow-runtime-to-effect): each public
// operation is an Effect program that requires the concrete `WorkflowStore`
// and `WorkflowClock` services, provided at the engine composition root via
// `engineLayer`. The class keeps its historical synchronous signatures as the
// retained in-process boundary: the CLI, dashboard, drain runner, and focused
// tests compose the same operations without a nested runtime, and the facade
// consumes the root-owned application layer (complete-workflow-effect-cutover).
// Every operation is also exposed as a public Effect program (`startEffect`, …)
// for callers that run at the named application composition root directly.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cause, Chunk, Effect, Exit, type Layer, Option } from "effect";
import {
	decodeCommand,
	decodeSnapshot,
	type WorkflowCommand,
	type WorkflowRun,
	WorkflowRuntimeError,
	type WorkflowSnapshot,
	type WorkflowView,
} from "../contracts.ts";
import { decodePlanResult } from "../definitions/contracts.ts";
import { effectiveManifestPolicy } from "../definitions.ts";
import {
	childTrace,
	parseTraceparent,
	redactTelemetryText,
	telemetryEnvelope,
	traceparent,
} from "../observability.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { ensureBundle, wikiRoot } from "../wiki.ts";
import {
	authorizeAgentCapability as capabilityAuthorizeAgentCapability,
	authorizeExactRunCapability as capabilityAuthorizeExactRunCapability,
	issueRunCapability as capabilityIssueRunCapability,
	hashToken,
	prepareHandoffArtifact,
} from "./capability.ts";
import type {
	ClaimedEffect,
	DispatchResult,
	MigrationPreview,
	RepairPreview,
	StartWorkflowInput,
} from "./engine-types.ts";
import {
	changedFilesIn,
	currentBranch,
	sourceContentFingerprint,
	validateSourceBaseline,
	validateStartEvidence,
	wikiBaselineFor,
} from "./evidence.ts";
import {
	enqueue,
	enterStep,
	freshStep,
	validateFusionRouting,
} from "./kernel.ts";
import { type LegacyMigrationTelemetry, migrateLegacy } from "./migration.ts";
import { agentAnswer, agentAsk } from "./reducers/agent-consult.ts";
import {
	agentHandoff,
	type PreparedHandoffEvidence,
} from "./reducers/agent-handoff.ts";
import {
	agentQuestion,
	expireQuestion,
	expireQuestionTimer,
} from "./reducers/agent-question.ts";
import { developerAction } from "./reducers/developer-action.ts";
import { effectResult } from "./reducers/effect-result.ts";
import { migrate, repair, repin, resume } from "./reducers/repair.ts";
import { recordResearchHandoff } from "./reducers/research-handoff.ts";
import type { WorkflowClock } from "./services.ts";
import {
	engineLayer,
	toRuntimeError,
	WorkflowStore,
	WorkflowTelemetry,
} from "./services.ts";
import { prepareStepEvidence } from "./step-evidence.ts";
import {
	type EffectRow,
	effectFromRow,
	type InstanceRow,
	instance,
	json,
	nowIso,
	payload,
	type RunRow,
	runs,
	activeRunForRole as storeActiveRunForRole,
	effectIsLive as storeEffectIsLive,
	getRun as storeGetRun,
	getSnapshot as storeGetSnapshot,
	renewEffect as storeRenewEffect,
	tableExists,
	validateEffect,
	validateSnapshot,
	writeSnapshot,
} from "./store.ts";
import {
	canonicalRepository,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	validateWorkflowId,
	wikiWorkflowDataRoot,
} from "./targets.ts";
import {
	viewById,
	list as viewList,
	previewMigration as viewPreviewMigration,
	previewRepair as viewPreviewRepair,
	status as viewStatus,
} from "./view.ts";

interface CommittedDispatch {
	snapshot: WorkflowSnapshot;
	event: { type: string; actor: unknown; data: unknown };
	/** Pre- and post-command status, resolved inside the commit transaction so
	 * telemetry never re-reads the store (D1). */
	statusBefore: WorkflowSnapshot["status"];
	/** Identity and bounded payload resolved from the committed event data, the
	 * snapshot, and the affected run/effect row. */
	telemetry: CommittedTelemetry;
}
interface CommittedTelemetry {
	runId?: string;
	stepId?: string;
	role?: string;
	profile?: string;
	runtime?: string;
	sessionId?: string;
	effectId?: string;
	effectKind?: string;
	attempt?: number;
	outcome?: "ok" | "error";
	durationMs?: number;
	payload: Record<string, unknown>;
	/** Present when the command made the workflow terminal: the payload of the
	 * one best-effort `workflow.rollup` event (D2). */
	rollupPayload?: Record<string, unknown>;
}
interface ExhaustedTelemetry {
	snapshot: WorkflowSnapshot;
	effectId: string;
	kind: string;
	attempts: number;
	maxAttempts: number;
	diagnostic: string;
	rollup: Record<string, unknown>;
}
interface PreparedStart {
	snapshot: WorkflowSnapshot;
	storeTarget: string;
	sameCheckout: boolean;
}

const TERMINAL_STATUSES = new Set([
	"completed",
	"closed",
	"attention-required",
]);
const MAX_DIGEST_ATTRIBUTE = 16;

/** Bounded error class: the store's own bounded-error text, never raw text from
 * an untrusted provider. */
function errorClass(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = typeof value === "string" ? value : String(value);
	// Error text can originate from subprocess stderr or a remote URL; redact
	// credential shapes before the value is exported (SEC-002).
	const normalized = redactTelemetryText(text)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return normalized || undefined;
}

function truncatedDigest(value: unknown): string | undefined {
	return typeof value === "string" && value
		? value.slice(0, MAX_DIGEST_ATTRIBUTE)
		: undefined;
}

/** Normalized action category: a parameterized action such as
 * `retry-effect:<uuid>` reports its category without the variable identifier. */
function normalizedActionId(value: unknown): string {
	if (typeof value !== "string" || !value) return "unknown";
	const separator = value.indexOf(":");
	return separator > 0 ? value.slice(0, separator) : value;
}

export class WorkflowEngine {
	private readonly layer: ReturnType<typeof engineLayer>;
	constructor(
		readonly registry: WorkflowRegistry,
		private readonly now: () => Date = () => new Date(),
		private readonly onCommitted: (repository: string) => void = () => {},
		layer?: Layer.Layer<
			WorkflowStore | WorkflowClock | WorkflowTelemetry,
			never
		>,
	) {
		this.layer = layer ?? engineLayer(now);
	}
	/** Public live clock used for lease/expiry decisions — the same `now` that
	 * builds the store/clock layer. The effect runner schedules supervised
	 * lease renewal against this clock so execution and store share one time
	 * source (migrate-workflow-execution-to-effect). */
	readonly clock: () => Date = () => this.now();
	/** Run an Effect program synchronously at the engine composition boundary. */
	/** Run an Effect program synchronously at the engine composition boundary and
	 * surface its typed failure as the original `WorkflowRuntimeError` (or the
	 * underlying defect) rather than an Effect `FiberFailure`. */
	private run<A>(
		effect: Effect.Effect<
			A,
			WorkflowRuntimeError,
			WorkflowStore | WorkflowClock | WorkflowTelemetry
		>,
	): A {
		const exit = Effect.runSyncExit(effect.pipe(Effect.provide(this.layer)));
		if (Exit.isSuccess(exit)) return exit.value;
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure)) throw failure.value;
		const firstDefect = Chunk.head(Cause.defects(exit.cause));
		if (Option.isSome(firstDefect)) {
			const defect = firstDefect.value;
			if (defect instanceof WorkflowRuntimeError) throw defect;
			throw toRuntimeError(defect);
		}
		throw new WorkflowRuntimeError("unavailable", Cause.pretty(exit.cause));
	}
	/** Initialize the canonical store and, when addressed, import its legacy
	 * workflow outside any command transaction. */
	initialize(repo: string, workflowId?: string): void {
		this.run(this.initializeEffect(repo, workflowId));
	}
	/** Effect program for initializing the canonical store (and importing a
	 * legacy workflow when addressed); run at the named application
	 * composition root (complete-workflow-effect-cutover, task 2.1). */
	initializeEffect(
		repo: string,
		workflowId?: string,
	): Effect.Effect<
		void,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		return this.initializeProgram(repo, workflowId);
	}
	private initializeProgram(
		repo: string,
		workflowId?: string,
	): Effect.Effect<
		void,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			const store = yield* WorkflowStore;
			yield* store.initialize(repo);
			if (isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)) return;
			// Legacy import runs outside any command transaction: it owns its own
			// SQLite transaction control and must not run inside the service's
			// transaction primitive.
			const migrated = yield* store.write(repo, (db) => {
				const results: LegacyMigrationTelemetry[] = [];
				if (!tableExists(db, "workflows")) return results;
				const ids = workflowId
					? [workflowId]
					: (
							db.query("SELECT change_id FROM workflows").all() as Array<{
								change_id: string;
							}>
						).map((row) => row.change_id);
				for (const changeId of ids) {
					if (
						db
							.query("SELECT 1 FROM workflow_instances WHERE id=?")
							.get(changeId) ||
						db
							.query("SELECT 1 FROM workflow_instances WHERE change_id=?")
							.get(changeId)
					)
						continue;
					const item = migrateLegacy(
						db,
						canonicalRepository(repo),
						changeId,
						self.registry,
						self.now,
					);
					if (item) results.push(item);
				}
				return results;
			});
			for (const item of migrated)
				yield* self.telemetryEffect(item.snapshot, "legacy.migrated", {
					stepId: item.snapshot.currentStep,
					payload: {
						"herdr.source.version": item.sourceVersion,
						"herdr.migration.phase": item.phase,
						"herdr.workflow.type": item.workflowType,
					},
				});
		});
	}
	start(input: StartWorkflowInput): DispatchResult {
		return this.run(this.startEffect(input));
	}
	/** Effect program for starting a workflow; run at the named application
	 * composition root (complete-workflow-effect-cutover, task 2.1). */
	startEffect(
		input: StartWorkflowInput,
	): Effect.Effect<
		DispatchResult,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			const store = yield* WorkflowStore;
			const prepared = yield* Effect.try({
				try: () => self.resolveStart(input),
				catch: toRuntimeError,
			});
			yield* self.initializeProgram(prepared.storeTarget);
			const result = yield* store.transaction(prepared.storeTarget, (db) =>
				self.commitStart(db, input, prepared.snapshot, prepared.sameCheckout),
			);
			yield* self.telemetryEffect(result.snapshot, "workflow.started", {
				stepId: result.snapshot.currentStep,
				payload: self.startTelemetryPayload(result.snapshot),
			});
			self.onCommitted(prepared.storeTarget);
			return {
				snapshot: result.snapshot,
				view: viewById(
					prepared.storeTarget,
					result.snapshot.workflowId,
					self.registry,
					self.now,
				),
			};
		});
	}
	dispatch(repo: string, raw: unknown): DispatchResult {
		return this.run(this.dispatchEffect(repo, raw));
	}
	/** Effect program for dispatching a workflow command; run at the named
	 * application composition root (complete-workflow-effect-cutover, task 2.1). */
	dispatchEffect(
		repo: string,
		raw: unknown,
	): Effect.Effect<
		DispatchResult,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			const store = yield* WorkflowStore;
			const command = yield* Effect.try({
				try: () => decodeCommand(raw),
				catch: toRuntimeError,
			});
			// Legacy domain import is a write operation and intentionally happens
			// outside the command transaction. Observation never performs it.
			yield* self.initializeProgram(
				repo,
				"workflowId" in command ? command.workflowId : undefined,
			);
			// Read and validate bounded agent evidence before opening the writer
			// transaction. The reducer repeats the final integrity check after
			// reload so replacement during the race window is rejected.
			let preparedHandoff: PreparedHandoffEvidence | undefined;
			let handoffWorktree: string | undefined;
			if (command.type === "agent.handoff" && command.outcome === "complete") {
				const prepared = yield* Effect.try({
					try: () => self.prepareHandoff(repo, command),
					catch: toRuntimeError,
				});
				preparedHandoff = prepared.preparedHandoff;
				handoffWorktree = prepared.handoffWorktree;
			}
			if (command.type === "agent.handoff" && command.outcome === "complete") {
				yield* Effect.try({
					try: () => {
						const finalArtifact = prepareHandoffArtifact(
							repo,
							command,
							self.now,
							handoffWorktree,
						);
						if (
							preparedHandoff?.artifactDigest !== undefined &&
							(!finalArtifact ||
								finalArtifact.digest !== preparedHandoff.artifactDigest)
						)
							throw new WorkflowRuntimeError(
								"artifact",
								"artifact changed during final handoff binding",
							);
					},
					catch: toRuntimeError,
				});
			}
			const committed = yield* Effect.catchAll(
				store.transaction(repo, (db) =>
					self.commitDispatch(db, command, preparedHandoff),
				),
				(error) =>
					Effect.gen(function* () {
						if (
							error instanceof WorkflowRuntimeError &&
							[
								"unauthorized",
								"stale-run",
								"artifact",
								"stale-effect",
							].includes(error.code)
						) {
							const subject =
								command.type === "agent.handoff"
									? command.runId
									: command.type === "effect.result"
										? command.effectId
										: command.type;
							// The rejection audit is best-effort and runs separately from the
							// workflow transaction's rollback; it never fails the command.
							yield* Effect.catchAll(
								store.transaction(repo, (db) => {
									db.query(
										"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
									).run(
										randomUUID(),
										null,
										command.type,
										subject,
										error.message.slice(0, 2048),
										nowIso(self.now),
									);
								}),
								() => Effect.void,
							);
						}
						return yield* Effect.fail(error);
					}),
			);
			// Post-commit scheduling/telemetry is separated from the committed
			// command result: a continuation or notification failure here does not
			// imply the durable mutation was rolled back.
			yield* self.telemetryEffect(
				committed.snapshot,
				committed.event.type,
				committed.telemetry,
			);
			if (committed.telemetry.rollupPayload)
				yield* self.telemetryEffect(committed.snapshot, "workflow.rollup", {
					stepId: committed.snapshot.currentStep,
					payload: committed.telemetry.rollupPayload,
				});
			self.onCommitted(
				isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
					? wikiRoot(true)
					: canonicalRepository(repo),
			);
			return {
				snapshot: committed.snapshot,
				view: viewById(
					repo,
					committed.snapshot.workflowId,
					self.registry,
					self.now,
				),
			};
		});
	}
	status(repo: string, workflowId: string): WorkflowView {
		return this.run(this.statusEffect(repo, workflowId));
	}
	/** Effect program for reading a workflow view; run at the named
	 * application composition root (complete-workflow-effect-cutover, task 2.1). */
	statusEffect(
		repo: string,
		workflowId: string,
	): Effect.Effect<WorkflowView, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => viewStatus(repo, workflowId, this.registry, this.now),
			catch: toRuntimeError,
		});
	}
	previewRepair(repo: string, workflowId: string): RepairPreview[] {
		return this.run(this.previewRepairEffect(repo, workflowId));
	}
	previewRepairEffect(
		repo: string,
		workflowId: string,
	): Effect.Effect<RepairPreview[], WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => viewPreviewRepair(repo, workflowId, this.registry),
			catch: toRuntimeError,
		});
	}
	previewMigration(
		repo: string,
		workflowId: string,
		targetVersion: number,
	): MigrationPreview {
		return this.run(
			this.previewMigrationEffect(repo, workflowId, targetVersion),
		);
	}
	previewMigrationEffect(
		repo: string,
		workflowId: string,
		targetVersion: number,
	): Effect.Effect<MigrationPreview, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () =>
				viewPreviewMigration(repo, workflowId, targetVersion, this.registry),
			catch: toRuntimeError,
		});
	}
	effectIsLive(repo: string, effectId: string, lease: string): boolean {
		return this.run(this.effectIsLiveEffect(repo, effectId, lease));
	}
	effectIsLiveEffect(
		repo: string,
		effectId: string,
		lease: string,
	): Effect.Effect<boolean, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => storeEffectIsLive(repo, effectId, lease, this.now),
			catch: toRuntimeError,
		});
	}
	renewEffect(
		repo: string,
		effectId: string,
		lease: string,
		leaseMs = 30_000,
	): boolean {
		return this.run(this.renewEffectEffect(repo, effectId, lease, leaseMs));
	}
	renewEffectEffect(
		repo: string,
		effectId: string,
		lease: string,
		leaseMs = 30_000,
	): Effect.Effect<
		boolean,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			if (!Number.isFinite(leaseMs) || leaseMs <= 0)
				throw new WorkflowRuntimeError(
					"invalid-input",
					"lease duration must be positive",
				);
			yield* self.initializeProgram(repo);
			return yield* Effect.try({
				try: () => storeRenewEffect(repo, effectId, lease, leaseMs, self.now),
				catch: toRuntimeError,
			});
		});
	}
	claimEffects(repo: string, limit = 10, leaseMs = 30_000): ClaimedEffect[] {
		return this.run(this.claimEffectsEffect(repo, limit, leaseMs));
	}
	claimEffectsEffect(
		repo: string,
		limit = 10,
		leaseMs = 30_000,
	): Effect.Effect<
		ClaimedEffect[],
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			const store = yield* WorkflowStore;
			yield* self.initializeProgram(repo);
			const result = yield* store.transaction(repo, (db) =>
				self.commitClaim(db, limit, leaseMs),
			);
			// Several expired effects of one workflow can exhaust in a single
			// claim; each still exports its own `effect.exhausted`, but the
			// terminal `workflow.rollup` is emitted once per workflow (OPENSPEC-006).
			const rolledUp = new Set<string>();
			for (const item of result.exhausted) {
				yield* self.telemetryEffect(item.snapshot, "effect.exhausted", {
					effectId: item.effectId,
					stepId: item.snapshot.currentStep,
					attempt: item.attempts,
					outcome: "error",
					payload: {
						"herdr.effect.kind": item.kind,
						"herdr.effect.attempt": item.attempts,
						"herdr.effect.max_attempts": item.maxAttempts,
						"herdr.error.class": errorClass(item.diagnostic) ?? "exhausted",
						"herdr.attention.count": item.snapshot.attention.length,
					},
				});
				if (rolledUp.has(item.snapshot.workflowId)) continue;
				rolledUp.add(item.snapshot.workflowId);
				yield* self.telemetryEffect(item.snapshot, "workflow.rollup", {
					stepId: item.snapshot.currentStep,
					payload: item.rollup,
				});
			}
			return result.claimed;
		});
	}
	issueRunCapability(repo: string, runId: string): string {
		return this.run(this.issueRunCapabilityEffect(repo, runId));
	}
	issueRunCapabilityEffect(
		repo: string,
		runId: string,
	): Effect.Effect<
		string,
		WorkflowRuntimeError,
		WorkflowStore | WorkflowTelemetry
	> {
		const self = this;
		return Effect.gen(function* () {
			yield* self.initializeProgram(repo);
			return yield* Effect.try({
				try: () => capabilityIssueRunCapability(repo, runId),
				catch: toRuntimeError,
			});
		});
	}
	list(repo: string): WorkflowView[] {
		return this.run(this.listEffect(repo));
	}
	/** Effect program for reading every workflow view; run at the named
	 * application composition root (complete-workflow-effect-cutover, task 2.1). */
	listEffect(
		repo: string,
	): Effect.Effect<WorkflowView[], WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => viewList(repo, this.registry, this.now),
			catch: toRuntimeError,
		});
	}
	getRun(repo: string, runId: string): WorkflowRun {
		return this.run(this.getRunEffect(repo, runId));
	}
	getRunEffect(
		repo: string,
		runId: string,
	): Effect.Effect<WorkflowRun, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => storeGetRun(repo, runId),
			catch: toRuntimeError,
		});
	}
	// See store.ts's `activeRunForRole` doc comment for why this resolves by
	// (workflowId, stepId, role) rather than a client-supplied
	// runId/generation/token.
	activeRunForRole(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
	): WorkflowRun {
		return this.run(
			this.activeRunForRoleEffect(repo, workflowId, stepId, role),
		);
	}
	activeRunForRoleEffect(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
	): Effect.Effect<WorkflowRun, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => storeActiveRunForRole(repo, workflowId, stepId, role),
			catch: toRuntimeError,
		});
	}
	/** Validate the launch-bound capability for a role-scoped CLI operation. */
	authorizeAgentCapability(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
		token: string,
	): WorkflowRun {
		return this.run(
			this.authorizeAgentCapabilityEffect(
				repo,
				workflowId,
				stepId,
				role,
				token,
			),
		);
	}
	authorizeAgentCapabilityEffect(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
		token: string,
	): Effect.Effect<WorkflowRun, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () =>
				capabilityAuthorizeAgentCapability(
					repo,
					workflowId,
					stepId,
					role,
					token,
					this.registry,
					this.now,
				),
			catch: toRuntimeError,
		});
	}
	/** Validate a capability against the exact run that issued it. This is used
	 * by subprocess-facing commands; role-scoped lookup is intentionally not
	 * sufficient because a child process must not select a sibling run. */
	authorizeExactRunCapability(
		repo: string,
		workflowId: string,
		runId: string,
		stepId: string,
		role: string,
		token: string,
	): WorkflowRun {
		return this.run(
			this.authorizeExactRunCapabilityEffect(
				repo,
				workflowId,
				runId,
				stepId,
				role,
				token,
			),
		);
	}
	authorizeExactRunCapabilityEffect(
		repo: string,
		workflowId: string,
		runId: string,
		stepId: string,
		role: string,
		token: string,
	): Effect.Effect<WorkflowRun, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () =>
				capabilityAuthorizeExactRunCapability(
					repo,
					workflowId,
					runId,
					stepId,
					role,
					token,
					this.registry,
					this.now,
				),
			catch: toRuntimeError,
		});
	}
	getSnapshot(repo: string, workflowId: string): WorkflowSnapshot {
		return this.run(this.getSnapshotEffect(repo, workflowId));
	}
	getSnapshotEffect(
		repo: string,
		workflowId: string,
	): Effect.Effect<WorkflowSnapshot, WorkflowRuntimeError, never> {
		return Effect.try({
			try: () => storeGetSnapshot(repo, workflowId, this.registry, this.now),
			catch: toRuntimeError,
		});
	}

	// ---- synchronous orchestration helpers (run inside Effect programs) ----

	private resolveStart(input: StartWorkflowInput): PreparedStart {
		validateWorkflowId(input.workflowId);
		// Resolved before the target-kind guard so the guard reads the pinned
		// definition's declared policy (design D1) instead of comparing
		// `input.definitionId` against a literal id or id array.
		const definition = this.registry.definition(
			input.definitionId,
			input.definitionVersion ?? 1,
		);
		const policy = effectiveManifestPolicy(definition);
		const wikiTarget = isWikiWorkflowTarget(input.repo);
		const researchTarget = isResearchWorkflowTarget(input.repo);
		const validTarget =
			policy.targetKind === "wiki"
				? wikiTarget
				: policy.targetKind === "research"
					? researchTarget
					: !wikiTarget && !researchTarget;
		if (!validTarget)
			throw new WorkflowRuntimeError(
				"start-guard",
				"the workflow target does not match its declared manifest policy",
			);
		const wikiOnlyTarget = wikiTarget;
		const repository = researchTarget
			? input.repositoryContext
				? canonicalRepository(input.repositoryContext)
				: ""
			: wikiOnlyTarget
				? ""
				: canonicalRepository(input.repo);
		// Keep an explicitly supplied worktree path for the workflow view while
		// resolving it separately for repository guards. On macOS, /var is a
		// symlink to /private/var; canonicalizing the stored path would make the
		// view differ from the path the caller supplied.
		const worktree = researchTarget
			? path.resolve(wikiWorkflowDataRoot())
			: wikiOnlyTarget
				? path.resolve(ensureBundle())
				: input.worktree === undefined
					? fs.realpathSync(path.resolve(input.repo))
					: path.resolve(input.worktree);
		if (researchTarget) fs.mkdirSync(worktree, { recursive: true });
		const resolvedWorktree = fs.realpathSync(worktree);
		if (policy.requiresReadOnlyResearcher) {
			const route = input.routing.routes.find(
				(item) =>
					item.stepId === definition.initial && item.role === "researcher",
			);
			if (
				!route?.profile.readOnly ||
				!route.profile.capabilities.includes("read-only") ||
				route.profile.capabilities.includes("shell") ||
				route.profile.capabilities.includes("edit")
			)
				throw new WorkflowRuntimeError(
					"start-guard",
					"research requires a read-only researcher profile without shell or edit capabilities",
				);
		}
		// Distinct from `policy.checkoutRequired`: this decides whether start
		// seeds a source-content baseline, not whether checkout mode is
		// required — `openspec-propose`/`openspec-fusion-propose` also require
		// checkout but never seed this baseline.
		const wikiOnly = definition.id === "wiki";
		if (researchTarget && !input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				"research requires non-empty task",
			);
		const sameCheckout = policy.checkoutRequired;
		if (sameCheckout) {
			if (input.mode !== "checkout")
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows require checkout mode",
				);
			if (resolvedWorktree !== repository)
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows must use the repository checkout",
				);
			const branch = currentBranch(repository);
			if (!branch || input.metadata.branch !== branch)
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows require the named current branch",
				);
		}
		if (!wikiOnlyTarget && !researchTarget)
			validateStartEvidence(repository, input, sameCheckout);
		if (
			["openspec-fusion-full", "openspec-fusion-propose"].includes(
				definition.id,
			)
		)
			validateFusionRouting(definition.id, input.routing);
		const at = nowIso(this.now);
		const workflowId = input.workflowId;
		// No change identifier exists at start: the planner chooses the change
		// id(s) during the plan step, and the engine records the declared
		// primary into metadata.changeId at plan handoff. `openspec-apply` has
		// no planner step, so its pre-existing change is the workflow id itself.
		const startChangeId =
			input.definitionId === "openspec-apply" ? input.workflowId : "";
		const snapshot: WorkflowSnapshot = {
			schemaVersion: 1,
			workflowId,
			revision: 0,
			definition: {
				id: definition.id,
				version: definition.version,
				digest: definition.digest,
				...(definition.stepRefs ? { stepRefs: definition.stepRefs } : {}),
			},
			status: "active",
			currentStep: definition.initial,
			step: {
				...freshStep(1),
				...(input.context === undefined
					? {}
					: { context: payload(input.context) }),
			},
			metadata: {
				...input.metadata,
				repository,
				worktree,
				changeId: startChangeId,
				createdAt: at,
				updatedAt: at,
				stepEnteredAt: at,
				...(definition.steps.includes("core.wiki") ||
				definition.id === "research"
					? { wikiRoot: path.resolve(wikiRoot()) }
					: {}),
			},
			routing: input.routing,
			evidence: [],
			loopCounts: {},
			attention: [],
			developerDialogue: [],
			...(wikiOnly || (researchTarget && repository)
				? {
						sourceBaseline: {
							fingerprint: sourceContentFingerprint(
								repository,
								path.resolve(wikiRoot()),
							),
						},
					}
				: {}),
			...(wikiOnlyTarget
				? { wikiBaseline: wikiBaselineFor(worktree, input.context) }
				: {}),
		};
		validateSnapshot(snapshot, definition, [], this.registry);
		const storeTarget =
			wikiOnlyTarget || researchTarget ? input.repo : repository;
		return { snapshot, storeTarget, sameCheckout };
	}

	private commitStart(
		db: import("bun:sqlite").Database,
		input: StartWorkflowInput,
		snapshot: WorkflowSnapshot,
		sameCheckout: boolean,
	): { snapshot: WorkflowSnapshot; event: { type: string; data: unknown } } {
		if (
			db
				.query("SELECT 1 FROM workflow_instances WHERE id=?")
				.get(input.workflowId)
		)
			throw new WorkflowRuntimeError(
				"already-exists",
				`workflow already exists: ${input.workflowId}`,
			);
		// Sample the creation timestamp after the writer lock is acquired so the
		// durable timestamps never reflect time spent waiting for it.
		const at = nowIso(this.now);
		snapshot.metadata.createdAt = at;
		snapshot.metadata.updatedAt = at;
		snapshot.metadata.stepEnteredAt = at;
		db.query(
			"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			input.workflowId,
			snapshot.metadata.changeId,
			snapshot.metadata.repository,
			snapshot.metadata.worktree,
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
			0,
			snapshot.status,
			snapshot.currentStep,
			json(snapshot),
			at,
			at,
		);
		const event = {
			type: "workflow.started",
			data: { definition: snapshot.definition },
		};
		db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
			input.workflowId,
			0,
			event.type,
			json({ kind: "developer" }),
			json(event.data),
			at,
		);
		const definition = this.registry.definition(
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		const wikiOnlyTarget = isWikiWorkflowTarget(input.repo);
		const researchTarget = isResearchWorkflowTarget(input.repo);
		if (input.mode || wikiOnlyTarget || researchTarget)
			enqueue(
				db,
				snapshot,
				"workspace.setup",
				`workspace:${input.workflowId}:setup`,
				{
					mode: input.mode ?? (researchTarget ? "research" : "wiki"),
					sameCheckout,
					branch: snapshot.metadata.branch,
					baseCommit: snapshot.metadata.baseCommit,
					...(wikiOnlyTarget ? { wikiRoot: snapshot.metadata.worktree } : {}),
				},
			);
		else enterStep(db, snapshot, definition, this.registry, this.now);
		writeSnapshot(db, snapshot);
		return { snapshot, event };
	}

	/** `workflow.started` payload: the definition identity and the bounded start
	 * metadata the snapshot already carries (task 2.8). */
	private startTelemetryPayload(
		snapshot: WorkflowSnapshot,
	): Record<string, unknown> {
		const repository = snapshot.metadata.repository;
		return {
			"herdr.definition.id": snapshot.definition.id,
			"herdr.definition.version": snapshot.definition.version,
			// `workflowId` is already mapped to `herdr.change.id` by the parser, so
			// the OpenSpec change id uses a distinct key to avoid a duplicate span
			// attribute (QUAL-007).
			...(snapshot.metadata.changeId
				? { "herdr.metadata.change.id": snapshot.metadata.changeId }
				: {}),
			"herdr.repository.independent": !repository,
			...(repository ? { "herdr.repository": path.basename(repository) } : {}),
			"herdr.task.length": (snapshot.metadata.task ?? "").length,
			...(snapshot.metadata.branch
				? { "herdr.branch": snapshot.metadata.branch }
				: {}),
			...(snapshot.metadata.baseCommit
				? { "herdr.base.commit": snapshot.metadata.baseCommit.slice(0, 40) }
				: {}),
		};
	}

	private prepareHandoff(
		repo: string,
		command: Extract<WorkflowCommand, { type: "agent.handoff" }>,
	): { preparedHandoff: PreparedHandoffEvidence; handoffWorktree: string } {
		const observedRun = storeGetRun(repo, command.runId);
		const observed = storeGetSnapshot(
			repo,
			observedRun.workflowId,
			this.registry,
			this.now,
		);
		const handoffWorktree =
			observed.definition.id === "wiki-comments"
				? wikiWorkflowDataRoot()
				: observed.metadata.worktree;
		const preparedArtifact = prepareHandoffArtifact(
			repo,
			command,
			this.now,
			handoffWorktree,
		);
		const evidenceStep = this.registry.stepForDefinition(
			this.registry.definition(
				observed.definition.id,
				observed.definition.version,
				observed.definition.digest,
			),
			observed.currentStep,
		);
		let evidenceSnapshot = observed;
		if (
			preparedArtifact &&
			(observed.currentStep === "core.plan" ||
				observed.currentStep === "fusion.consolidate")
		) {
			let primaryChangeId: string;
			try {
				primaryChangeId = decodePlanResult(
					preparedArtifact.output,
				).primaryChangeId;
			} catch (error) {
				throw new WorkflowRuntimeError(
					"entry-guard",
					`plan output must declare a primary change id: ${String((error as Error).message)}`,
				);
			}
			evidenceSnapshot = {
				...observed,
				metadata: { ...observed.metadata, changeId: primaryChangeId },
			};
		}
		const preparedStepEvidence = prepareStepEvidence(evidenceSnapshot);
		if (evidenceStep.behavior?.validateEvidence)
			evidenceStep.behavior.validateEvidence({
				snapshot: evidenceSnapshot,
				evidence: preparedStepEvidence,
			});
		const sourceBaselineFingerprint =
			evidenceSnapshot.definition.id === "wiki" ||
			evidenceSnapshot.definition.id === "research"
				? validateSourceBaseline(evidenceSnapshot)
				: undefined;
		const preparedHandoff: PreparedHandoffEvidence = {
			stepEvidence: preparedStepEvidence,
			...(preparedArtifact
				? {
						artifactDigest: preparedArtifact.digest,
						artifactOutput: preparedArtifact.output,
					}
				: {}),
			...(observed.currentStep === "core.triage"
				? { changedFiles: changedFilesIn(observed) }
				: {}),
		};
		if (sourceBaselineFingerprint) {
			preparedHandoff.sourceFingerprint = sourceBaselineFingerprint;
			const finalSourceFingerprint = sourceContentFingerprint(
				observed.metadata.repository,
				observed.metadata.wikiRoot,
			);
			if (finalSourceFingerprint !== preparedHandoff.sourceFingerprint)
				throw new WorkflowRuntimeError(
					"source-isolation",
					"source content changed during handoff preparation",
				);
		}
		if (observed.currentStep === "core.triage") {
			const finalChangedFiles = changedFilesIn(observed);
			if (
				JSON.stringify(finalChangedFiles) !==
				JSON.stringify(preparedHandoff.changedFiles)
			)
				throw new WorkflowRuntimeError(
					"triage",
					"changed-file scope changed during handoff preparation",
				);
			preparedHandoff.changedFiles = finalChangedFiles;
		}
		return { preparedHandoff, handoffWorktree };
	}

	private commitDispatch(
		db: import("bun:sqlite").Database,
		command: WorkflowCommand,
		preparedHandoff?: PreparedHandoffEvidence,
	): CommittedDispatch {
		const located = this.locate(db, command);
		const snapshot = decodeSnapshot(JSON.parse(located.snapshot_json));
		const repin =
			command.type === "operator.repin" ||
			(command.type === "developer.action" && command.actionId === "re-pin");
		const migration = command.type === "operator.migrate";
		const definition = repin
			? this.registry.definition(
					snapshot.definition.id,
					snapshot.definition.version,
				)
			: this.registry.definition(
					snapshot.definition.id,
					snapshot.definition.version,
					snapshot.definition.digest,
				);
		const targetDefinition = migration
			? this.registry.definition(snapshot.definition.id, command.targetVersion)
			: definition;
		if (
			repin &&
			((snapshot.definition.stepRefs !== undefined &&
				snapshot.definition.digest !== definition.digest) ||
				JSON.stringify(snapshot.definition.stepRefs ?? null) !==
					JSON.stringify(definition.stepRefs ?? null))
		)
			throw new WorkflowRuntimeError(
				"pin-mismatch",
				"semantic step pin changed; use validated migration instead of repin",
			);
		const runList = runs(db, snapshot.workflowId);
		if (!repin) validateSnapshot(snapshot, definition, runList, this.registry);
		const statusBefore = snapshot.status;
		const stepBefore = snapshot.currentStep;
		const event = this.reduce(
			db,
			snapshot,
			definition,
			command,
			preparedHandoff,
		);
		snapshot.revision += 1;
		snapshot.metadata.updatedAt = nowIso(this.now);
		validateSnapshot(
			snapshot,
			targetDefinition,
			runs(db, snapshot.workflowId),
			this.registry,
		);
		writeSnapshot(db, snapshot);
		db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
			snapshot.workflowId,
			snapshot.revision,
			event.type,
			json(event.actor),
			json(event.data),
			nowIso(this.now),
		);
		return {
			snapshot,
			event,
			statusBefore,
			telemetry: this.buildDispatchTelemetry(
				db,
				command,
				event,
				snapshot,
				statusBefore,
				stepBefore,
				preparedHandoff,
			),
		};
	}

	/** Bounded identity and payload for one committed dispatch, resolved from
	 * the event, the snapshot, and the affected run/effect row. Strictly
	 * best-effort: an unresolvable field is omitted, never inferred, and this
	 * function never throws (D2). */
	private buildDispatchTelemetry(
		db: import("bun:sqlite").Database,
		command: WorkflowCommand,
		event: { type: string; actor: unknown; data: unknown },
		snapshot: WorkflowSnapshot,
		statusBefore: WorkflowSnapshot["status"],
		stepBefore: string,
		preparedHandoff?: PreparedHandoffEvidence,
	): CommittedTelemetry {
		const telemetry: CommittedTelemetry = {
			stepId: snapshot.currentStep,
			payload: {
				"herdr.revision": snapshot.revision,
				"herdr.status": snapshot.status,
			},
		};
		const runId =
			"runId" in command && typeof command.runId === "string"
				? command.runId
				: undefined;
		if (runId) {
			const row = db
				.query("SELECT * FROM workflow_runs WHERE id=?")
				.get(runId) as RunRow | null;
			if (row) {
				telemetry.runId = row.id;
				telemetry.stepId = row.step_id;
				telemetry.role = row.role;
				telemetry.attempt = row.attempt;
				try {
					const profile = JSON.parse(row.profile_json) as {
						name?: string;
						runtime?: string;
					};
					if (profile.name) telemetry.profile = profile.name;
					if (profile.runtime) telemetry.runtime = profile.runtime;
				} catch {
					/* omit profile identity */
				}
				if (row.handle_json) {
					try {
						const handle = JSON.parse(row.handle_json) as {
							sessionId?: string;
						};
						if (handle.sessionId) telemetry.sessionId = handle.sessionId;
					} catch {
						/* omit session identity */
					}
				}
				if (row.created_at && row.completed_at) {
					const wall =
						Date.parse(row.completed_at) - Date.parse(row.created_at);
					if (Number.isFinite(wall) && wall >= 0) telemetry.durationMs = wall;
				}
			}
		} else if (command.type === "effect.result") {
			telemetry.outcome = command.outcome === "complete" ? "ok" : "error";
			if (command.durationMs !== undefined)
				telemetry.durationMs = command.durationMs;
			const row = db
				.query("SELECT * FROM workflow_outbox WHERE id=?")
				.get(command.effectId) as EffectRow | null;
			if (row) {
				telemetry.effectId = row.id;
				telemetry.effectKind = row.kind;
				telemetry.attempt = row.attempts;
				telemetry.payload["herdr.effect.kind"] = row.kind;
				telemetry.payload["herdr.effect.attempt"] = row.attempts;
				telemetry.payload["herdr.effect.max_attempts"] = row.max_attempts;
				const cls = row.last_error ? errorClass(row.last_error) : undefined;
				if (cls) telemetry.payload["herdr.error.class"] = cls;
			}
		}
		if (event.type === "agent.handoff") {
			const data =
				event.data && typeof event.data === "object"
					? (event.data as { outcome?: string; outputDigest?: string })
					: {};
			const outcome = data.outcome ?? "unknown";
			telemetry.payload["herdr.handoff.outcome"] = outcome;
			telemetry.outcome =
				outcome === "complete" || outcome === "blocked" ? "ok" : "error";
			const digest = truncatedDigest(data.outputDigest);
			if (digest) telemetry.payload["herdr.artifact.digest"] = digest;
			if (preparedHandoff?.artifactOutput !== undefined)
				telemetry.payload["herdr.artifact.bytes"] = Buffer.byteLength(
					JSON.stringify(preparedHandoff.artifactOutput),
				);
			telemetry.payload["herdr.evidence.count"] = snapshot.evidence.length;
			if (snapshot.step.results.length) {
				let critical = 0;
				for (const item of snapshot.step.results)
					if (Number.isFinite(item.critical)) critical += item.critical;
				telemetry.payload["herdr.findings.critical"] = critical;
			}
		}
		if (event.type === "developer.action") {
			const data =
				event.data && typeof event.data === "object"
					? (event.data as { actionId?: string })
					: {};
			telemetry.payload["herdr.action.id"] = normalizedActionId(data.actionId);
			telemetry.payload["herdr.step.before"] = stepBefore;
			telemetry.payload["herdr.step.after"] = snapshot.currentStep;
		}
		if (
			event.type.startsWith("developer.question.") ||
			event.type.startsWith("agent.question.")
		)
			this.applyQuestionTelemetry(telemetry, event, snapshot);
		if (event.type === "research.handoff.recorded")
			this.applyResearchHandoffTelemetry(telemetry, command);
		if (command.type === "operator.repair") {
			telemetry.payload["herdr.step.from"] = stepBefore;
			telemetry.payload["herdr.step.to"] = snapshot.currentStep;
			telemetry.payload["herdr.reason.length"] = command.reason.length;
		}
		if (command.type === "operator.migrate") {
			// The reducer has already assigned the target pin, so the source
			// version comes from the recorded migration fact (QUAL-005).
			telemetry.payload["herdr.version.from"] =
				snapshot.migrated?.from.version ?? command.targetVersion;
			telemetry.payload["herdr.version.to"] = command.targetVersion;
			telemetry.payload["herdr.reason.length"] = command.reason.length;
		}
		if (
			command.type === "operator.repin" ||
			(command.type === "developer.action" && command.actionId === "re-pin")
		) {
			const from = truncatedDigest(snapshot.repinned?.fromDigest);
			if (from) telemetry.payload["herdr.digest.from"] = from;
			telemetry.payload["herdr.digest.to"] = truncatedDigest(
				snapshot.definition.digest,
			);
		}
		if (
			TERMINAL_STATUSES.has(snapshot.status) &&
			!TERMINAL_STATUSES.has(statusBefore)
		)
			telemetry.rollupPayload = this.rollupPayload(db, snapshot);
		return telemetry;
	}

	/** Question round-trip payload resolved from the dialogue record the reducer
	 * just updated (task 2.6). */
	private applyQuestionTelemetry(
		telemetry: CommittedTelemetry,
		event: { type: string; actor: unknown; data: unknown },
		snapshot: WorkflowSnapshot,
	): void {
		const data =
			event.data && typeof event.data === "object"
				? (event.data as {
						questionId?: string;
						groupId?: string;
						outcome?: string;
					})
				: {};
		const first = data.questionId
			? snapshot.developerDialogue.find((item) => item.id === data.questionId)
			: snapshot.developerDialogue.find(
					(item) => item.groupId === data.groupId,
				);
		const group = first?.groupId
			? snapshot.developerDialogue.filter(
					(item) => item.groupId === first.groupId,
				)
			: first
				? [first]
				: [];
		if (!first) return;
		telemetry.role = first.role;
		telemetry.payload["herdr.question.id"] =
			data.questionId ?? data.groupId ?? first.id;
		telemetry.payload["herdr.asking.role"] = first.role;
		telemetry.payload["herdr.option.count"] = group.reduce(
			(total, item) => total + item.options.length,
			0,
		);
		if (data.outcome) telemetry.payload["herdr.answer.outcome"] = data.outcome;
		telemetry.payload["herdr.timeout"] = event.type.endsWith("expired");
		const actor = event.actor as { kind?: string } | undefined;
		if (actor?.kind) telemetry.payload["herdr.answered.by"] = actor.kind;
		if (first.answeredAt) {
			const wait = Date.parse(first.answeredAt) - Date.parse(first.createdAt);
			if (Number.isFinite(wait) && wait >= 0) telemetry.durationMs = wait;
		}
		if (first.answer?.kind)
			telemetry.payload["herdr.answer.kind"] = first.answer.kind;
	}

	/** Structured research handoff counts taken from the authenticated command
	 * payload (task 2.8). */
	private applyResearchHandoffTelemetry(
		telemetry: CommittedTelemetry,
		command: WorkflowCommand,
	): void {
		if (command.type !== "agent.research-handoff") return;
		const handoff =
			command.handoff && typeof command.handoff === "object"
				? (command.handoff as {
						directives?: unknown;
						citations?: unknown;
					})
				: {};
		telemetry.payload["herdr.directives.count"] = Array.isArray(
			handoff.directives,
		)
			? handoff.directives.length
			: 0;
		telemetry.payload["herdr.citations.count"] = Array.isArray(
			handoff.citations,
		)
			? handoff.citations.length
			: 0;
	}

	/** One best-effort roll-up for the terminal transition (task 2.11). */
	private rollupPayload(
		db: import("bun:sqlite").Database,
		snapshot: WorkflowSnapshot,
	): Record<string, unknown> {
		const totals = db
			.query(
				"SELECT COUNT(*) AS runs, COUNT(DISTINCT role) AS agents FROM workflow_runs WHERE workflow_id=?",
			)
			.get(snapshot.workflowId) as { runs: number; agents: number };
		const attempts = db
			.query(
				"SELECT COALESCE(SUM(attempts),0) AS attempts FROM workflow_outbox WHERE workflow_id=?",
			)
			.get(snapshot.workflowId) as { attempts: number };
		return {
			"herdr.verification.rounds":
				snapshot.loopCounts["core.verification:round"] ?? 0,
			"herdr.revision.count": snapshot.revision,
			"herdr.run.count": totals.runs,
			"herdr.agent.count": totals.agents,
			"herdr.questions.count": snapshot.developerDialogue.length,
			"herdr.attention.count": snapshot.attention.length,
			"herdr.effect.attempts": attempts.attempts,
			"herdr.current.step": snapshot.currentStep,
		};
	}

	private commitClaim(
		db: import("bun:sqlite").Database,
		limit: number,
		leaseMs: number,
	): { claimed: ClaimedEffect[]; exhausted: ExhaustedTelemetry[] } {
		const claimed: ClaimedEffect[] = [];
		const exhausted: ExhaustedTelemetry[] = [];
		const at = this.now();
		const rows = db
			.query(
				`SELECT * FROM workflow_outbox AS ready WHERE ((ready.status IN ('pending','retry') AND ready.attempts < ready.max_attempts AND (ready.next_attempt_at IS NULL OR ready.next_attempt_at<=?)) OR (ready.status='running' AND ready.lease_expires_at<=?)) AND NOT (ready.kind IN ('delivery.commit','delivery.push') AND EXISTS (SELECT 1 FROM workflow_outbox AS promotion WHERE promotion.workflow_id=ready.workflow_id AND promotion.kind='wiki.verify' AND promotion.status<>'completed')) ORDER BY ready.rowid LIMIT ?`,
			)
			.all(at.toISOString(), at.toISOString(), limit) as EffectRow[];
		for (const row of rows) {
			const owner = instance(db, row.workflow_id);
			const snapshot = decodeSnapshot(JSON.parse(owner.snapshot_json));
			const definition = this.registry.definition(
				snapshot.definition.id,
				snapshot.definition.version,
				snapshot.definition.digest,
			);
			const runList = runs(db, snapshot.workflowId);
			validateSnapshot(snapshot, definition, runList, this.registry);
			validateEffect(row, snapshot, definition, runList, this.registry);
			if (row.status === "running" && row.attempts >= row.max_attempts) {
				const diagnostic = `effect ${row.kind} exhausted automatic attempts after lease expiry`;
				db.query(
					"UPDATE workflow_outbox SET status='failed', lease=NULL, lease_expires_at=NULL, last_error=? WHERE id=? AND status='running' AND lease_expires_at<=?",
				).run(diagnostic, row.id, at.toISOString());
				snapshot.revision += 1;
				snapshot.status = "attention-required";
				snapshot.attention = [diagnostic];
				snapshot.metadata.updatedAt = at.toISOString();
				validateSnapshot(snapshot, definition, runList, this.registry);
				writeSnapshot(db, snapshot);
				db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
					snapshot.workflowId,
					snapshot.revision,
					"effect.exhausted",
					json({ kind: "system", effectId: row.id }),
					json({ effectId: row.id, kind: row.kind, diagnostic }),
					at.toISOString(),
				);
				exhausted.push({
					snapshot: structuredClone(snapshot),
					effectId: row.id,
					kind: row.kind,
					attempts: row.attempts,
					maxAttempts: row.max_attempts,
					diagnostic,
					rollup: this.rollupPayload(db, snapshot),
				});
				continue;
			}
			const lease = randomUUID();
			const expires = new Date(at.getTime() + leaseMs).toISOString();
			db.query(
				"UPDATE workflow_outbox SET status='running', attempts=attempts+1, lease=?, lease_expires_at=? WHERE id=?",
			).run(lease, expires, row.id);
			const effect = {
				...effectFromRow({
					...row,
					status: "running",
					attempts: row.attempts + 1,
					lease,
					lease_expires_at: expires,
				}),
				lease,
			} as ClaimedEffect;
			if (effect.kind === "agent.launch") {
				const runId = String(
					(effect.payload as { runId?: string }).runId ?? "",
				);
				const run = runList.find((item) => item.id === runId);
				if (!run)
					throw new Error(`agent.launch references unknown run ${runId}`);
				if (!run.capabilityHash) {
					const token = randomBytes(32).toString("base64url");
					db.query(
						"UPDATE workflow_runs SET capability_hash=? WHERE id=? AND status IN ('pending','working')",
					).run(hashToken(token), runId);
					effect.runToken = token;
				}
			}
			claimed.push(effect);
		}
		return { claimed, exhausted };
	}

	/** Telemetry sink directory for one workflow snapshot. */
	private telemetryDirectory(snapshot: WorkflowSnapshot): string {
		// Repository-independent workflows (wiki review and research) write their
		// run env and bridge telemetry under the wiki data root; the engine must
		// share that directory so engine and runtime events correlate (QUAL-008).
		return snapshot.definition.id === "wiki-comments" ||
			snapshot.definition.id === "research"
			? path.join(wikiWorkflowDataRoot(), snapshot.workflowId)
			: path.join(
					snapshot.metadata.worktree,
					".herdr-workflow",
					snapshot.workflowId,
				);
	}

	private telemetryEffect(
		snapshot: WorkflowSnapshot,
		event: string,
		telemetry?: CommittedTelemetry,
	): Effect.Effect<void, never, WorkflowTelemetry> {
		const self = this;
		return Effect.gen(function* () {
			const service = yield* WorkflowTelemetry;
			const context = childTrace(parseTraceparent(process.env.TRACEPARENT));
			service.emit(
				self.telemetryDirectory(snapshot),
				telemetryEnvelope({
					layer: "engine",
					event,
					at: nowIso(self.now),
					workflowId: snapshot.workflowId,
					stepId: telemetry?.stepId ?? snapshot.currentStep,
					...(telemetry?.runId ? { runId: telemetry.runId } : {}),
					...(telemetry?.role ? { role: telemetry.role } : {}),
					...(telemetry?.profile ? { profile: telemetry.profile } : {}),
					...(telemetry?.runtime ? { runtime: telemetry.runtime } : {}),
					...(telemetry?.sessionId ? { sessionId: telemetry.sessionId } : {}),
					...(telemetry?.effectId ? { effectId: telemetry.effectId } : {}),
					...(telemetry?.outcome ? { outcome: telemetry.outcome } : {}),
					...(telemetry?.durationMs !== undefined
						? { durationMs: telemetry.durationMs }
						: {}),
					traceparent: traceparent(context),
					payload: {
						"herdr.revision": snapshot.revision,
						"herdr.status": snapshot.status,
						...(telemetry?.effectKind
							? { "herdr.effect.kind": telemetry.effectKind }
							: {}),
						// Only a resolved run has a run attempt; an effect's attempt count
						// lives in `herdr.effect.attempt` and must not be reported as a run
						// attempt (QUAL-006).
						...(telemetry?.runId !== undefined &&
						telemetry.attempt !== undefined
							? { "herdr.run.attempt": telemetry.attempt }
							: {}),
						...(telemetry?.payload ?? {}),
					},
				}),
			);
		});
	}

	private reduce(
		db: import("bun:sqlite").Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: WorkflowCommand,
		preparedHandoff?: PreparedHandoffEvidence,
	): { type: string; actor: unknown; data: unknown } {
		if (command.type === "developer.action")
			return developerAction(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "agent.question")
			return agentQuestion(db, snapshot, command, this.now);
		if (command.type === "agent.ask")
			return agentAsk(db, snapshot, command, this.now);
		if (command.type === "agent.answer")
			return agentAnswer(db, snapshot, command, this.now);
		if (command.type === "agent.question-expire")
			return expireQuestion(db, snapshot, command, this.now);
		if (command.type === "timer.question-expire")
			return expireQuestionTimer(db, snapshot, command, this.now);
		if (command.type === "agent.handoff")
			return agentHandoff(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
				preparedHandoff,
			);
		if (command.type === "agent.research-handoff")
			return recordResearchHandoff(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "effect.result")
			return effectResult(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "operator.repair")
			return repair(db, snapshot, definition, command, this.registry, this.now);
		if (command.type === "operator.migrate")
			return migrate(
				db,
				snapshot,
				definition,
				this.registry.definition(snapshot.definition.id, command.targetVersion),
				command,
				this.registry,
				this.now,
			);
		if (command.type === "operator.repin")
			return repin(db, snapshot, definition, command, this.registry, this.now);
		if (command.type === "operator.resume")
			return resume(db, snapshot, definition, command, this.registry, this.now);
		throw new WorkflowRuntimeError("invalid-command", "unsupported command");
	}
	private locate(
		db: import("bun:sqlite").Database,
		command: WorkflowCommand,
	): InstanceRow {
		if (command.type === "agent.handoff") {
			const row = db
				.query("SELECT workflow_id FROM workflow_runs WHERE id=?")
				.get(command.runId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "run not found");
			return instance(db, row.workflow_id);
		}
		if (command.type === "effect.result") {
			const row = db
				.query("SELECT workflow_id FROM workflow_outbox WHERE id=?")
				.get(command.effectId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "effect not found");
			return instance(db, row.workflow_id);
		}
		try {
			return instance(db, command.workflowId);
		} catch (error) {
			if (
				!(error instanceof WorkflowRuntimeError) ||
				error.code !== "not-found"
			)
				throw error;
			const row = db
				.query("SELECT id FROM workflow_instances WHERE change_id=?")
				.get(command.workflowId) as { id: string } | null;
			if (!row) throw error;
			return instance(db, row.id);
		}
	}
}
