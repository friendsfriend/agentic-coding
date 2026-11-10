import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { type Config, text } from "../config.ts";
import { ProviderApis } from "../providers/providers.ts";
import { Catalog, decode, type TaskInfo, values } from "../state.ts";
import { Acquisitions } from "./acquisitions.ts";
import type { LiveEnvironmentAuthority } from "./authority.ts";
import { loadProjects, projectView, resolvePlans } from "./catalog.ts";
import { CleanupUncertain, cleanupSchedule } from "./cleanup.ts";
import {
	createClusterNamespace,
	deleteClusterNamespace,
	inspectCluster,
	loadClusters,
	namespaceName,
	prepareCluster,
} from "./cluster.ts";
import type { ClusterInspection } from "./cluster-types.ts";
import { ComposeProcess } from "./compose.ts";
import {
	bindComposeDiagnostics,
	compileCompose,
	containerPlans,
} from "./compose-config.ts";
import { prepareVolumes } from "./compose-volumes.ts";
import { ContainerProcess } from "./container.ts";
import {
	declaredInfrastructure,
	qualifyBridgeExporter,
} from "./dependencies.ts";
import {
	belongsToOwner,
	DependencyWorkspaces,
} from "./dependency-workspaces.ts";
import { discoverDefinitions } from "./discovery.ts";
import { DefinitionDrafts } from "./drafts.ts";
import { HeldHttp } from "./http-manager.ts";
import type { HttpReceipt } from "./http-receipts.ts";
import { IdleLifecycle } from "./idle.ts";
import { KubernetesProcess } from "./kubernetes.ts";
import {
	independentRoot,
	operatorInfrastructure,
	referencedRoot,
	referenceRoot,
	sameApprovedPlan,
	scopedRoot,
	sharedRoot,
	validateLifetime,
} from "./lifetime.ts";
import { type LogOptions, logView } from "./logs.ts";
import { isShellRuntime, type Plan, type TelemetryOptions } from "./model.ts";
import {
	type OperatorRevocation,
	OperatorRevocations,
} from "./operator-revocation.ts";
import { OperatorUnitStarts } from "./operator-unit-start.ts";
import type { EnvironmentProcess } from "./process.ts";
import { DatabaseDiagnostics, type QueryReceipt } from "./query-manager.ts";
import {
	referenceGraphHistory,
	refreshReferenceGraphs,
} from "./reference-journal.ts";
import {
	batchApproved,
	referenceScope,
	requireScopeLive,
	requiringRoots,
} from "./reference-scope.ts";
import { runsConflict } from "./resources.ts";
import type { Action, Selection } from "./selection.ts";
import { processEnvironment, ShellProcess } from "./shell.ts";
import { assertReadyPortAvailable } from "./shell-readiness.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type OperatorUnitStop,
	type ReuseReceipt,
	type StopReceipt,
} from "./state.ts";
import { TelemetryCollector } from "./telemetry.ts";

import type { WaitReceipt } from "./wait.ts";

function recentRuns(runs: EnvironmentRun[], history: number) {
	const recent = new Set(
		runs
			.filter((run) => !holdsResource(run))
			.slice(-history)
			.map((run) => run.id),
	);
	return runs.filter((run) => holdsResource(run) || recent.has(run.id));
}
/** Native documents own admission/receipts. Only live handles may control processes.
 * Unknown effects after restart stay quarantined until authenticated inspection. */
export class Environments {
	readonly projects;
	readonly drafts: DefinitionDrafts;
	private dependencyWorkspaces: DependencyWorkspaces;
	readonly clusters;
	readonly http: HeldHttp;
	readonly database: DatabaseDiagnostics;
	readonly acquisitions: Acquisitions;
	readonly operator: OperatorRevocations;
	readonly unitStarts: OperatorUnitStarts;
	readonly providers: ProviderApis;
	readonly idle: IdleLifecycle;
	private engine: Harness | null = null;
	private live = new Map<string, EnvironmentProcess>();
	private revoked = new Set<number>();
	private closed = false;
	private closing: Promise<void> | null = null;
	private pending = new Map<
		Promise<unknown>,
		{ owner: number; batch: string; runId?: string }
	>();
	private stopped = new Set<string>();
	private stopOperations = new Map<
		string,
		{ request: string; operation: Promise<string[]> }
	>();
	private stoppedRoots = new Set<string>();
	private dependencyCleanup = new Map<number, Promise<void>>();
	get stateDir() {
		return this.config.stateDir;
	}
	constructor(private config: Config) {
		this.projects = loadProjects(config);
		this.dependencyWorkspaces = new DependencyWorkspaces(config.stateDir);
		this.drafts = new DefinitionDrafts(config, () => this.store);
		this.idle = new IdleLifecycle(config.configDir, {
			store: () => this.store,
			eligible: (run) => this.canIdleRun(run),
			pending: (owner, runId) =>
				[...this.pending.values()].some(
					(entry) =>
						entry.owner === owner &&
						(!runId || !entry.runId || entry.runId === runId),
				),
			latch: (runs, batches) => this.latchStop(runs, batches),
			stop: (runs, batches) => this.stopTargets(runs, batches, true),
		});
		this.clusters = loadClusters(config);
		this.acquisitions = new Acquisitions(config.stateDir, {
			store: () => this.store,
			check: (owner, signal, batch) => this.check(owner, signal, batch),
			receipt: (batch, owner, request) => this.receipt(batch, owner, request),
			execute: (batch, request, owner, plans, waitMs, signal, retain, poll) =>
				this.execute(
					batch,
					request,
					owner,
					plans,
					waitMs,
					signal,
					retain,
					poll,
				),
		});
		this.unitStarts = new OperatorUnitStarts({
			store: () => this.store,
			live: (run) => this.hasLiveAuthority(run) && this.live.has(run.id),
			check: (owner) => this.check(owner),
			pending: (owner) =>
				[...this.pending.values()].some(
					(entry) => entry.owner === owner && !entry.runId,
				),
		});
		this.operator = new OperatorRevocations({
			store: () => this.store,
			live: (run) => this.hasLiveAuthority(run),
			latch: (owner) => {
				this.revoked.add(owner);
				this.acquisitions.notify();
			},
			release: (owner) => this.releaseOwner(owner),
		});
		const authority: LiveEnvironmentAuthority = {
			store: () => this.store,
			records: () => this.records(),
			live: this.live,
			pending: this.pending,
			check: (owner, signal, batch, run) => {
				this.check(owner, signal, batch, run?.id);
				if (run) this.idle.touchRun(owner, run.id);
				else this.idle.touchOwner(owner);
			},
		};
		this.http = new HeldHttp(config, authority);
		this.database = new DatabaseDiagnostics(config, authority);
		this.providers = new ProviderApis(config, () => this.store);
	}
	async resolvePlans(
		owner: Pick<TaskInfo, "policy" | "repository" | "workspace"> & {
			id?: number;
		},
		apps: string[],
		action: Action,
		selection?: string | Selection,
	) {
		// Same-workspace plan inspection remains read-only after developer release;
		// preserve the existing exact-review audit, while execute still refuses.
		// Revoked owners may never mint dependency-workspace capabilities.
		if (owner.id !== undefined && !this.revoked.has(owner.id))
			this.check(owner.id);
		try {
			const plans = await resolvePlans(
				this.projects,
				owner,
				apps,
				action,
				selection,
				this.config.stateDir,
				owner.id !== undefined && this.revoked.has(owner.id)
					? undefined
					: this.dependencyWorkspaces,
			);
			if (
				owner.id !== undefined &&
				plans.some((plan) => plan.dependencyWorkspace)
			)
				this.check(owner.id);
			return plans;
		} catch (error) {
			if (owner.id !== undefined && this.revoked.has(owner.id))
				this.dependencyWorkspaces.forgetOwner(owner.id);
			throw error;
		}
	}
	discover(repository: string, owner?: TaskInfo, directory = ".") {
		return discoverDefinitions(this.config, repository, owner, directory);
	}
	prepareCluster(owner: TaskInfo, id: string) {
		const cluster = this.clusters.find((item) => item.id === id);
		if (!cluster)
			throw new Error("Choose an explicitly configured local cluster");
		return prepareCluster(this.config, owner, cluster);
	}
	async inspectCluster(
		owner: TaskInfo,
		inspection: ClusterInspection,
		signal?: AbortSignal,
	) {
		const batch = "cluster-status";
		const operation = (async () => {
			await this.store.commit(async (tx) => {
				this.check(owner.id, signal, batch);
				const task = await tx.task(owner.id as TaskId);
				if (!task || task.abortRequested || task.state.status === "terminal")
					throw new Error("Cluster inspection task has ended");
			}, background);
			this.check(owner.id, signal, batch);
			return inspectCluster(this.config, inspection, signal);
		})();
		this.pending.set(operation, { owner: owner.id, batch });
		try {
			return await operation;
		} finally {
			this.pending.delete(operation);
		}
	}
	private async clusterNamespaceOperation(
		owner: TaskInfo,
		batch: string,
		effect: (signal?: AbortSignal) => Promise<unknown>,
		signal?: AbortSignal,
	) {
		const operation = (async () => {
			await this.store.commit(async (tx) => {
				this.check(owner.id, signal, batch);
				const task = await tx.task(owner.id as TaskId);
				if (!task || task.abortRequested || task.state.status === "terminal")
					throw new Error("Cluster operation task has ended");
			}, background);
			this.check(owner.id, signal, batch);
			return effect(signal);
		})();
		this.pending.set(operation, { owner: owner.id, batch });
		try {
			return await operation;
		} finally {
			this.pending.delete(operation);
		}
	}
	async createClusterNamespace(
		owner: TaskInfo,
		inspection: ClusterInspection,
		raw: unknown,
		signal?: AbortSignal,
	) {
		const namespace = namespaceName(raw);
		return this.clusterNamespaceOperation(
			owner,
			"cluster-namespace",
			(signal) =>
				createClusterNamespace(this.config, inspection, namespace, signal),
			signal,
		);
	}
	async deleteClusterNamespace(
		owner: TaskInfo,
		inspection: ClusterInspection,
		raw: unknown,
		signal?: AbortSignal,
	) {
		const namespace = namespaceName(raw);
		return this.clusterNamespaceOperation(
			owner,
			"cluster-namespace",
			(signal) =>
				deleteClusterNamespace(this.config, inspection, namespace, signal),
			signal,
		);
	}
	private get store() {
		if (!this.engine) throw new Error("Environment manager not initialized");
		return this.engine;
	}
	async initialize(engine: Harness) {
		this.engine = engine;
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
			this.operator.recover(doc);
			doc.waits ??= {};
			for (const receipt of values<WaitReceipt>(doc.waits))
				if (receipt.state === "waiting")
					doc.waits[receipt.batch] = JSON.stringify({
						...receipt,
						state: "interrupted",
						revision: receipt.revision + 1,
					});
			for (const receipt of values<StopReceipt>(doc.stops))
				for (const batch of receipt.batches) this.stopped.add(batch);
			for (const run of values<EnvironmentRun>(doc.runs))
				if (run.state !== "exited") {
					run.state = "interrupted";
					if (run.runtimeStatus)
						run.runtimeStatus = {
							...run.runtimeStatus,
							state: "unknown",
							health: null,
							owned: null,
						};
					run.runtimeStatuses = run.runtimeStatuses?.map((status) => ({
						...status,
						state: "unknown",
						health: null,
						owned: null,
					}));
					run.revision++;
					run.error =
						"Host restarted with ambiguous environment effects. Inspect and stop/remove leftovers before releasing this resource. Saved PIDs, container IDs and labels are diagnostic only, never automatic cleanup/adoption authority.";
					doc.runs[run.id] = JSON.stringify(run);
				}
			refreshReferenceGraphs(doc);
		}, background);
	}
	private async records() {
		return values<EnvironmentRun>(
			(await this.store.snapshot(EnvironmentState, background))?.runs,
		);
	}
	private check(
		owner: number,
		signal?: AbortSignal,
		batch?: string,
		runId?: string,
	) {
		signal?.throwIfAborted();
		if (
			this.closed ||
			this.revoked.has(owner) ||
			(batch && this.stopped.has(batch)) ||
			(runId && this.stoppedRoots.has(runId))
		)
			throw new Error(
				"Environment owner or acquisition is closing or cancelled",
			);
	}
	async receipt(batch: string, owner: number, request: string) {
		const state = await this.store.snapshot(EnvironmentState, background),
			raw = state?.reuses?.[batch],
			reuse = raw ? decode<ReuseReceipt>(raw) : undefined;
		if (reuse && (reuse.owner !== owner || reuse.request !== request))
			throw new Error("Environment request identity mismatch");
		const runs = values<EnvironmentRun>(state?.runs).filter((run) =>
			reuse ? reuse.runs.includes(run.id) : run.batch === batch,
		);
		if (reuse && runs.length !== reuse.runs.length)
			throw new Error(
				"Reused environment receipt is incomplete; no replay authorized",
			);
		if (!runs.length) return null;
		if (
			runs.some(
				(run) => run.owner !== owner || (!reuse && run.request !== request),
			)
		)
			throw new Error("Environment request identity mismatch");
		return runs.map((run) => ({
			...this.visible(run, { output: true }),
			...(reuse
				? {
						acquisition: "already-held" as const,
						requestBatch: batch,
						reusedAt: reuse.createdAt,
					}
				: {}),
		}));
	}
	private async reuse(
		batch: string,
		request: string,
		owner: number,
		plans: Plan[],
		signal?: AbortSignal,
	) {
		return this.store.commit(async (tx) => {
			this.check(owner, signal, batch);
			const task = await tx.task(owner as TaskId);
			this.check(owner, signal, batch);
			if (!task || task.abortRequested || task.state.status === "terminal")
				throw new Error("Environment task has ended");
			const doc = await tx.doc(EnvironmentState);
			const previous = doc.reuses?.[batch];
			if (previous) {
				const saved = decode<ReuseReceipt>(previous);
				if (saved.owner !== owner || saved.request !== request)
					throw new Error("Environment request identity mismatch");
				return true;
			}
			const runs = values<EnvironmentRun>(doc.runs);
			const held = runs.filter(
				(run) =>
					run.owner === owner &&
					run.plan.action === "run" &&
					holdsResource(run),
			);
			if (
				held.length !== plans.length ||
				runs.some(
					(run) => run.batch === held[0]?.batch && run.state !== "running",
				) ||
				held.some((run) => run.batch !== held[0]?.batch) ||
				!plans.every((plan) =>
					held.some(
						(run) =>
							run.plan.app === plan.app &&
							JSON.stringify(run.plan) === JSON.stringify(plan) &&
							run.state === "running" &&
							!this.stopped.has(run.batch) &&
							!this.stoppedRoots.has(run.id) &&
							this.live.has(run.id) &&
							!this.live.get(run.id)?.outcome &&
							!this.live.get(run.id)?.cleanupFailed,
					),
				)
			)
				return false;
			doc.reuses ??= {};
			doc.reuses[batch] = JSON.stringify({
				owner,
				request,
				runs: held.map((run) => run.id),
				createdAt: Date.now(),
			} satisfies ReuseReceipt);
			return true;
		}, background);
	}
	private canIdleRun(run: EnvironmentRun) {
		const process = this.live.get(run.id);
		const statuses =
			process?.runtimeStatuses ??
			(process?.runtimeStatus ? [process.runtimeStatus] : []);
		return (
			!this.closed &&
			!this.revoked.has(run.owner) &&
			!this.stopped.has(run.batch) &&
			!this.stoppedRoots.has(run.id) &&
			run.state === "running" &&
			run.plan.action === "run" &&
			!!process &&
			!process.outcome &&
			!process.cleanupFailed &&
			(isShellRuntime(run.plan.runtime) || statuses.length > 0) &&
			statuses.every(
				(status) => status.owned === true && status.state === "running",
			)
		);
	}
	private hasLiveAuthority(run: EnvironmentRun) {
		return (
			!this.closed &&
			(this.live.has(run.id) ||
				[...this.pending.values()].some(
					(entry) => entry.owner === run.owner && entry.batch === run.batch,
				))
		);
	}
	/** An explicit replica selects one followed Kubernetes pod buffer; any
	 * other runtime, an unfollowed pod or an absent live run is refused
	 * instead of falling back to aggregate output. */
	private outputFor(run: EnvironmentRun, replica: number | undefined) {
		if (replica === undefined) return this.live.get(run.id)?.logs;
		const process = this.live.get(run.id);
		if (!process || process.outcome || process.cleanupFailed)
			throw new Error("Replica log selection requires a live running run");
		const selected =
			typeof (process as { logsFor?: unknown }).logsFor === "function"
				? (
						process as unknown as {
							logsFor: (replica: number) => string | undefined;
						}
					).logsFor(replica)
				: undefined;
		if (selected === undefined)
			throw new Error("Replica log selection names no followed pod");
		return selected;
	}
	private visible(
		run: EnvironmentRun,
		options: {
			output: boolean;
			services?: boolean;
			timing?: boolean;
			replica?: number;
		},
	) {
		const { output, services, timing } = options;
		const {
			output: stored,
			serviceLogs: storedServices,
			logTiming: storedTiming,
			...rest
		} = run;
		return {
			...rest,
			canRevoke:
				holdsResource(run) &&
				run.state !== "interrupted" &&
				this.hasLiveAuthority(run),
			endpoints:
				run.state === "running" &&
				run.ready === true &&
				this.live.get(run.id) instanceof ShellProcess &&
				!this.live.get(run.id)?.outcome &&
				!this.closed &&
				!this.revoked.has(run.owner) &&
				!this.stopped.has(run.batch) &&
				!this.stoppedRoots.has(run.id)
					? (run.plan.endpoints ?? {})
					: {},
			...(this.live.get(run.id)?.runtimeStatus
				? { runtimeStatus: this.live.get(run.id)?.runtimeStatus }
				: {}),
			...(this.live.get(run.id)?.runtimeStatuses
				? { runtimeStatuses: this.live.get(run.id)?.runtimeStatuses }
				: {}),
			...(output
				? { output: this.outputFor(run, options.replica) ?? stored }
				: {}),
			...(timing
				? { logTiming: this.live.get(run.id)?.logTiming ?? storedTiming }
				: {}),
			...(services
				? { serviceLogs: this.live.get(run.id)?.serviceLogs ?? storedServices }
				: {}),
		};
	}
	async snapshot(app?: string) {
		const state = await this.store.snapshot(EnvironmentState, background),
			all = values<EnvironmentRun>(state?.runs),
			operations = Object.entries(state?.httpOperations ?? {})
				.map(([id, raw]) => ({ id, receipt: decode<HttpReceipt>(raw) }))
				.filter(({ receipt }) => !app || receipt.approved.app === app);
		const protectedOwners = new Set(
			all
				.filter(holdsResource)
				.filter((run) => !this.canIdleRun(run))
				.map((run) => run.owner),
		);
		const idleScopes = new Map<
			number,
			{ runs: number; batches: Set<string> }
		>();
		for (const run of all.filter(holdsResource)) {
			const scope = idleScopes.get(run.owner) ?? {
				runs: 0,
				batches: new Set<string>(),
			};
			scope.runs++;
			scope.batches.add(run.batch);
			idleScopes.set(run.owner, scope);
		}
		return {
			runtime: "task-owned",
			revocations: values<OperatorRevocation>(state?.operatorRevocations)
				.filter(
					(receipt) =>
						!app ||
						all.some((run) => run.id === receipt.runId && run.plan.app === app),
				)
				.slice(-100),
			waitHistoryLimit: 200,
			waits: values<WaitReceipt>(state?.waits)
				.filter(
					(receipt) => !app || receipt.plans.some((plan) => plan.app === app),
				)
				.slice(-200)
				.map(({ plans, request: _request, ...receipt }) => ({
					...receipt,
					apps: plans.map((plan) => plan.app),
					live: this.acquisitions.entries.some(
						(waiter) => waiter.batch === receipt.batch,
					),
					authority:
						"diagnostic only; saved queue records never restore execution authority",
				})),
			queryHistoryLimit: 200,
			queryOperations: Object.entries(state?.queryOperations ?? {})
				.map(([id, raw]) => ({ id, receipt: decode<QueryReceipt>(raw) }))
				.filter(
					({ receipt }) =>
						!app ||
						receipt.approved.app === app ||
						receipt.approved.input.infra === app,
				)
				.slice(-200)
				.map(({ id, receipt }) => ({
					id,
					owner: receipt.owner,
					run: receipt.approved.run,
					app: receipt.approved.app,
					infra: receipt.approved.input.infra,
					state: receipt.state,
					issuedAt: receipt.issuedAt,
					observedAt: receipt.result?.observedAt,
					authority:
						"diagnostic only; issued means pending or uncertain, never execution, rollback or live authority",
				})),
			httpOperationsTotal: operations.length,
			httpHistoryLimit: 200,
			httpOperations: operations.slice(-200).map(({ id, receipt }) => ({
				id,
				owner: receipt.owner,
				run: receipt.approved.run,
				app: receipt.approved.app,
				endpoint: receipt.approved.endpoint,
				method: receipt.approved.http?.method ?? "GET",
				state: receipt.state,
				issuedAt: receipt.issuedAt,
				observedAt: receipt.result?.observedAt,
				authority:
					"diagnostic-only; issued means pending or uncertain, never dispatch/outcome or live authority",
			})),
			referenceGraphScope:
				"Partial observation-only shell coupled-batch journal: all unsettled plus newest 200 settled observations; no backfill or live/reference-control authority",
			referenceGraphHistoryLimit: 200,
			referenceGraphs: referenceGraphHistory(state?.referenceGraphs, app),
			clusters: this.clusters.map(({ id, repository, context }) => ({
				id,
				repository,
				context,
				probe: "not-performed",
			})),
			projects: this.projects
				.filter((project) => !app || project.id === app)
				.map(projectView),
			runs: recentRuns(
				all.filter((run) => !app || run.plan.app === app),
				200,
			).map((run) => ({
				...this.visible(run, { output: false }),
				idle: this.idle.view(run, {
					waiting: values<WaitReceipt>(state?.waits).some(
						(wait) => wait.owner === run.owner && wait.state === "waiting",
					),
					protectedBatch: protectedOwners.has(run.owner),
					ownerHeldRuns: idleScopes.get(run.owner)?.runs ?? 0,
					ownerBatches: idleScopes.get(run.owner)?.batches.size ?? 0,
				}),
			})),
			waiters: this.acquisitions.entries
				.filter((waiter) => !app || waiter.apps.includes(app))
				.map(({ plans: _plans, ...waiter }) => waiter),
		};
	}
	async logs(
		app: string,
		owner?: number,
		services = false,
		kind?: Plan["projectKind"],
		replica?: number,
	) {
		const all = await this.records();
		if (owner !== undefined) {
			// A prerequisite read belongs to its single live requiring root.
			const selected = all.find(
				(run) =>
					run.owner === owner && run.plan.app === app && holdsResource(run),
			);
			const requirers = selected ? requiringRoots(selected, all) : [],
				first = requirers[0];
			// A shared prerequisite renews every live root that declares it.
			if (first)
				for (const requirer of requirers)
					this.idle.touchRun(owner, requirer.id);
			else this.idle.touch(owner, app);
		}
		// An explicit replica reads the live run only: retained output is
		// aggregate and never a per-pod buffer.
		const scoped =
			replica === undefined
				? all
				: all.filter((run) => this.live.get(run.id) !== undefined);
		return recentRuns(
			scoped.filter(
				(run) =>
					run.plan.app === app &&
					(owner === undefined || run.owner === owner) &&
					(kind === undefined || run.plan.projectKind === kind),
			),
			20,
		)
			.sort(
				(a, b) =>
					Number(holdsResource(b)) - Number(holdsResource(a)) ||
					b.createdAt - a.createdAt,
			)
			.map((run) =>
				this.visible(run, { output: true, services, timing: true, replica }),
			);
	}
	async queryTelemetry(
		app: string,
		owner: number | undefined,
		options: TelemetryOptions,
		expectedRun?: string,
	) {
		const members = await this.records(),
			run = members.find(
				(record) =>
					record.plan.app === app &&
					(owner === undefined || record.owner === owner) &&
					(expectedRun === undefined || record.id === expectedRun) &&
					record.state === "running" &&
					record.ready === true &&
					holdsResource(record),
			);
		const process = run ? this.live.get(run.id) : undefined;
		if (!run || !process?.telemetry || process.outcome || process.cleanupFailed)
			throw new Error(
				"No owned live ready native telemetry run is held for this app",
			);
		this.check(run.owner, undefined, run.batch, run.id);
		// Referenced runs disclose and revalidate their exact generation closure.
		const telemetryState = await this.store.snapshot(
			EnvironmentState,
			background,
		);
		const root = referenceScope(
			run,
			members,
			batchApproved(telemetryState?.waits, run.batch, run.owner),
		);
		if (root) requireScopeLive(root, members, this.live);
		const requirers = requiringRoots(run, members),
			first = requirers[0];
		if (owner !== undefined)
			for (const requirer of first ? requirers : [run])
				this.idle.touchRun(owner, requirer.id);
		if (process instanceof ComposeProcess) await process.telemetryScope();
		this.check(run.owner, undefined, run.batch, run.id);
		const query = await process.telemetry.query(options);
		return root ? { ...query, root } : query;
	}
	async selectedLogs(
		app: string,
		owner: number | undefined,
		options: LogOptions,
	) {
		if (options.service !== undefined && options.replica !== undefined)
			throw new Error("Choose either a service or a replica log selector");
		if (
			options.replica !== undefined &&
			(!Number.isSafeInteger(options.replica) || options.replica < 0)
		)
			throw new Error("Replica log selection must be a non-negative index");
		return logView(
			app,
			(
				await this.logs(
					app,
					owner,
					options.service !== undefined,
					options.kind,
					options.replica,
				)
			).map((run) => ({
				...run,
				output: run.output ?? "",
			})),
			options,
		);
	}
	private async update(
		id: string,
		patch: Partial<
			Pick<
				EnvironmentRun,
				| "state"
				| "pid"
				| "exitCode"
				| "signal"
				| "output"
				| "logTiming"
				| "serviceLogs"
				| "error"
				| "runtimeStatus"
				| "runtimeStatuses"
				| "cleanupRetention"
			>
		>,
	) {
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				raw = doc.runs[id];
			if (!raw) throw new Error("Environment run missing");
			const run = decode<EnvironmentRun>(raw);
			if (
				run.inspection ||
				((run.state === "interrupted" || run.state === "exited") &&
					patch.state &&
					patch.state !== run.state)
			)
				return;
			doc.runs[id] = JSON.stringify({
				...run,
				...patch,
				revision: run.revision + 1,
			});
			if (patch.state) refreshReferenceGraphs(doc, run.batch);
		}, background);
		this.acquisitions.notify();
	}
	async execute(
		batch: string,
		request: string,
		owner: TaskInfo,
		plans: Plan[],
		waitMs: number,
		signal?: AbortSignal,
		retainQueue = false,
		pollId = batch,
	) {
		validateLifetime(plans, owner);
		if (
			plans.some(
				(plan) =>
					!belongsToOwner(plan, owner) ||
					(plan.dependencyWorkspace &&
						!this.projects.some(
							(project) =>
								project.id === plan.app &&
								project.repository === plan.dependencyWorkspace?.repository,
						)),
			)
		)
			throw new Error(
				"Environment plan has a foreign owner/repository workspace scope",
			);
		this.idle.observe(owner);
		const operation = this.perform(
			batch,
			request,
			owner,
			plans,
			waitMs,
			signal,
			retainQueue,
			pollId,
		);
		this.pending.set(operation, { owner: owner.id, batch });
		try {
			return await operation;
		} finally {
			this.pending.delete(operation);
		}
	}
	private async perform(
		batch: string,
		request: string,
		owner: TaskInfo,
		plans: Plan[],
		waitMs: number,
		signal: AbortSignal | undefined,
		retainQueue: boolean,
		pollId: string,
	) {
		this.check(owner.id, signal, batch);
		const recorded = await this.acquisitions.recordedWait(
			pollId,
			owner.id,
			batch,
			request,
			waitMs,
		);
		if (recorded) return recorded;
		const previous = await this.receipt(batch, owner.id, request);
		if (previous) return previous;
		if (!plans.length || plans.some((plan) => plan.action !== plans[0]?.action))
			throw new Error("Invalid environment batch");
		if (
			plans[0]?.action === "run" &&
			plans.some((plan, index) =>
				plans
					.slice(0, index)
					.some((other) => runsConflict(plan, other, this.config.stateDir)),
			)
		)
			throw new Error(
				"Requested apps overlap a container name or published port; no resources were acquired",
			);
		const resources = plans.flatMap(containerPlans);
		if (
			resources.some((plan, index) =>
				resources
					.slice(0, index)
					.some((other) => runsConflict(plan, other, this.config.stateDir)),
			)
		)
			throw new Error(
				"Requested services overlap a container name or published port; no resources were acquired",
			);
		if (
			plans[0]?.action === "run" &&
			(await this.reuse(batch, request, owner.id, plans, signal))
		) {
			this.idle.touch(owner.id);
			return this.receipt(batch, owner.id, request);
		}
		// Resolve referenced values only after approval, and fail before reserving or starting any app.
		for (const plan of plans) processEnvironment(this.config.configDir, plan);

		const allocation = await this.acquisitions.reserve(
			batch,
			request,
			owner,
			plans,
			waitMs,
			signal,
			retainQueue,
			pollId,
		);
		if (!allocation.reserved) return allocation.result;
		const running = plans[0]?.action === "run",
			attached = new Set(allocation.attached);
		try {
			for (const plan of plans) {
				this.check(owner.id, signal, batch);
				// A shared lifetime reuses the live generation it declared instead of
				// starting a second copy; the generation itself must still be the
				// original live handle at this point.
				if (attached.has(plan.app)) {
					// Revalidate inside the same native transaction that admits the
					// acquisition's own roots, so a stop latch recorded before this
					// point refuses the attach and one recorded after it is serialized
					// behind the admitted roots' own reference.
					await this.store.commit(async (tx) => {
						const doc = await tx.doc(EnvironmentState);
						this.check(owner.id, signal, batch);
						const shared = values<EnvironmentRun>(doc.runs).filter(
							(run) =>
								run.owner === owner.id &&
								run.plan.app === plan.app &&
								run.plan.projectKind === plan.projectKind &&
								run.batch !== batch &&
								run.state === "running" &&
								run.ready === true &&
								run.cleanupRetention === undefined,
						);
						if (shared.length !== 1)
							throw new Error(
								"Shared prerequisite generation closed before this acquisition completed; no second copy was started",
							);
						if (!sameApprovedPlan(shared[0].plan, plan))
							throw new Error(
								"Shared prerequisite generation changed plan before this acquisition completed; no attach and no second copy",
							);
					}, background);
					continue;
				}
				if (plan.dependencyWorkspace) {
					try {
						await this.dependencyWorkspaces.realize(plan, owner);
						if (plan.compose) {
							const rebuilt = prepareVolumes(
								qualifyBridgeExporter(this.projects, {
									...plan,
									composePlan: bindComposeDiagnostics(
										plan,
										compileCompose(plan.workspace, plan.compose),
									),
								}),
								this.config.stateDir,
							);
							if (!sameApprovedPlan(rebuilt, plan))
								throw new Error(
									"Dependency source changed from the approved plan",
								);
						}
					} catch {
						await this.update(`${batch}:${plan.app}`, {
							state: "interrupted",
							error:
								"Dependency workspace creation/identity could not be established; retained files and Git metadata require inspection. No command was dispatched for this member and no path was adopted.",
						});
						throw new Error("Dependency workspace unavailable");
					}
					this.check(owner.id, signal, batch);
				}
				if (plan.readyUrl) {
					await assertReadyPortAvailable(plan.readyUrl);
					signal?.throwIfAborted();
				}
				const id = `${batch}:${plan.app}`;
				let bridge:
					| Awaited<ReturnType<ComposeProcess["bridgeFor"]>>
					| undefined;
				const from = plan.compose?.networkFrom;
				if (from) {
					const declared = plans.find(
						(entry) => entry.app === from.app && entry.id === from.target,
					);
					const candidates = (await this.records()).filter(
						(run) =>
							run.owner === owner.id &&
							run.plan.app === from.app &&
							run.plan.id === from.target &&
							run.plan.projectKind === "infrastructure" &&
							run.state === "running" &&
							run.ready === true &&
							run.cleanupRetention === undefined,
					);
					const source = candidates.length === 1 ? candidates[0] : undefined;
					const original = source ? this.live.get(source.id) : undefined;
					if (
						!declared ||
						!source ||
						!plan.requires?.includes(from.app) ||
						plan.prerequisiteTargets?.[from.app] !== from.target ||
						!sameApprovedPlan(source.plan, declared) ||
						!(original instanceof ComposeProcess) ||
						!this.hasLiveAuthority(source)
					)
						throw new Error(
							"A prerequisite bridge needs the exact ready same-owner infrastructure generation in this approved graph; names and saved IDs grant no attachment authority",
						);
					this.check(owner.id, signal, source.batch, source.id);
					bridge = await original.bridgeFor(plan, signal);
					this.check(owner.id, signal, batch);
					this.check(owner.id, signal, source.batch, source.id);
				}
				const frozen = plan.telemetry
					? processEnvironment(this.config.configDir, plan)
					: undefined;
				const collector = frozen
					? new TelemetryCollector(
							{ app: plan.app, owner: owner.id, run: id },
							frozen.redact,
							plan.runtime === "compose"
								? { stateDir: this.config.stateDir }
								: undefined,
						)
					: undefined;
				let process: EnvironmentProcess;
				try {
					process = isShellRuntime(plan.runtime)
						? new ShellProcess(
								plan,
								this.config.configDir,
								undefined,
								collector && frozen
									? { collector, environment: frozen }
									: undefined,
							)
						: plan.runtime === "compose"
							? new ComposeProcess(
									plan,
									this.config.configDir,
									this.config.stateDir,
									id,
									collector,
									bridge,
								)
							: plan.runtime === "kubernetes"
								? new KubernetesProcess(this.config, plan, id)
								: new ContainerProcess(
										plan,
										this.config.configDir,
										this.config.stateDir,
										id,
									);
				} catch (error) {
					try {
						await collector?.close();
					} catch {
						await this.update(id, {
							state: "interrupted",
							error:
								"Native telemetry listener cleanup is uncertain; inspection required",
						});
					}
					throw error;
				}
				this.live.set(id, process);
				// Always attach finalization immediately, including startup/recording failure.
				void process.done
					.then(() => this.finish(id, process))
					.catch(() => {
						/* Keep the handle and durable lease on persistence failure. */
					});
				await this.update(id, { pid: process.pid });
				if (running) {
					await process.ready(signal);
					// Do not overwrite an exit receipt if the process ended at readiness.
					await this.store.commit(async (tx) => {
						const doc = await tx.doc(EnvironmentState),
							run = decode<EnvironmentRun>(doc.runs[id]);
						this.check(owner.id, signal, batch);
						if (run.state !== "reserved" || process.outcome)
							throw new Error(
								"Environment exited or was stopped during startup",
							);
						doc.runs[id] = JSON.stringify({
							...run,
							state: "running",
							revision: run.revision + 1,
							ready:
								!isShellRuntime(plan.runtime) || plan.readyText || plan.readyUrl
									? true
									: null,
							output: process.logs,
							...(process.logTiming ? { logTiming: process.logTiming } : {}),
							...(process.serviceLogs
								? { serviceLogs: process.serviceLogs }
								: {}),
							...(process.runtimeStatuses
								? { runtimeStatuses: process.runtimeStatuses }
								: {}),
							...(process.runtimeStatus
								? { runtimeStatus: process.runtimeStatus }
								: {}),
						});
						refreshReferenceGraphs(doc, batch);
					}, background);
				} else {
					await process.wait(signal);
					await this.finish(id, process);
				}
			}
			const result = await this.receipt(batch, owner.id, request);
			if (running && result?.some((run) => run.state !== "running"))
				throw new Error("An app exited before batch startup completed");
			for (const plan of plans)
				if (
					independentRoot(plan) ||
					(referencedRoot(plan) && referenceRoot(plan))
				)
					this.idle.trackRoot(owner.id, `${batch}:${plan.app}`, plan.app);
			return result;
		} catch {
			const selected = (await this.records()).filter(
				(run) => run.batch === batch && run.owner === owner.id,
			);
			this.latchStop(selected, [batch]);
			await this.cleanupTargets(selected, [batch]);
			for (const run of (await this.records()).filter(
				(run) => run.batch === batch && run.owner === owner.id,
			)) {
				if (run.cleanupRetention || run.state === "interrupted") continue;
				await this.update(run.id, {
					error: running
						? "Batch startup failed or was interrupted; inspect each run's exit and cleanup status."
						: "Action timed out, failed to start, or was interrupted; inspect the exit status and redacted output.",
				});
			}
			// Child output is available only through the redacted log path, never errors.
			throw new Error(
				"Environment execution did not complete; inspect env_status and env_logs",
			);
		}
	}
	private async finish(
		id: string,
		process: EnvironmentProcess,
		cleanup = false,
	) {
		const exit = await process.done;
		const cascade = await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				run = decode<EnvironmentRun>(doc.runs[id]);
			// An interrupted receipt is a quarantine latch; even a late exit cannot
			// release it or overwrite a subsequent authenticated inspection decision.
			if (run.state === "interrupted" || run.state === "exited") return null;
			// Callback exits must not release infrastructure ahead of dependents. Only
			// ordered live cleanup may finalize members of a coupled dependency batch.
			if (run.plan.dependencyBatch && !cleanup) {
				if (!referencedRoot(run.plan))
					return { batch: run.batch, owner: run.owner, targets: null };
				// A shared prerequisite is declared by roots of more than one
				// acquisition, so its loss invalidates every live one of them.
				const batchRuns = values<EnvironmentRun>(doc.runs).filter(
						(item) =>
							item.owner === run.owner &&
							item.plan.action === "run" &&
							(sharedRoot(run.plan) || item.batch === run.batch) &&
							holdsResource(item),
					),
					roots = batchRuns.filter((item) => referenceRoot(item.plan));
				// A released root keeps no reference; a lost prerequisite invalidates
				// every root that declared it. Ambiguous graphs fail closed.
				if (referenceRoot(run.plan))
					return { batch: run.batch, owner: run.owner, targets: [id] };
				try {
					const plans = batchRuns.map((item) => item.plan);
					return {
						batch: run.batch,
						owner: run.owner,
						targets: roots
							.filter((item) =>
								declaredInfrastructure(item.plan, plans).some(
									(plan) => plan.app === run.plan.app,
								),
							)
							.map((item) => item.id),
					};
				} catch {
					return {
						batch: run.batch,
						owner: run.owner,
						targets: roots.map((item) => item.id),
					};
				}
			}
			doc.runs[id] = JSON.stringify({
				...run,
				state: process.cleanupFailed ? "interrupted" : "exited",
				revision: run.revision + 1,
				exitCode: exit.code,
				signal: exit.signal,
				output: process.logs,
				...(process.logTiming ? { logTiming: process.logTiming } : {}),
				...(process.serviceLogs ? { serviceLogs: process.serviceLogs } : {}),
				...(process.runtimeStatuses
					? { runtimeStatuses: process.runtimeStatuses }
					: {}),
				...(process.runtimeStatus
					? { runtimeStatus: process.runtimeStatus }
					: {}),
				error: process.cleanupFailed
					? "Environment resource cleanup could not be confirmed; inspect leftovers before releasing this resource."
					: run.error,
			});
			refreshReferenceGraphs(doc, run.batch);
			return null;
		}, background);
		if (cascade) {
			const latch = cascade.targets ? `run:${id}` : cascade.batch;
			if (!this.closed && !this.stopped.has(latch)) {
				this.stopped.add(latch);
				this.acquisitions.notify();
				const operation = (async () =>
					this.stopTargets(
						(await this.records()).filter((run) =>
							cascade.targets
								? cascade.targets.includes(run.id)
								: run.batch === cascade.batch &&
									run.owner === cascade.owner &&
									holdsResource(run),
						),
						cascade.targets ? [] : [cascade.batch],
						true,
					))();
				this.dependencyCleanup.set(cascade.owner, operation);
				try {
					await operation;
				} finally {
					if (this.dependencyCleanup.get(cascade.owner) === operation)
						this.dependencyCleanup.delete(cascade.owner);
				}
			}
			return;
		}
		this.idle.forgetRoot(id);
		this.live.delete(id);
		this.acquisitions.notify();
	}
	private async stopLive(id: string, process: EnvironmentProcess) {
		try {
			await process.stop();
		} catch {
			await this.update(id, {
				state: "interrupted",
				output: process.logs,
				...(process.logTiming ? { logTiming: process.logTiming } : {}),
				...(process.serviceLogs ? { serviceLogs: process.serviceLogs } : {}),
				...(process.runtimeStatuses
					? { runtimeStatuses: process.runtimeStatuses }
					: {}),
				...(process.runtimeStatus
					? { runtimeStatus: process.runtimeStatus }
					: {}),
				error:
					"Environment resource cleanup could not be confirmed; inspect leftovers before releasing this resource.",
			});
			this.idle.forgetRoot(id);
			this.live.delete(id);
			return false;
		}
		await this.finish(id, process, true);
		return !process.cleanupFailed;
	}
	/** Authenticated developer-only unit control. Exact revision is checked and
	 * admission latched in the same native transaction; no saved ID is authority. */
	async stopOperatorUnit(input: Record<string, unknown>) {
		if (
			Object.keys(input).some(
				(key) => !["requestId", "runId", "revision", "reason"].includes(key),
			)
		)
			throw new Error("Unexpected operator unit stop field");
		const requestId = text(input.requestId, "request ID", 256),
			runId = text(input.runId, "run ID", 512),
			reason = text(input.reason, "unit stop reason", 1000);
		if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1)
			throw new Error("A current integer unit revision is required");
		const operatorUnit = { runId, reason, revision: Number(input.revision) },
			run = (await this.records()).find((run) => run.id === runId);
		if (!run) throw new Error("Unknown environment unit");
		const runs = await this.stopOnce(
			`operator-unit-stop:${requestId}`,
			run.owner,
			[run.plan.app],
			operatorUnit,
		);
		return { requestId, ...operatorUnit, runs, scope: "operator-unit-only-v1" };
	}
	async stopOnce(
		id: string,
		owner: number,
		apps?: string[],
		operatorUnit?: OperatorUnitStop,
	) {
		const request = JSON.stringify({ owner, apps: apps ?? null, operatorUnit }),
			previous = this.stopOperations.get(id);
		if (previous) {
			if (previous.request !== request)
				throw new Error("Stop request identity mismatch");
			return previous.operation;
		}
		const operation = this.performStopOnce(id, owner, apps, operatorUnit);
		this.stopOperations.set(id, { request, operation });
		try {
			return await operation;
		} finally {
			this.stopOperations.delete(id);
		}
	}
	private async performStopOnce(
		id: string,
		owner: number,
		apps?: string[],
		operatorUnit?: OperatorUnitStop,
	) {
		const receipt = await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				previous = doc.stops[id];
			if (previous) {
				const saved = decode<StopReceipt>(previous);
				if (
					saved.owner !== owner ||
					JSON.stringify(saved.apps) !== JSON.stringify(apps ?? null) ||
					JSON.stringify(saved.operatorUnit) !== JSON.stringify(operatorUnit)
				)
					throw new Error("Stop request identity mismatch");
				return saved;
			}
			if (operatorUnit) {
				const raw = doc.runs[operatorUnit.runId],
					run = raw ? decode<EnvironmentRun>(raw) : undefined,
					catalog = await tx.doc(Catalog),
					ownerRaw = catalog.tasks[String(owner)],
					task = ownerRaw ? decode<TaskInfo>(ownerRaw) : undefined;
				if (
					!run ||
					run.owner !== owner ||
					run.revision !== operatorUnit.revision ||
					run.state !== "running" ||
					run.ready !== true ||
					!operatorInfrastructure(run.plan) ||
					run.plan.projectKind !== "infrastructure" ||
					run.plan.operatorRoot !== true ||
					run.plan.compose?.networkOnly ||
					apps?.length !== 1 ||
					apps[0] !== run.plan.app ||
					task?.kind !== "operator-environment" ||
					task.policy !== "workspace-write" ||
					run.cleanupRetention ||
					!this.hasLiveAuthority(run) ||
					!this.live.has(run.id) ||
					[...this.pending.values()].some(
						(entry) => entry.batch === run.batch && !entry.runId,
					)
				)
					throw new Error(
						"Stale or unavailable original operator unit; wait for complete startup, inspect interrupted resources, and never stop a topology, agent or saved identity through unit control",
					);
				this.check(owner, undefined, run.batch, run.id);
			}
			const active = values<EnvironmentRun>(doc.runs).filter(
				(run) => run.owner === owner && holdsResource(run),
			);
			const coupled = new Set(
				active
					.filter(
						(run) =>
							((run.plan.dependencyBatch && !referencedRoot(run.plan)) ||
								[...this.pending.values()].some(
									(entry) => entry.batch === run.batch && !entry.runId,
								)) &&
							(!apps || apps.includes(run.plan.app)),
					)
					.map((run) => run.batch),
			);
			const selected = active.filter(
				(run) => !apps || apps.includes(run.plan.app) || coupled.has(run.batch),
			);
			// A still-referenced prerequisite is retained, not stopped directly.
			if (apps) {
				const runs = values<EnvironmentRun>(doc.runs),
					schedule = cleanupSchedule(
						runs,
						selected.map((run) => run.id),
					);
				for (const run of selected)
					if (
						referencedRoot(run.plan) &&
						!referenceRoot(run.plan) &&
						schedule.blockedBy(run.id, runs).length
					)
						throw new Error(
							"Referenced prerequisites cannot be stopped while a declared root still references them; release each dependent root first",
						);
			}
			const waiting = values<WaitReceipt>(doc.waits).filter(
				(receipt) =>
					receipt.owner === owner &&
					receipt.state === "waiting" &&
					(!apps || receipt.plans.some((plan) => apps.includes(plan.app))),
			);
			const saved: StopReceipt = {
				...(operatorUnit ? { operatorUnit } : {}),
				owner,
				apps: apps ?? null,
				runs: selected.map((run) => run.id),
				batches: [
					...new Set([
						...selected
							.filter((run) => !scopedRoot(run.plan) || coupled.has(run.batch))
							.map((run) => run.batch),
						...waiting.map((waiter) => waiter.batch),
					]),
				],
				done: false,
			};
			if (selected.some((run) => scopedRoot(run.plan))) {
				if (selected.some((run) => run.state === "interrupted"))
					throw new Error(
						"Cannot stop a saved PID. Operator inspection is required",
					);
				for (const run of selected)
					doc.runs[run.id] = JSON.stringify({
						...run,
						state: "stopping",
						revision: run.revision + 1,
					});
				this.latchStop(selected, saved.batches);
			}
			doc.stops[id] = JSON.stringify(saved);
			return saved;
		}, background);
		if (receipt.cleanupUncertain) throw new CleanupUncertain();
		if (receipt.done) return receipt.runs;
		try {
			await this.stopTargets(
				(await this.records()).filter((run) => receipt.runs.includes(run.id)),
				receipt.batches,
				false,
			);
		} catch (error) {
			if (error instanceof CleanupUncertain)
				await this.store.commit(async (tx) => {
					(await tx.doc(EnvironmentState)).stops[id] = JSON.stringify({
						...receipt,
						done: true,
						cleanupUncertain: true,
					});
				}, background);
			throw error;
		}
		await this.store.commit(async (tx) => {
			(await tx.doc(EnvironmentState)).stops[id] = JSON.stringify({
				...receipt,
				done: true,
			});
		}, background);
		return receipt.runs;
	}
	private latchStop(runs: EnvironmentRun[], batches: string[]) {
		for (const batch of batches) this.stopped.add(batch);
		for (const run of runs)
			if (
				scopedRoot(run.plan) &&
				(run.plan.projectKind !== "infrastructure" || referenceRoot(run.plan))
			)
				this.stoppedRoots.add(run.id);
		this.acquisitions.remove(batches);
		this.acquisitions.notify();
	}
	private async stopTargets(
		selected: EnvironmentRun[],
		batches: string[],
		preserveUnknown: boolean,
	) {
		if (!preserveUnknown && selected.some((run) => run.state === "interrupted"))
			throw new Error(
				"Cannot stop a saved PID. Operator inspection is required",
			);
		this.latchStop(selected, batches);
		const uncertain = await this.cleanupTargets(selected, batches);
		await Promise.allSettled(
			[...this.pending]
				.filter(
					([, entry]) =>
						batches.includes(entry.batch) ||
						selected.some((run) => run.id === entry.runId),
				)
				.map(([operation]) => operation),
		);
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
			if (!doc.waits) return;
			for (const batch of batches) {
				const raw = doc.waits[batch];
				if (!raw) continue;
				const receipt = decode<WaitReceipt>(raw);
				if (receipt.state === "waiting")
					doc.waits[batch] = JSON.stringify({
						...receipt,
						state: "cancelled",
						revision: receipt.revision + 1,
					});
			}
		}, background);
		if (uncertain && !preserveUnknown) throw new CleanupUncertain();
	}
	/** Call only after admission is latched closed. Never wait for the startup
	 * operation here: its own rollback uses this same cleanup barrier. */
	private async cleanupTargets(selected: EnvironmentRun[], batches: string[]) {
		await Promise.allSettled(
			[...this.pending]
				.filter(
					([, entry]) =>
						entry.runId &&
						(batches.includes(entry.batch) ||
							selected.some((run) => run.id === entry.runId)),
				)
				.map(([operation]) => operation),
		);
		let schedule: ReturnType<typeof cleanupSchedule>;
		try {
			schedule = cleanupSchedule(
				await this.records(),
				selected.map((run) => run.id),
			);
		} catch {
			for (const run of selected)
				await this.update(run.id, {
					state: "interrupted",
					error:
						"Cleanup dependency generations cannot be established; no cleanup was dispatched. Operator inspection required.",
				});
			return true;
		}
		const referenced = selected.some((run) => referencedRoot(run.plan)),
			attempted = new Set<string>();
		let uncertain = false,
			targets = selected;
		for (;;) {
			const staged =
				targets === selected
					? schedule
					: cleanupSchedule(
							await this.records(),
							targets.map((run) => run.id),
						);
			for (const target of staged.order)
				if (await this.cleanupGeneration(target.id, staged, attempted))
					uncertain = true;
			if (!referenced) break;
			// Last-reference release: only after this round settled, and never by
			// retrying a generation whose cleanup is already uncertain.
			const next = schedule
				.orphans(await this.records())
				.filter((run) => !attempted.has(run.id));
			if (!next.length) break;
			targets = next;
		}
		return uncertain;
	}
	private async cleanupGeneration(
		id: string,
		schedule: {
			blockedBy(id: string, current: readonly EnvironmentRun[]): string[];
		},
		attempted: Set<string>,
	) {
		if (attempted.has(id)) return;
		attempted.add(id);
		{
			const current = await this.records(),
				run = current.find((run) => run.id === id);
			if (!run) return true;
			if (run.state === "exited") return false;
			if (run.state === "interrupted") return true;
			const blockedBy = schedule.blockedBy(run.id, current);
			if (blockedBy.length) {
				await this.update(run.id, {
					state: "stopping",
					cleanupRetention: { blockedBy },
					error:
						"Prerequisite cleanup retained until all dependent generations are confirmed released; no stop dispatched for this generation.",
				});
				// Retention is a known, recorded state, not an uncertain cleanup: the
				// generation is still owned and will be released by its last reference.
				return false;
			}
			const process = this.live.get(run.id);
			if (process) {
				await this.update(run.id, {
					state: "stopping",
					cleanupRetention: undefined,
					...(run.cleanupRetention ? { error: null } : {}),
				});
				return !(await this.stopLive(run.id, process));
			}
			if (
				run.state === "reserved" ||
				(run.state === "stopping" && run.pid === null && run.ready === null)
			) {
				await this.update(run.id, { state: "exited" });
				return false;
			}
			await this.update(run.id, {
				state: "interrupted",
				error:
					"Original live cleanup authority is unavailable; operator inspection required. No saved process identity was used.",
			});
			return true;
		}
	}
	async releaseOwner(owner: number) {
		this.idle.forget(owner);
		this.revoked.add(owner);
		this.acquisitions.notify();
		const runs = (await this.records()).filter(
			(run) => run.owner === owner && holdsResource(run),
		);
		const queued = values<WaitReceipt>(
			(await this.store.snapshot(EnvironmentState, background))?.waits,
		).filter(
			(receipt) => receipt.owner === owner && receipt.state === "waiting",
		);
		await this.stopTargets(
			runs,
			[
				...runs.map((run) => run.batch),
				...queued.map((receipt) => receipt.batch),
			],
			true,
		);
		await Promise.allSettled(
			[...this.pending]
				.filter(([, entry]) => entry.owner === owner)
				.map(([operation]) => operation),
		);
		await this.dependencyCleanup.get(owner);
		this.dependencyWorkspaces.forgetOwner(owner);
		const held = (await this.records()).filter(
			(run) => run.owner === owner && holdsResource(run),
		);
		return held.length
			? `Environment cleanup requires operator inspection: ${held.map((run) => `${run.plan.app}/${run.plan.id} (${run.id})`).join(", ")}. Resources remain quarantined; see the environment dashboard.`
			: null;
	}
	async acknowledge(id: string, revision: number) {
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				raw = doc.runs[id];
			if (!raw) throw new Error("Unknown environment run");
			const run = decode<EnvironmentRun>(raw);
			if (run.state !== "interrupted" || run.revision !== revision)
				throw new Error("Stale environment inspection");
			const runs = values<EnvironmentRun>(doc.runs),
				schedule = cleanupSchedule(runs, [id]);
			if (schedule.blockedBy(id, runs).length)
				throw new Error(
					"Dependent generations must be inspected and released before their prerequisites",
				);
			if (this.live.has(id))
				throw new Error(
					"Original live generation remains held; cleanup must be confirmed before inspection can release it",
				);
			doc.runs[id] = JSON.stringify({
				...run,
				state: "exited",
				revision: run.revision + 1,
				inspection: { confirmedAt: Date.now(), revision },
				error:
					"Operator confirmed inspection and cleanup of ambiguous effects; resource released without changing recorded exit status.",
			});
			refreshReferenceGraphs(doc, run.batch);
		}, background);
		this.acquisitions.notify();
	}
	close() {
		this.closing ??= this.closeOnce();
		return this.closing;
	}
	private async closeOnce() {
		this.closed = true;
		this.acquisitions.notify();
		const selected = (await this.records()).filter(holdsResource);
		await this.stopTargets(
			selected,
			[...new Set(selected.map((run) => run.batch))],
			true,
		);
		await Promise.allSettled([...this.pending.keys()]);
		await Promise.allSettled([...this.dependencyCleanup.values()]);
		this.acquisitions.clear();
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
			if (!doc.waits) return;
			for (const receipt of values<WaitReceipt>(doc.waits))
				if (receipt.state === "waiting")
					doc.waits[receipt.batch] = JSON.stringify({
						...receipt,
						state: "interrupted",
						revision: receipt.revision + 1,
					});
		}, background);
	}
}
