import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { decode, type TaskInfo, values } from "../state.ts";
import { loadProjects, type Plan, projectView } from "./catalog.ts";
import { ComposeProcess } from "./compose.ts";
import { containerPlans } from "./compose-config.ts";
import { ContainerProcess } from "./container.ts";
import type { EnvironmentProcess } from "./process.ts";
import { actionsConflict, runsConflict } from "./resources.ts";
import { processEnvironment, ShellProcess } from "./shell.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	holdsResource,
	type StopReceipt,
} from "./state.ts";

type Waiter = {
	batch: string;
	owner: number;
	apps: string[];
	since: number;
	plans: Plan[];
};
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
	private engine: Harness | null = null;
	private live = new Map<string, EnvironmentProcess>();
	private revoked = new Set<number>();
	private waiters: Waiter[] = [];
	private listeners = new Set<() => void>();
	private generation = 0;
	private closed = false;
	private pending = new Map<
		Promise<unknown>,
		{ owner: number; batch: string }
	>();
	private stopped = new Set<string>();
	constructor(private config: Config) {
		this.projects = loadProjects(config);
	}
	private get store() {
		if (!this.engine) throw new Error("Environment manager not initialized");
		return this.engine;
	}
	async initialize(engine: Harness) {
		this.engine = engine;
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState);
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
	private notify() {
		this.generation++;
		for (const listener of [...this.listeners]) listener();
	}
	private changed(
		generation: number,
		signal: AbortSignal | undefined,
		deadline: number,
	) {
		if (this.generation !== generation) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.listeners.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
			this.listeners.add(done);
			signal?.addEventListener("abort", done, { once: true });
			if (signal?.aborted || this.generation !== generation) done();
		});
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
		const runs = (await this.records()).filter((run) => run.batch === batch);
		if (!runs.length) return null;
		if (runs.some((run) => run.owner !== owner || run.request !== request))
			throw new Error("Environment request identity mismatch");
		return runs.map((run) => this.visible(run, true));
	}
	private visible(run: EnvironmentRun, output: boolean) {
		const { output: stored, ...rest } = run;
		return {
			...rest,
			...(this.live.get(run.id)?.runtimeStatus
				? { runtimeStatus: this.live.get(run.id)?.runtimeStatus }
				: {}),
			...(this.live.get(run.id)?.runtimeStatuses
				? { runtimeStatuses: this.live.get(run.id)?.runtimeStatuses }
				: {}),
			...(output ? { output: this.live.get(run.id)?.logs ?? stored } : {}),
		};
	}
	async snapshot(app?: string) {
		const all = await this.records();
		return {
			runtime: "task-owned",
			projects: this.projects
				.filter((project) => !app || project.id === app)
				.map(projectView),
			runs: recentRuns(
				all.filter((run) => !app || run.plan.app === app),
				200,
			).map((run) => this.visible(run, false)),
			waiters: this.waiters
				.filter((waiter) => !app || waiter.apps.includes(app))
				.map(({ plans: _plans, ...waiter }) => waiter),
		};
	}
	async logs(app: string, owner?: number) {
		return recentRuns(
			(await this.records()).filter(
				(run) =>
					run.plan.app === app && (owner === undefined || run.owner === owner),
			),
			20,
		)
			.sort(
				(a, b) =>
					Number(holdsResource(b)) - Number(holdsResource(a)) ||
					b.createdAt - a.createdAt,
			)
			.map((run) => this.visible(run, true));
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
		this.notify();
	}
	async execute(
		batch: string,
		request: string,
		owner: TaskInfo,
		plans: Plan[],
		waitMs: number,
		signal?: AbortSignal,
	) {
		const operation = this.perform(
			batch,
			request,
			owner,
			plans,
			waitMs,
			signal,
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
		signal?: AbortSignal,
	) {
		this.check(owner.id, signal, batch);
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
		// Resolve referenced values only after approval, and fail before reserving or starting any app.
		for (const plan of plans) processEnvironment(this.config.configDir, plan);
		const running = plans[0]?.action === "run";
		const waiter: Waiter = {
			batch,
			owner: owner.id,
			apps: plans.map((plan) => plan.app),
			since: Date.now(),
			plans,
		};
		if (running) this.waiters.push(waiter);
		this.notify();
		const deadline = Date.now() + waitMs;
		let reserved = false;
		try {
			while (!reserved) {
				this.check(owner.id, signal, batch);
				const generation = this.generation;
				reserved = await this.store.commit(async (tx) => {
					const task = await tx.task(owner.id as TaskId);
					this.check(owner.id, signal, batch);
					if (!task || task.abortRequested || task.state.status === "terminal")
						throw new Error("Environment task has ended");
					const doc = await tx.doc(EnvironmentState),
						active = values<EnvironmentRun>(doc.runs).filter(holdsResource);
					if (running) {
						const held = active.filter((run) => run.plan.action === "run");
						if (held.some((run) => run.owner === owner.id))
							throw new Error(
								"Release your existing app batch before acquiring another; interrupted runs need operator inspection",
							);
						if (
							this.waiters
								.slice(0, this.waiters.indexOf(waiter))
								.some((earlier) =>
									earlier.plans.some((left) =>
										plans.some((right) =>
											runsConflict(left, right, this.config.stateDir),
										),
									),
								) ||
							held.some((run) =>
								plans.some((plan) =>
									runsConflict(run.plan, plan, this.config.stateDir),
								),
							)
						)
							return false;
					} else if (
						active.some((run) =>
							plans.some((plan) => actionsConflict(run.plan, plan)),
						)
					)
						throw new Error(
							"An environment action already owns this workspace or daemon image writer; inspect interrupted actions before retrying",
						);
					for (const plan of plans) {
						const run: EnvironmentRun = {
							id: `${batch}:${plan.app}`,
							batch,
							request,
							owner: owner.id,
							plan,
							state: "reserved",
							revision: 1,
							createdAt: Date.now(),
							pid: null,
							ready: null,
							exitCode: null,
							signal: null,
							output: "",
							error: null,
						};
						doc.runs[run.id] = JSON.stringify(run);
					}
					return true;
				}, background);
				if (!reserved) {
					if (Date.now() >= deadline)
						throw new Error(
							"Environment acquisition timed out; no apps started and queue position released",
						);
					await this.changed(generation, signal, deadline);
				}
			}
			this.waiters = this.waiters.filter((item) => item !== waiter);
			this.notify();
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
		} catch (error) {
			if (reserved) {
				for (const plan of plans) {
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
			}
			// Child output is available only through the redacted log path, never errors.
			throw new Error(
				error instanceof Error && !reserved
					? error.message
					: "Environment execution did not complete; inspect env_status and env_logs",
			);
		} finally {
			this.waiters = this.waiters.filter((item) => item !== waiter);
			this.notify();
		}
	}
	private async finish(id: string, process: EnvironmentProcess) {
		const exit = await process.done;
		await this.store.commit(async (tx) => {
			const doc = await tx.doc(EnvironmentState),
				run = decode<EnvironmentRun>(doc.runs[id]);
			// An interrupted receipt is a quarantine latch; even a late exit cannot
			// release it or overwrite a subsequent authenticated inspection decision.
			if (run.state === "interrupted" || run.state === "exited") return;
			doc.runs[id] = JSON.stringify({
				...run,
				state: process.cleanupFailed ? "interrupted" : "exited",
				revision: run.revision + 1,
				exitCode: exit.code,
				signal: exit.signal,
				output: process.logs,
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
		}, background);
		this.live.delete(id);
		this.notify();
	}
	private async stopLive(id: string, process: EnvironmentProcess) {
		try {
			await process.stop();
		} catch {
			await this.update(id, {
				state: "interrupted",
				output: process.logs,
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
		await this.finish(id, process);
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
			const selected = values<EnvironmentRun>(doc.runs).filter(
				(run) =>
					run.owner === owner &&
					holdsResource(run) &&
					(!apps || apps.includes(run.plan.app)),
			);
			const waiting = this.waiters.filter(
				(waiter) =>
					waiter.owner === owner &&
					(!apps || waiter.apps.some((app) => apps.includes(app))),
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
		this.notify();
		for (const run of selected) {
			if (run.state === "interrupted" || run.state === "exited") continue;
			const process = this.live.get(run.id);
			if (process) {
				await this.update(run.id, { state: "stopping" });
				if (!(await this.stopLive(run.id, process)) && !preserveUnknown)
					throw new Error(
						"Cleanup remains uncertain; operator inspection required",
					);
			} else await this.update(run.id, { state: "exited" });
		}
		await Promise.allSettled(
			[...this.pending]
				.filter(([, entry]) => batches.includes(entry.batch))
				.map(([operation]) => operation),
		);
	}
	async releaseOwner(owner: number) {
		this.revoked.add(owner);
		this.notify();
		const runs = (await this.records()).filter(
			(run) => run.owner === owner && holdsResource(run),
		);
		await this.stopTargets(
			runs,
			runs.map((run) => run.batch),
			true,
		);
		await Promise.allSettled(
			[...this.pending]
				.filter(([, entry]) => entry.owner === owner)
				.map(([operation]) => operation),
		);
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
		this.notify();
	}
	async close() {
		this.closed = true;
		this.notify();
		for (const [id, process] of this.live) await this.stopLive(id, process);
		await Promise.allSettled([...this.pending.keys()]);
	}
}
