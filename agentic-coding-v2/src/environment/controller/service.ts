import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../config.ts";
import { git } from "../../git.ts";
import { validateProjects } from "../catalog.ts";
import { readEnvironmentDefinitions } from "../definition-file.ts";
import {
	definitionProjectLimit,
	definitionTargetLimit,
} from "../definition-limits.ts";
import {
	httpDiagnosticAuthority,
	sqlDiagnosticAuthority,
	sqlRootScopeAuthority,
} from "../diagnostic-approval.ts";
import type { DiagnosticSelection } from "../diagnostic-history.ts";
import {
	type OperatorLifetime,
	operatorInfrastructurePlans,
} from "../lifetime.ts";
import type { LogOptions } from "../logs.ts";
import { Environments } from "../manager.ts";
import type { Plan, TelemetryOptions } from "../model.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
	type StopReceipt,
} from "../state.ts";
import {
	type DiagnosticSnapshot,
	diagnosticHttpInput,
	diagnosticQueryInput,
	diagnosticResult,
	nativeDiagnosticId,
} from "./diagnostic-input.ts";
import { executionResult } from "./execution-result.ts";
import { ControllerOperations, type DispatchPermit } from "./operations.ts";
import { operatorControls } from "./operator-controls.ts";
import {
	controllerOwner as owner,
	validateControllerPlans,
} from "./plan-policy.ts";
import { runObservation as runView } from "./run-observation.ts";
import { scopeIdleExpired } from "./scope-idle.ts";
import { ControllerScopes } from "./scopes.ts";
import { ControllerPersistence } from "./sqlite-persistence.ts";
import {
	type ControllerOperation,
	type ControllerPrincipal,
	ControllerRefusal,
	type ControllerScope,
	OperationState,
	type ScopeClosure,
	ScopeState,
} from "./state.ts";

type PinnedPlan = Plan & { controllerGitHead: string };
type Work = {
	scope: string;
	apps: string[];
	abort: AbortController;
	finished: Promise<void>;
};
type StopResult = {
	scope: string;
	stopped: boolean;
	inspectionRequired: boolean;
	historical?: boolean;
};

function operationView(operation: ControllerOperation, currentHost: string) {
	const {
		plan: _plan,
		identity: _identity,
		host: _host,
		owner: _owner,
		approval: _approval,
		...visible
	} = operation;
	return { ...visible, historical: operation.host !== currentHost };
}
async function head(workspace: string) {
	const value = (
		await git(workspace, ["rev-parse", "--verify", "HEAD"], 128)
	).trim();
	if (!/^[a-f0-9]{40,64}$/.test(value))
		throw new ControllerRefusal("workspace-unavailable");
	return value;
}

/** One standalone resource authority. Existing native queues/adapters retain live-handle ownership. */
export class EnvironmentController {
	private work = new Map<string, Work>();
	private stops = new Map<
		string,
		{ request: string; operation: Promise<StopResult> }
	>();
	private activity = new Map<string, { at: number; sequence: number }>();
	private sequence = 0;
	private idleError: string | null = null;
	private closures = new Map<
		string,
		{ identity: string; operation: Promise<Record<string, unknown>> }
	>();
	private sweeping: Promise<Record<string, unknown>[]> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private closing: Promise<void> | null = null;
	private constructor(
		private store: ControllerPersistence,
		readonly scopes: ControllerScopes,
		readonly operations: ControllerOperations,
		private manager: Environments,
	) {}
	static async open(options: {
		stateDir: string;
		configDir: string;
		repositories: readonly string[];
	}) {
		const store = ControllerPersistence.open(options.stateDir);
		let manager: Environments | undefined;
		try {
			const repositories = [
				...new Set(
					options.repositories.map((repository) => fs.realpathSync(repository)),
				),
			];
			const scopes = await ControllerScopes.open(store, repositories);
			const config: Config = {
				stateDir: options.stateDir,
				configDir: path.resolve(options.configDir),
				repositories,
				profiles: [],
				orchestratorProfile: "",
				providers: [],
				skills: [],
			};
			const projects = validateProjects(
				config,
				readEnvironmentDefinitions(config.configDir),
			);
			if (
				projects.length > definitionProjectLimit ||
				projects.reduce((total, project) => total + project.targets.length, 0) >
					definitionTargetLimit
			)
				throw new ControllerRefusal("operation-plan-unavailable");
			manager = new Environments(config, projects);
			await manager.initialize(store);
			const environments = manager;
			const operations = await ControllerOperations.open(
				store,
				scopes,
				async (scope, intent) => {
					let plans = await environments.resolvePlans(
						owner(scope),
						intent.apps,
						intent.action,
						{
							target: intent.target,
							profile: intent.profile,
							runtime: intent.runtime,
							replicas: intent.replicas,
						},
					);
					plans = plans.map((plan) =>
						plan.kubernetes
							? {
									...plan,
									clusterConnection: environments.prepareCluster(
										owner(scope),
										plan.kubernetes.cluster,
									),
								}
							: plan,
					);
					if (intent.lifetime?.startsWith("operator-infrastructure-")) {
						plans = operatorInfrastructurePlans(
							plans,
							intent.apps,
							intent.lifetime as OperatorLifetime,
						);
					} else if (intent.lifetime) {
						plans = plans.map((plan) => ({
							...plan,
							lifetime: intent.lifetime,
						}));
					}
					validateControllerPlans(plans, scope);
					const gitHead = await head(scope.workspace.directory);
					return plans.map(
						(plan): PinnedPlan => ({ ...plan, controllerGitHead: gitHead }),
					);
				},
			);
			const controller = new EnvironmentController(
				store,
				scopes,
				operations,
				manager,
			);
			controller.timer = setInterval(() => {
				void controller.tick().catch(() => undefined);
			}, 60_000);
			controller.timer.unref();
			return controller;
		} catch {
			try {
				await manager?.close();
			} finally {
				await store.close();
			}
			throw new ControllerRefusal("controller-store-unavailable");
		}
	}
	operatorControls() {
		return operatorControls(this.manager);
	}
	bind(principal: ControllerPrincipal, scopeId: string) {
		const scopes = this.scopes.bind(principal);
		const operations = this.operations.bind(principal);
		const touch = async () => {
			const scope = await scopes.read(scopeId);
			if (scope.host === this.store.host && scope.state === "active")
				this.noteActivity(scopeId);
		};
		const read = async (id: string) => {
			const operation = await operations.read(id);
			if (operation.scope !== scopeId)
				throw new ControllerRefusal("operation-unavailable");
			await touch();
			return operation;
		};
		const active = async () => {
			if (this.closing) throw new ControllerRefusal("scope-unavailable");
			return scopes.assertActive(scopeId);
		};
		return {
			touch,
			http: async (requestId: string, raw: unknown) => {
				if (this.closing) throw new ControllerRefusal("scope-unavailable");
				await touch();
				const input = diagnosticHttpInput(raw);
				return operationView(
					await operations.admitDiagnostic(
						scopeId,
						requestId,
						"http",
						input,
						async (scope) => ({
							kind: "http",
							input,
							request: await this.manager.http.prepare(
								owner(scope),
								input.app,
								input.endpoint,
								input.path,
								undefined,
								input.http,
							),
							authority: httpDiagnosticAuthority,
						}),
					),
					this.store.host,
				);
			},
			query: async (requestId: string, raw: unknown) => {
				if (this.closing) throw new ControllerRefusal("scope-unavailable");
				await touch();
				const input = diagnosticQueryInput(raw);
				return operationView(
					await operations.admitDiagnostic(
						scopeId,
						requestId,
						"sql",
						input,
						async (scope) => ({
							kind: "sql",
							input,
							request: await this.manager.database.prepare(owner(scope), input),
							authority: sqlDiagnosticAuthority,
							...(input.app === undefined
								? {}
								: { rootScope: sqlRootScopeAuthority }),
						}),
					),
					this.store.host,
				);
			},
			logs: async (app: string, options: LogOptions = {}) => {
				const scope = await scopes.read(scopeId);
				await touch();
				return this.manager.selectedLogs(app, scope.owner, options);
			},
			telemetry: async (
				app: string,
				options: TelemetryOptions = {},
				expectedRun?: string,
			) => {
				const scope = await active();
				await touch();
				return this.manager.queryTelemetry(
					app,
					scope.owner,
					options,
					expectedRun,
				);
			},
			diagnosticHistory: async (
				runId: string,
				kind: "http" | "sql",
				selection: DiagnosticSelection = {},
			) => {
				const scope = await scopes.read(scopeId);
				const state = await this.store.snapshot(EnvironmentState);
				const run = Object.values(state?.runs ?? {})
					.map((raw) => JSON.parse(raw) as EnvironmentRun)
					.find((run) => run.id === runId && run.owner === scope.owner);
				if (!run) throw new ControllerRefusal("operation-unavailable");
				await touch();
				return kind === "http"
					? this.manager.http.history(runId, selection)
					: this.manager.database.history(runId, selection);
			},
			closeScope: async (requestId: string, revision: number) =>
				this.closeOwnedScope(
					await scopes.read(scopeId),
					requestId,
					revision,
					"explicit",
				),
			admit: async (requestId: string, intent: unknown) => {
				if (this.closing) throw new ControllerRefusal("scope-unavailable");
				await touch();
				return operationView(
					await operations.admit(scopeId, requestId, intent),
					this.store.host,
				);
			},
			result: async (id: string) =>
				operationView(await read(id), this.store.host),
			status: async (app?: string) => {
				const scope = await scopes.read(scopeId);
				if (scope.host === this.store.host && scope.state === "active")
					this.noteActivity(scopeId);
				const state = await this.store.snapshot(EnvironmentState);
				const runs = Object.values(state?.runs ?? {})
					.map((raw) => JSON.parse(raw) as EnvironmentRun)
					.filter(
						(run) =>
							run.owner === scope.owner &&
							(app === undefined || run.plan.app === app),
					);
				return {
					scope: scopeId,
					state: scope.state,
					revision: scope.revision,
					inspectionRequired:
						scope.state === "interrupted" ||
						runs.some(
							(run) => run.state === "interrupted" || run.cleanupRetention,
						),
					idle: {
						mode: scope.mode,
						idleMs: scope.idleMs,
						sweepError: this.idleError,
					},
					historical: scope.host !== this.store.host,
					runs: runs.slice(-20).map((run) => runView({ ...run, output: "" })),
					historyWindow: {
						observed: runs.length,
						returned: Math.min(20, runs.length),
						omitted: Math.max(0, runs.length - 20),
					},
				};
			},
			execute: async (id: string) => {
				const operation = await read(id);
				if (this.work.has(id) || operation.state !== "approved")
					return operationView(operation, this.store.host);
				const frozen = JSON.parse(operation.plan) as {
					diagnostic?: DiagnosticSnapshot;
					disclosure?: { plans: Plan[] };
				};
				const diagnostic =
					operation.kind === "http" || operation.kind === "sql"
						? frozen.diagnostic
						: undefined;
				const planned =
					operation.kind === "http" || operation.kind === "sql"
						? []
						: frozen.disclosure?.plans;
				if (
					!Array.isArray(planned) ||
					planned.some((plan) => typeof plan.app !== "string")
				)
					throw new ControllerRefusal("operation-plan-unavailable");
				const started =
					Promise.withResolvers<ReturnType<typeof operationView>>();
				const abort = new AbortController();
				const finished = (async () => {
					let permit: DispatchPermit | undefined;
					try {
						const scope = await active();
						if (diagnostic) {
							abort.signal.throwIfAborted();
							permit = await operations.issue(id, operation);
							started.resolve(operationView(permit.operation, this.store.host));
							const nativeId = nativeDiagnosticId(diagnostic.kind, id);
							const result =
								diagnostic.kind === "http"
									? await this.manager.http.request(
											owner(scope),
											diagnostic.request,
											abort.signal,
											{ id: nativeId, input: diagnostic.input },
										)
									: await this.manager.database.request(
											owner(scope),
											diagnostic.request,
											nativeId,
											abort.signal,
										);
							await operations.complete(
								permit,
								JSON.stringify(diagnosticResult(result, diagnostic, id)),
							);
							return;
						}
						const snapshot = JSON.parse(operation.plan) as {
							disclosure: { plans: PinnedPlan[]; waitTimeoutMs: number };
						};
						const plans = snapshot.disclosure.plans;
						validateControllerPlans(plans, scope);
						const currentHead = await head(scope.workspace.directory);
						if (plans.some((plan) => plan.controllerGitHead !== currentHead))
							throw new ControllerRefusal("workspace-unavailable");
						abort.signal.throwIfAborted();
						permit = await operations.issue(id, operation);
						started.resolve(operationView(permit.operation, this.store.host));
						let failed = false;
						let dispatched: unknown;
						try {
							dispatched = await this.manager.execute(
								`controller-${id}`,
								operation.digest,
								owner(scope),
								plans,
								snapshot.disclosure.waitTimeoutMs,
								abort.signal,
							);
						} catch {
							failed = true;
						}
						const runs =
							(await this.manager.receipt(
								`controller-${id}`,
								scope.owner,
								operation.digest,
							)) ?? [];
						const outcome = executionResult(
							dispatched,
							runs,
							failed,
							abort.signal.aborted,
						);
						const result = JSON.stringify({
							status: outcome.status,
							runs: runs.map(runView),
						});
						if (outcome.inspectionRequired)
							await operations.interrupt(permit, result);
						else await operations.complete(permit, result);
					} catch {
						started.reject(new ControllerRefusal("operation-unavailable"));
						if (permit)
							await operations
								.interrupt(
									permit,
									JSON.stringify({
										status: "unknown",
										error:
											"Environment dispatch or receipt was interrupted; inspection required",
										...(diagnostic
											? {
													history: {
														kind: diagnostic.kind,
														run: diagnostic.request.run,
														operation: nativeDiagnosticId(diagnostic.kind, id),
													},
												}
											: {}),
									}),
								)
								.catch(() => undefined);
					}
				})();
				const work = {
					scope: scopeId,
					apps: diagnostic
						? diagnostic.kind === "http"
							? [diagnostic.request.app]
							: [diagnostic.request.app, diagnostic.input.infra]
						: planned.map((plan) => plan.app),
					abort,
					finished,
				};
				this.work.set(id, work);
				void finished.finally(() => {
					this.noteActivity(scopeId);
					if (this.work.get(id) === work) this.work.delete(id);
				});
				return started.promise;
			},
			wait: async (id: string) => {
				await read(id);
				await this.work.get(id)?.finished;
				return operationView(await read(id), this.store.host);
			},
			stop: async (requestId: string, apps?: string[]) => {
				const selected = apps ? [...apps] : undefined;
				const scope = await scopes.read(scopeId);
				// A changed workspace or closing scope must not prevent original-handle
				// cleanup. Only this live host can stop; history grants no authority.
				if (this.closing) throw new ControllerRefusal("scope-unavailable");
				if (
					typeof requestId !== "string" ||
					!requestId.trim() ||
					requestId.length > 256 ||
					(selected &&
						(!selected.length ||
							selected.length > 16 ||
							selected.some((app) => !/^[a-z][a-z0-9-]{0,63}$/.test(app)) ||
							new Set(selected).size !== selected.length))
				)
					throw new ControllerRefusal("operation-unavailable");
				const key = createHash("sha256")
					.update(JSON.stringify([scopeId, requestId]))
					.digest("hex");
				const request = JSON.stringify(selected ?? null);
				const previous = this.stops.get(key);
				if (previous) {
					if (previous.request !== request)
						throw new ControllerRefusal("operation-request-conflict");
					return { ...(await previous.operation), historical: true };
				}
				if (this.stops.size >= 1024)
					throw new ControllerRefusal("operation-unavailable");
				const operation = (async (): Promise<StopResult> => {
					const raw = (await this.store.snapshot(EnvironmentState))?.stops[
						`controller-stop-${key}`
					];
					const saved = raw ? (JSON.parse(raw) as StopReceipt) : undefined;
					if (
						saved &&
						(saved.owner !== scope.owner ||
							JSON.stringify(saved.apps) !== request ||
							saved.operatorUnit)
					)
						throw new ControllerRefusal("operation-request-conflict");
					if (saved?.done)
						return {
							scope: scopeId,
							stopped: !saved.cleanupUncertain,
							inspectionRequired: Boolean(saved.cleanupUncertain),
							historical: true,
						};
					if (scope.host !== this.store.host || scope.state === "interrupted")
						throw new ControllerRefusal("scope-unavailable");
					const pending = saved
						? []
						: [...this.work.values()].filter(
								(work) =>
									work.scope === scopeId &&
									(!selected ||
										work.apps.some((app) => selected.includes(app))),
							);
					for (const work of pending) work.abort.abort();
					try {
						await this.manager.stopOnce(
							`controller-stop-${key}`,
							scope.owner,
							selected,
						);
					} catch {
						throw new ControllerRefusal("operation-unavailable");
					}
					await Promise.allSettled(pending.map((work) => work.finished));
					const state = await this.store.snapshot(EnvironmentState);
					const retained = Object.values(state?.runs ?? {})
						.map((raw) => JSON.parse(raw) as EnvironmentRun)
						.filter(
							(run) =>
								run.owner === scope.owner &&
								(!selected || selected.includes(run.plan.app)) &&
								run.state !== "exited",
						);
					return {
						scope: scopeId,
						stopped: retained.length === 0,
						inspectionRequired: retained.some(
							(run) => run.state === "interrupted" || run.cleanupRetention,
						),
					};
				})();
				this.stops.set(key, { request, operation });
				return operation;
			},
		};
	}
	private noteActivity(scope: string) {
		this.activity.set(scope, { at: Date.now(), sequence: ++this.sequence });
	}
	private closeOwnedScope(
		scope: ControllerScope,
		requestId: string,
		revision: number,
		reason: "explicit" | "idle",
		guard?: () => boolean,
	): Promise<Record<string, unknown>> {
		if (
			this.closing ||
			typeof requestId !== "string" ||
			!requestId.trim() ||
			requestId.length > 256 ||
			!Number.isSafeInteger(revision) ||
			revision < 1
		)
			return Promise.reject(new ControllerRefusal("scope-unavailable"));
		const key = createHash("sha256")
			.update(JSON.stringify([scope.id, reason, requestId]))
			.digest("hex");
		const identity = JSON.stringify([
			scope.id,
			scope.principal,
			revision,
			reason,
		]);
		const old = this.closures.get(key);
		if (old) {
			if (old.identity !== identity)
				return Promise.reject(new ControllerRefusal("scope-request-conflict"));
			return old.operation.then((result) => ({ ...result, historical: true }));
		}
		if (this.closures.size >= 1024)
			return Promise.reject(new ControllerRefusal("scope-unavailable"));
		let issued = false;
		const operation = (async () => {
			const prepared = await this.store.commit(async (tx) => {
				const data = await tx.doc(ScopeState);
				data.closures ??= {};
				const previous = data.closures[key];
				if (previous) {
					const receipt = JSON.parse(previous) as ScopeClosure;
					if (receipt.identity !== identity)
						throw new ControllerRefusal("scope-request-conflict");
					return { receipt, replay: true };
				}
				const raw = data.scopes[String(scope.owner)];
				const current = raw ? (JSON.parse(raw) as ControllerScope) : undefined;
				if (
					!current ||
					current.id !== scope.id ||
					current.host !== this.store.host ||
					current.state !== "active" ||
					current.revision !== revision ||
					(guard && !guard()) ||
					Object.keys(data.closures).length >= 1024
				)
					throw new ControllerRefusal("scope-unavailable");
				current.state = "closing";
				current.revision++;
				// Like native stop latches, revoke live startup authority on the
				// transaction line. A failed commit stays fail-closed, never unfenced.
				this.manager.fenceOwner(scope.owner);
				const journal = await tx.doc(OperationState);
				for (const [id, raw] of Object.entries(journal.operations)) {
					const pending = JSON.parse(raw) as ControllerOperation;
					if (
						pending.owner === scope.owner &&
						["awaiting-approval", "approved"].includes(pending.state)
					)
						journal.operations[id] = JSON.stringify({
							...pending,
							state: "interrupted",
							revision: pending.revision + 1,
							inspectionRequired: false,
						});
				}
				const receipt: ScopeClosure = {
					scope: scope.id,
					owner: scope.owner,
					host: this.store.host,
					identity,
					state: "issued",
					inspectionRequired: false,
				};
				data.scopes[String(scope.owner)] = JSON.stringify(current);
				data.closures[key] = JSON.stringify(receipt);
				return { receipt, replay: false };
			});
			const view = (receipt: ScopeClosure, historical: boolean) => ({
				scope: receipt.scope,
				state: receipt.state,
				inspectionRequired: receipt.inspectionRequired,
				historical,
			});
			if (prepared.replay) return view(prepared.receipt, true);
			issued = true;
			const pending = [...this.work.values()].filter(
				(work) => work.scope === scope.id,
			);
			for (const work of pending) work.abort.abort();
			let inspectionRequired = true;
			try {
				inspectionRequired =
					(await this.manager.releaseOwner(scope.owner)) !== null;
			} catch {
				/* Original-handle cleanup uncertainty stays quarantined. */
			}
			await Promise.allSettled(pending.map((work) => work.finished));
			return this.store.commit(async (tx) => {
				const data = await tx.doc(ScopeState);
				const current = JSON.parse(
					data.scopes[String(scope.owner)] ?? "null",
				) as ControllerScope | null;
				if (current?.state !== "closing" || current.host !== this.store.host)
					throw new ControllerRefusal("scope-unavailable");
				current.state = inspectionRequired ? "interrupted" : "closed";
				current.revision++;
				const receipt: ScopeClosure = {
					...prepared.receipt,
					state: inspectionRequired ? "interrupted" : "completed",
					inspectionRequired,
				};
				data.scopes[String(scope.owner)] = JSON.stringify(current);
				if (!data.closures) throw new ControllerRefusal("scope-unavailable");
				data.closures[key] = JSON.stringify(receipt);
				return view(receipt, false);
			});
		})();
		this.closures.set(key, { identity, operation });
		void operation.catch(() => {
			if (!issued && this.closures.get(key)?.operation === operation)
				this.closures.delete(key);
		});
		return operation;
	}
	/** Explicit sweeps allow deterministic clock tests; the live host invokes this once per minute. */
	tick(now = Date.now()) {
		if (this.closing) return Promise.resolve([]);
		this.sweeping ??= (async () => {
			const data = await this.store.snapshot(ScopeState);
			const results: Record<string, unknown>[] = [];
			for (const raw of Object.values(data?.scopes ?? {})) {
				const scope = JSON.parse(raw) as ControllerScope;
				const activity = this.activity.get(scope.id);
				const hasWork = () =>
					[...this.work.values()].some((work) => work.scope === scope.id);
				if (
					scope.host !== this.store.host ||
					!scopeIdleExpired(scope, activity?.at, hasWork(), now)
				)
					continue;
				try {
					results.push(
						await this.closeOwnedScope(
							scope,
							`idle:${scope.revision}:${activity?.sequence ?? 0}`,
							scope.revision,
							"idle",
							() =>
								this.activity.get(scope.id)?.sequence === activity?.sequence &&
								!hasWork(),
						),
					);
				} catch (error) {
					if (
						!(
							error instanceof ControllerRefusal &&
							error.code === "scope-unavailable"
						)
					)
						throw error;
				}
			}
			return results;
		})()
			.catch((error) => {
				this.idleError =
					"Scope cleanup sweep failed; operator inspection required";
				throw error;
			})
			.finally(() => {
				this.sweeping = null;
			});
		return this.sweeping;
	}
	close() {
		this.closing ??= (async () => {
			if (this.timer) clearInterval(this.timer);
			for (const work of this.work.values()) work.abort.abort();
			await this.sweeping;
			await Promise.allSettled(
				[...this.closures.values()].map(({ operation }) => operation),
			);
			await this.manager.close();
			await Promise.allSettled(
				[...this.work.values()].map((work) => work.finished),
			);
			await this.store.close();
		})();
		return this.closing;
	}
}

export type BoundEnvironmentController = ReturnType<
	EnvironmentController["bind"]
>;
