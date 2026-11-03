import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { decode, type TaskInfo, values } from "../state.ts";
import { Acquisitions } from "./acquisitions.ts";
import type { LiveEnvironmentAuthority } from "./authority.ts";
import { loadProjects, projectView } from "./catalog.ts";
import { inspectCluster, loadClusters, prepareCluster } from "./cluster.ts";
import type { ClusterInspection } from "./cluster-types.ts";
import { ComposeProcess } from "./compose.ts";
import { containerPlans } from "./compose-config.ts";
import { ContainerProcess } from "./container.ts";
import { HeldHttp } from "./http-manager.ts";
import type { HttpReceipt } from "./http-receipts.ts";
import { KubernetesProcess } from "./kubernetes.ts";
import { type LogOptions, logView } from "./logs.ts";
import type { Plan } from "./model.ts";
import type { EnvironmentProcess } from "./process.ts";
import { DatabaseDiagnostics, type QueryReceipt } from "./query-manager.ts";
import { runsConflict } from "./resources.ts";
import { processEnvironment, ShellProcess } from "./shell.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type ReuseReceipt,
	type StopReceipt,
} from "./state.ts";

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
	readonly clusters;
	readonly http: HeldHttp;
	readonly database: DatabaseDiagnostics;
	readonly acquisitions: Acquisitions;
	private engine: Harness | null = null;
	private live = new Map<string, EnvironmentProcess>();
	private revoked = new Set<number>();
	private closed = false;
	private closing: Promise<void> | null = null;
	private pending = new Map<
		Promise<unknown>,
		{ owner: number; batch: string }
	>();
	private stopped = new Set<string>();
	private dependencyCleanup = new Map<number, Promise<void>>();
	constructor(private config: Config) {
		this.projects = loadProjects(config);
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
		const authority: LiveEnvironmentAuthority = {
			store: () => this.store,
			records: () => this.records(),
			live: this.live,
			pending: this.pending,
			check: (owner, signal, batch) => this.check(owner, signal, batch),
		};
		this.http = new HeldHttp(config, authority);
		this.database = new DatabaseDiagnostics(config, authority);
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
	private get store() {
		if (!this.engine) throw new Error("Environment manager not initialized");
		return this.engine;
	}
	async initialize(engine: Harness) {
		this.engine = engine;
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
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
		}, background);
	}
	private async records() {
		return values<EnvironmentRun>(
			(await this.store.snapshot(EnvironmentState, background))?.runs,
		);
	}
	private check(owner: number, signal?: AbortSignal, batch?: string) {
		signal?.throwIfAborted();
		if (
			this.closed ||
			this.revoked.has(owner) ||
			(batch && this.stopped.has(batch))
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
	private visible(
		run: EnvironmentRun,
		options: { output: boolean; services?: boolean; timing?: boolean },
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
			endpoints:
				run.state === "running" &&
				run.ready === true &&
				this.live.get(run.id) instanceof ShellProcess &&
				!this.live.get(run.id)?.outcome &&
				!this.closed &&
				!this.revoked.has(run.owner) &&
				!this.stopped.has(run.batch)
					? (run.plan.endpoints ?? {})
					: {},
			...(this.live.get(run.id)?.runtimeStatus
				? { runtimeStatus: this.live.get(run.id)?.runtimeStatus }
				: {}),
			...(this.live.get(run.id)?.runtimeStatuses
				? { runtimeStatuses: this.live.get(run.id)?.runtimeStatuses }
				: {}),
			...(output ? { output: this.live.get(run.id)?.logs ?? stored } : {}),
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
		return {
			runtime: "task-owned",
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
			).map((run) => this.visible(run, { output: false })),
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
	) {
		return recentRuns(
			(await this.records()).filter(
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
				this.visible(run, { output: true, services, timing: true }),
			);
	}
	async selectedLogs(
		app: string,
		owner: number | undefined,
		options: LogOptions,
	) {
		return logView(
			app,
			(
				await this.logs(app, owner, options.service !== undefined, options.kind)
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
		)
			return this.receipt(batch, owner.id, request);
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
		const running = plans[0]?.action === "run";
		try {
			for (const plan of plans) {
				this.check(owner.id, signal, batch);
				const id = `${batch}:${plan.app}`,
					process: EnvironmentProcess =
						plan.runtime === "shell"
							? new ShellProcess(plan, this.config.configDir)
							: plan.runtime === "compose"
								? new ComposeProcess(
										plan,
										this.config.configDir,
										this.config.stateDir,
										id,
									)
								: plan.runtime === "kubernetes"
									? new KubernetesProcess(this.config, plan, id)
									: new ContainerProcess(
											plan,
											this.config.configDir,
											this.config.stateDir,
											id,
										);
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
							ready: plan.runtime !== "shell" || plan.readyText ? true : null,
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
					}, background);
				} else {
					await process.wait(signal);
					await this.finish(id, process);
				}
			}
			const result = await this.receipt(batch, owner.id, request);
			if (running && result?.some((run) => run.state !== "running"))
				throw new Error("An app exited before batch startup completed");
			return result;
		} catch {
			this.stopped.add(batch);
			for (const plan of [...plans].reverse()) {
				const id = `${batch}:${plan.app}`,
					process = this.live.get(id);
				if (process) await this.stopLive(id, process);
				else
					await this.store.commit(async (tx) => {
						const doc = await tx.doc(EnvironmentState),
							run = decode<EnvironmentRun>(doc.runs[id]);
						if (run.state === "reserved")
							doc.runs[id] = JSON.stringify({
								...run,
								state: "exited",
								revision: run.revision + 1,
							});
					}, background);
				await this.update(id, {
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
			if (run.plan.dependencyBatch && !cleanup)
				return { batch: run.batch, owner: run.owner };
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
			return null;
		}, background);
		if (cascade) {
			if (!this.closed && !this.stopped.has(cascade.batch)) {
				this.stopped.add(cascade.batch);
				this.acquisitions.notify();
				const operation = (async () =>
					this.stopTargets(
						(await this.records()).filter(
							(run) =>
								run.batch === cascade.batch &&
								run.owner === cascade.owner &&
								holdsResource(run),
						),
						[cascade.batch],
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
			this.live.delete(id);
			return false;
		}
		await this.finish(id, process, true);
		return !process.cleanupFailed;
	}
	async stopOnce(id: string, owner: number, apps?: string[]) {
		const receipt = await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				previous = doc.stops[id];
			if (previous) {
				const saved = decode<StopReceipt>(previous);
				if (
					saved.owner !== owner ||
					JSON.stringify(saved.apps) !== JSON.stringify(apps ?? null)
				)
					throw new Error("Stop request identity mismatch");
				return saved;
			}
			const active = values<EnvironmentRun>(doc.runs).filter(
				(run) => run.owner === owner && holdsResource(run),
			);
			const coupled = new Set(
				active
					.filter(
						(run) =>
							run.plan.dependencyBatch &&
							(!apps || apps.includes(run.plan.app)),
					)
					.map((run) => run.batch),
			);
			const selected = active.filter(
				(run) => !apps || apps.includes(run.plan.app) || coupled.has(run.batch),
			);
			const waiting = values<WaitReceipt>(doc.waits).filter(
				(receipt) =>
					receipt.owner === owner &&
					receipt.state === "waiting" &&
					(!apps || receipt.plans.some((plan) => apps.includes(plan.app))),
			);
			const saved: StopReceipt = {
				owner,
				apps: apps ?? null,
				runs: selected.map((run) => run.id),
				batches: [
					...new Set([
						...selected.map((run) => run.batch),
						...waiting.map((waiter) => waiter.batch),
					]),
				],
				done: false,
			};
			doc.stops[id] = JSON.stringify(saved);
			return saved;
		}, background);
		if (receipt.done) return receipt.runs;
		await this.stopTargets(
			(await this.records()).filter((run) => receipt.runs.includes(run.id)),
			receipt.batches,
			false,
		);
		await this.store.commit(async (tx) => {
			(await tx.doc(EnvironmentState)).stops[id] = JSON.stringify({
				...receipt,
				done: true,
			});
		}, background);
		return receipt.runs;
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
		for (const batch of batches) this.stopped.add(batch);
		this.acquisitions.remove(batches);
		this.acquisitions.notify();
		let uncertain = false;
		for (const run of [...selected].reverse()) {
			if (run.state === "interrupted" || run.state === "exited") continue;
			const process = this.live.get(run.id);
			if (process) {
				await this.update(run.id, { state: "stopping" });
				if (!(await this.stopLive(run.id, process))) uncertain = true;
			} else await this.update(run.id, { state: "exited" });
		}
		await Promise.allSettled(
			[...this.pending]
				.filter(([, entry]) => batches.includes(entry.batch))
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
		if (uncertain && !preserveUnknown)
			throw new Error(
				"Cleanup remains uncertain; operator inspection required",
			);
	}
	async releaseOwner(owner: number) {
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
			doc.runs[id] = JSON.stringify({
				...run,
				state: "exited",
				revision: run.revision + 1,
				inspection: { confirmedAt: Date.now(), revision },
				error:
					"Operator confirmed inspection and cleanup of ambiguous effects; resource released without changing recorded exit status.",
			});
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
		for (const [id, process] of [...this.live].reverse())
			await this.stopLive(id, process);
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
