// Action and script routes (`port-action-execution-to-bun`, tasks 4.1–4.5).
//
// Ported from `server/pkg/server/{handlers_action_definitions,
// handlers_action_history,handlers_action_events,handlers_scripts,
// handlers_build}.go` for the fifteen `actions` and `scripts` route rows.
//
// Three responsibilities live here and nothing else:
//
//   - the **definition providers** (`rebuildDefinitions`): the only place
//     discovery, the tool probe and the compilers meet;
//   - the **run bridge**: reserve, execute, project, broadcast and persist, so
//     one Bun owner records run state and history stays replayable;
//   - the **route contract**: status codes, envelopes, bounds and the
//     compaction history consumers depend on.
//
// Persistence follows Go's split exactly: output chunks go to the per-run log
// (`action_log_events`), every other `action.*` event goes to the bounded event
// log (`action_events`). An SDK-only container or Kubernetes operation with no
// Bun capability is dispatched through the bounded private adapter
// (`runtime-adapter.ts`), which allocates no run tree — Bun stays the sole
// run/history owner.
import fs from "node:fs";
import path from "node:path";
import type { ActionDefinition, ActionStepDefinition } from "@devenv/types";
import {
	type CommandEvent,
	type CommandEventSink,
	CommandHandler,
	OSCommandRunner,
} from "./command.ts";
import {
	compileDockerLifecycleActions,
	compileGitActions,
	compileInfrastructure,
	compileKubernetesClusterActions,
	compileKubernetesLifecycleActions,
} from "./compile.ts";
import { Coordinator } from "./coordinator.ts";
import { discoverActionTargets } from "./discovery.ts";
import { type CommandStepHandler, Engine, type EngineEvent } from "./engine.ts";
import {
	eventStreamResponse,
	type LegacyEvent,
	LegacyEventStream,
} from "./event-stream.ts";
import { MemoryProcessStore, ProcessHandler } from "./process.ts";
import { ActionRunProjection } from "./projection.ts";
import {
	ComposeReadinessProbe,
	ContainerHealthProbe,
	KubernetesPodReadinessProbe,
	ReadinessHandler,
	StandardProbeFactory,
} from "./readiness.ts";
import { ActionRegistry, type ActionSnapshot } from "./registry.ts";
import {
	type ActionRun,
	definitionSnapshot,
	RUN_STATUS,
	RunRegistry,
} from "./run-registry.ts";
import {
	buildScriptTree,
	createScriptFile,
	DEFAULT_NEW_SCRIPT_TEMPLATE,
	deleteScriptTarget,
	discoverScripts,
	fetchScriptMetadata,
	linkScriptFile,
	MAX_ARGS_HISTORY_LIMIT,
	METADATA_WORKERS,
	mapBounded,
	resolveScriptExecutionPlan,
	ScriptMetadataCache,
	scriptsDir,
	writeShellActionScript,
} from "./scripts.ts";
import {
	type HandlerContext,
	OUTCOME,
	STEP_KIND,
	type StepResult,
} from "./step-result.ts";
import {
	compileContainerTargetsWithTools,
	type DependencyResolver,
} from "./target-compile.ts";
import type { ActionTarget, InfraService, ToolSet } from "./targets.ts";
import { checkToolAvailability } from "./toolcheck.ts";
import type { Value } from "./values.ts";

/** Dispatches one SDK-only container or Kubernetes operation (task 4.1). */
export interface RuntimeOperationDispatch {
	execute(request: {
		operation: string;
		containerId?: string;
		parameters?: Record<string, unknown>;
		owner: { runId: string; stepId: string; commandId: string };
		signal: AbortSignal;
	}): Promise<{ ok: boolean; output: string; error?: string }>;
}

export interface ActionApp {
	readonly ident: string;
	readonly localDirectoryPath: string;
}

export interface ActionRouteServices {
	readonly configDir: string;
	readonly homeDir: string;
	readonly apps: {
		getAppByIdent(ident: string): ActionApp | undefined;
		getApps(): readonly ActionApp[];
	};
	readonly infraServices: readonly InfraService[];
	/** The Bun-owned state store: action history, log history, script args. */
	readonly state: {
		addActionEvent(eventJson: string, maxEntries?: number): void;
		getActionEventsSince(limit: number, since: Date): string[];
		getActionEventsBetween(limit: number, since: Date, before: Date): string[];
		addActionLogEvent(
			runId: string,
			stepId: string,
			eventJson: string,
			maxEntries?: number,
		): void;
		getActionLogEvents(runId: string, stepId: string, limit?: number): string[];
		getScriptArgsHistory(
			relativePath: string,
			limit?: number,
		): Array<Record<string, string>>;
		addScriptArgsHistory(
			relativePath: string,
			values: Record<string, string>,
			maxEntries?: number,
		): void;
	};
	/** Fan-out to the subscription hub; `action.*` events only. */
	readonly publish: (event: {
		type: string;
		properties: Record<string, unknown>;
		timestamp: string;
	}) => void;
	readonly registry?: ActionRegistry;
	readonly runs?: RunRegistry;
	readonly coordinator?: Coordinator;
	readonly processes?: MemoryProcessStore;
	readonly tools?: () => ToolSet | Promise<ToolSet>;
	/** Temp directory the Docker build-context marker uses. */
	readonly tempDir?: string;
	/** Durable dependency leases for owned infrastructure. */
	readonly leases?: import("../runtime/leases.ts").DependencyLeases;
	/** Script infrastructure lifecycle: tmux/logged launch and terminal state. */
	readonly scriptInfra?: import("./process.ts").ScriptInfraLauncher;
	/** Records the target a completed run used, for the status API. */
	readonly recordRunTarget?: (
		definition: ActionDefinition,
		app: { readonly ident: string; readonly localDirectoryPath: string },
	) => boolean;
	readonly runtime?: RuntimeOperationDispatch;
	readonly stream?: LegacyEventStream;
	readonly now?: () => Date;
	readonly logger?: (message: string) => void;
}

export interface ActionRouteContext {
	readonly services: ActionRouteServices;
	readonly registry: ActionRegistry;
	readonly runs: RunRegistry;
	readonly coordinator: Coordinator;
	readonly processes: MemoryProcessStore;
	readonly metadataCache: ScriptMetadataCache;
	readonly cancels: Map<string, AbortController>;
	/** The `/api/events` SSE fan-out this family owns. */
	readonly stream: LegacyEventStream;
}

export function createActionRouteContext(
	services: ActionRouteServices,
): ActionRouteContext {
	return {
		services,
		registry: services.registry ?? new ActionRegistry(),
		runs: services.runs ?? new RunRegistry(services.now),
		coordinator: services.coordinator ?? new Coordinator(),
		processes: services.processes ?? new MemoryProcessStore(),
		metadataCache: new ScriptMetadataCache(),
		cancels: new Map(),
		stream: services.stream ?? new LegacyEventStream(),
	};
}

// --- definition providers --------------------------------------------------

/** The resolver the application provider uses for dependency references. */
export function targetResolver(
	apps: readonly ActionApp[],
	infraServices: readonly InfraService[],
	configDir: string,
): DependencyResolver {
	const standardCompose = (ident: string): string =>
		path.join(configDir, "apps", "compose", `${ident}-compose.yml`);
	return (ref) => {
		if (ref.infra) {
			for (const service of infraServices) {
				if (service.ident !== ref.infra) continue;
				let runtime = "docker";
				let provider = ref.provider;
				let command = "";
				let args: string[] = [];
				let source = standardCompose(service.ident);
				if (service.type === "script") {
					runtime = "shell";
					command = "/bin/sh";
					source = service.shellPath ?? "";
					args = [service.shellPath ?? "", ...(service.args ?? [])];
					if (ref.runtime === "powershell") {
						runtime = "powershell";
						command = "pwsh";
						source = service.powerShellPath ?? "";
						args = [
							"-File",
							service.powerShellPath ?? "",
							...(service.args ?? []),
						];
					}
				} else if (service.type === "kubernetes") {
					runtime = "kubernetes";
					source = service.kubernetes?.chartPath ?? source;
				}
				if (ref.runtime && ref.runtime !== runtime) continue;
				if (!provider && runtime === "docker") provider = "docker";
				const target: ActionTarget = {
					id: `infra/${service.ident}`,
					action: "run",
					runtime: runtime as ActionTarget["runtime"],
					label: service.displayName,
					sourcePath: source,
					workingDir:
						service.cwd && service.cwd !== ""
							? service.cwd
							: path.dirname(source),
					command,
					args,
					...(service.env ? { env: service.env } : {}),
					...(provider ? { provider } : {}),
				};
				if (service.kubernetes) {
					const kube = service.kubernetes;
					const profile = kube.profile ?? "";
					if (ref.profile && ref.profile !== profile) continue;
					target.profile = profile;
					target.kubernetes = {
						provider: kube.provider === "podman" ? "podman" : "docker",
						clusterName: kube.cluster,
						contextName: kube.context,
						chartPath: kube.chartPath ?? "",
						release: kube.release ?? "",
						namespace: kube.namespace,
						valuesFiles: kube.values,
					};
				}
				if (ref.profile && target.profile !== ref.profile) continue;
				return { appIdent: service.ident, target };
			}
			return undefined;
		}
		for (const app of apps) {
			if (ref.app !== app.ident) continue;
			for (const candidate of discoverActionTargets({
				appIdent: app.ident,
				localDir: app.localDirectoryPath,
				action: "run",
				configDir,
				platform: process.platform,
			})) {
				if (candidate.action !== "run") continue;
				if (ref.runtime && candidate.runtime !== ref.runtime) continue;
				if (ref.profile && candidate.profile !== ref.profile) continue;
				const resolved: ActionTarget = { ...candidate };
				if (
					resolved.runtime === "docker" ||
					resolved.runtime === "kubernetes"
				) {
					resolved.provider = ref.provider ?? "docker";
				}
				if (ref.provider && resolved.provider !== ref.provider) continue;
				return { appIdent: app.ident, target: resolved };
			}
		}
		return undefined;
	};
}

/**
 * Compiles the whole definition snapshot: application targets (with the docker
 * and podman variants and their lifecycle actions), kubernetes cluster actions,
 * infrastructure services and git actions per app. A provider that throws
 * leaves the previous snapshot current and records the error the status route
 * reports.
 */
export async function rebuildDefinitions(
	services: ActionRouteServices,
	registry: ActionRegistry,
): Promise<ActionSnapshot> {
	const tools = services.tools
		? await services.tools()
		: checkToolAvailability();
	const apps = services.apps.getApps();
	const resolver = targetResolver(
		apps,
		services.infraServices,
		services.configDir,
	);
	try {
		const snapshot = await registry.rebuild(
			[
				{
					name: "application-targets",
					compile: () => {
						const definitions: ActionDefinition[] = [];
						const seen = new Set<string>();
						const push = (compiled: readonly ActionDefinition[]): void => {
							for (const definition of compiled) {
								if (seen.has(definition.id)) continue;
								seen.add(definition.id);
								definitions.push(definition);
							}
						};
						for (const app of apps) {
							const targets: ActionTarget[] = [];
							for (const action of ["build", "test", "run"] as const) {
								for (const target of discoverActionTargets({
									appIdent: app.ident,
									localDir: app.localDirectoryPath,
									action,
									configDir: services.configDir,
									platform: process.platform,
								})) {
									targets.push(target);
									if (target.action === "run" && target.runtime === "docker") {
										targets.push({ ...target, provider: "podman" });
									}
								}
							}
							for (const target of targets) {
								push(
									compileContainerTargetsWithTools(
										app.ident,
										target,
										resolver,
										tools,
										{
											checkoutDir: app.localDirectoryPath,
											configDir: services.configDir,
											tempDir: services.tempDir ?? "",
										},
									),
								);
								push(compileDockerLifecycleActions(app.ident, target));
								push(compileKubernetesLifecycleActions(app.ident, target));
							}
							push(compileGitActions(app.ident, app.localDirectoryPath));
						}
						return definitions;
					},
				},
				{
					name: "kubernetes-cluster",
					compile: () =>
						compileKubernetesClusterActions(tools, services.homeDir),
				},
				{
					name: "infrastructure",
					compile: () =>
						services.infraServices.flatMap((service) =>
							compileInfrastructure(service),
						),
				},
			],
			{
				has: (kind: string) =>
					kind === STEP_KIND.command ||
					kind === STEP_KIND.process ||
					kind === STEP_KIND.readiness ||
					kind === STEP_KIND.operation ||
					kind === STEP_KIND.cleanup,
			},
		);
		lastRegistryError = undefined;
		services.logger?.(
			`[INFO] action registry v${snapshot.version}: ${snapshot.definitions.length} definitions`,
		);
		return snapshot;
	} catch (error) {
		lastRegistryError = message(error);
		services.logger?.(
			`[WARN] action registry rebuild failed: ${lastRegistryError}`,
		);
		throw error;
	}
}

let lastRegistryError: string | undefined;

/** The last rebuild failure, as `GET /api/action-registry/status` reports it. */
export function registryBuildError(): string | undefined {
	return lastRegistryError;
}

// --- dispatch --------------------------------------------------------------

const APP_ACTIONS_PATTERN = /^\/api\/apps\/([^/]+)\/actions$/;

/** Serves one `actions` or `scripts` route; `undefined` for any other family. */
export async function handleActionRoute(
	context: ActionRouteContext,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const { services } = context;
	const method = request.method.toUpperCase();
	const scriptsDirectory = scriptsDir(services.homeDir);

	const appActions = APP_ACTIONS_PATTERN.exec(url.pathname);
	if (appActions && method === "GET") {
		return actionsForApp(context, appActions[1] ?? "", url);
	}

	switch (url.pathname) {
		case "/api/events": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			// A reconnecting client sees the in-flight runs immediately, and
			// finished runs past their retention window are pruned first.
			context.runs.cleanup();
			const snapshot = (): LegacyEvent[] =>
				context.runs.active().map((run) => ({
					type: "action.started",
					properties: { run },
					timestamp: new Date().toISOString(),
				}));
			return eventStreamResponse(context.stream, request, snapshot);
		}
		case "/api/action-registry/status": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			const snapshot = context.registry.snapshot();
			const error = registryBuildError();
			return json({
				version: snapshot.version,
				actionsCount: snapshot.definitions.length,
				error: error ?? "",
				available: error === undefined && snapshot.version > 0,
			});
		}
		case "/api/action-definition": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			const id = url.searchParams.get("id") ?? "";
			if (id === "") return errorResponse(400, "id query parameter required");
			const definition = context.registry.snapshot().get(id);
			if (!definition) return errorResponse(404, "Action not found");
			return json(definition);
		}
		case "/api/action-runs": {
			if (method !== "POST") return errorResponse(405, "Method not allowed");
			return startActionRun(context, request);
		}
		case "/api/actions/cancel": {
			if (method !== "POST") return errorResponse(405, "Method not allowed");
			return cancelAction(context, request);
		}
		case "/api/actions/history": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			return actionHistory(context, url);
		}
		case "/api/actions/logs": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			const runId = url.searchParams.get("runId") ?? "";
			if (runId === "") return errorResponse(400, "runId is required");
			return json(
				compactActionHistory(
					services.state.getActionLogEvents(
						runId,
						url.searchParams.get("stepId") ?? "",
						50000,
					),
				),
			);
		}
		case "/api/actions/events": {
			if (method !== "POST") return errorResponse(405, "Method not allowed");
			return reportActionEvent(context, request);
		}
		case "/api/actions/shell-script": {
			if (method !== "POST" && method !== "PUT") {
				return errorResponse(405, "Method not allowed");
			}
			return shellActionScript(context, request);
		}
		case "/api/scripts": {
			if (method === "GET") return listScripts(context, scriptsDirectory);
			if (method === "POST")
				return executeScript(context, request, scriptsDirectory);
			return errorResponse(405, "Method not allowed");
		}
		case "/api/scripts/create": {
			if (method !== "POST") return errorResponse(405, "Method not allowed");
			return mutateScript(context, request, scriptsDirectory, "create");
		}
		case "/api/scripts/link": {
			if (method !== "POST") return errorResponse(405, "Method not allowed");
			return mutateScript(context, request, scriptsDirectory, "link");
		}
		case "/api/scripts/delete": {
			if (method !== "DELETE") return errorResponse(405, "Method not allowed");
			return mutateScript(context, request, scriptsDirectory, "delete");
		}
		case "/api/scripts/history": {
			if (method === "GET") return scriptArgsHistory(context, url);
			if (method === "POST") return addScriptArgsHistory(context, request);
			return errorResponse(405, "Method not allowed");
		}
		case "/api/scripts/metadata": {
			if (method !== "GET") return errorResponse(405, "Method not allowed");
			return scriptMetadata(context, scriptsDirectory, url);
		}
		default:
			return undefined;
	}
}

function actionsForApp(
	context: ActionRouteContext,
	ident: string,
	url: URL,
): Response {
	const kind = url.searchParams.get("kind") ?? "app";
	if (ident === "") return errorResponse(400, "ident path parameter required");
	const snapshot = context.registry.snapshot();
	if (snapshot.version === 0 && snapshot.definitions.length === 0) {
		return json({ version: 0, actions: [] });
	}
	return json({
		version: snapshot.version,
		actions: snapshot.forResource({ kind, id: ident }),
	});
}

// --- runs ------------------------------------------------------------------

async function startActionRun(
	context: ActionRouteContext,
	request: Request,
): Promise<Response> {
	const { services, registry, runs } = context;
	let body: { actionId?: string; inputs?: Record<string, unknown> };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "invalid action run request");
	}
	const snapshot = registry.snapshot();
	if (snapshot.version === 0 && snapshot.definitions.length === 0) {
		return errorResponse(503, "Action registry unavailable");
	}
	let definition = snapshot.get(body.actionId ?? "");
	if (!definition) return errorResponse(404, "Action not found");
	if (!definition.availability.available) {
		return errorResponse(
			409,
			definition.availability.reason ?? "Action unavailable",
		);
	}
	const blocked = dependencyStopBlocked(context, definition);
	if (blocked) return errorResponse(409, blocked);

	const inputs = body.inputs ?? {};
	const allowed = new Set<string>();
	for (const input of definition.inputs) {
		allowed.add(input.key);
		if (
			input.required &&
			!(input.key in inputs) &&
			input.default === undefined
		) {
			return errorResponse(400, `missing required input: ${input.key}`);
		}
	}
	for (const key of Object.keys(inputs)) {
		if (!allowed.has(key)) return errorResponse(400, `unknown input: ${key}`);
	}

	definition = prepareInfrastructureDockerAction(definition, services);
	const runId = `action-${crypto.randomUUID()}`;
	const run = {
		id: runId,
		title: definition.label,
		appIdent: definition.owner.id,
		action: definition.type,
		kind: actionKind(definition.type),
		profile: definition.runtime,
		targetLabel: definition.label,
		status: RUN_STATUS.active,
		steps: [],
		startedAt: new Date().toISOString(),
		registryVersion: snapshot.version,
		definitionSnapshot: definitionSnapshot(definition),
	};
	try {
		runs.start(run, definition.owner.id, definition.type);
	} catch (error) {
		return errorResponse(409, message(error));
	}
	publishAndPersist(context, "action.started", { run });
	const controller = new AbortController();
	context.cancels.set(runId, controller);
	// The run is asynchronous: the client learns its id from the response and
	// follows progress through the event stream, exactly as the Go owner did.
	void executeRun(context, definition, runId, inputs, controller.signal);
	return json(
		{
			success: true,
			actionId: definition.id,
			runId,
			registryVersion: snapshot.version,
		},
		202,
	);
}

/**
 * Records an operation that has no step tree: the Docker API container
 * lifecycle calls (`docker.container.start|stop|restart`) create a run so the
 * action appears in history, but allocate no command because no process ran.
 * This is what keeps `already-running` honest — nothing fabricates a command
 * for work the runtime API did.
 */
export function recordCommandlessRun(
	context: ActionRouteContext,
	input: {
		readonly title: string;
		readonly appIdent: string;
		readonly action: string;
		readonly targetLabel?: string;
		readonly error?: string;
	},
): string {
	const now = new Date().toISOString();
	const run: ActionRun = {
		id: `action-${crypto.randomUUID()}`,
		title: input.title,
		status: input.error ? RUN_STATUS.failed : RUN_STATUS.active,
		steps: [],
		appIdent: input.appIdent,
		action: input.action,
		profile: "",
		...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
		startedAt: now,
	};
	try {
		context.runs.start(run, input.appIdent, input.action);
	} catch {
		// A second lifecycle call for the same app/action is not a new run.
		return "";
	}
	publishAndPersist(context, "action.started", { run });
	const status = input.error ? RUN_STATUS.failed : RUN_STATUS.completed;
	context.runs.complete(run.id, status);
	publishAndPersist(context, "action.completed", {
		runId: run.id,
		status,
		...(input.error ? { error: input.error } : {}),
	});
	return run.id;
}

/** Persists and broadcasts one non-output action event. */
function publishAndPersist(
	context: ActionRouteContext,
	type: string,
	properties: Record<string, unknown>,
): void {
	const payload = { type, properties, timestamp: new Date().toISOString() };
	context.stream.publish(payload);
	context.services.publish(payload);
	context.services.state.addActionEvent(JSON.stringify(payload));
}

/** Broadcasts one event without persisting it (output chunks and step chatter). */
function broadcast(context: ActionRouteContext, event: LegacyEvent): void {
	context.stream.publish(event);
	context.services.publish(event);
}

/** Runs one definition to completion and records its lifecycle. Never rejects. */
async function executeRun(
	context: ActionRouteContext,
	definition: ActionDefinition,
	runId: string,
	rawInputs: Record<string, unknown>,
	signal: AbortSignal,
): Promise<void> {
	const { services, runs, processes } = context;
	const projection = new ActionRunProjection(runs);
	const events = {
		emit: (event: EngineEvent): void => {
			projection.emit(event);
			publishAndPersist(context, `action.${event.type}`, {
				runId: event.runId,
				stepId: event.stepId,
				label: event.label,
				outcome: event.outcome,
				...(event.canonicalId ? { canonicalId: event.canonicalId } : {}),
				...(event.reference ? { sharedReference: true } : {}),
				...(event.error ? { error: event.error } : {}),
			});
		},
	};
	const commandSink: CommandEventSink = {
		emitCommand: (event: CommandEvent): void => {
			const properties = {
				runId,
				stepId: event.stepId,
				commandId: `${event.stepId}-command-0`,
				command: [event.command, ...(event.args ?? [])]
					.filter(Boolean)
					.join(" "),
				...(event.stream ? { stream: event.stream } : {}),
				...(event.chunk ? { output: event.chunk } : {}),
				...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
				...(event.error ? { error: event.error } : {}),
			};
			const payload = {
				type: `action.${event.type}`,
				properties,
				timestamp: new Date().toISOString(),
			};
			broadcast(context, payload);
			// Output goes to the per-run log, everything else to the bounded
			// event log — the same split Go's broadcast performs.
			if (event.type === "command.output" || event.type === "step.output") {
				services.state.addActionLogEvent(
					runId,
					event.stepId,
					JSON.stringify(payload),
				);
			} else {
				services.state.addActionEvent(JSON.stringify(payload));
			}
		},
	};
	// A `git` step runs through the same Bun argv boundary the Git capability
	// uses, in-process: the earlier Go-owned bridge is not in this path.
	const command = new CommandHandler(new OSCommandRunner(), commandSink);
	const readiness = new ReadinessHandler(
		new StandardProbeFactory({
			processes,
			compose: (step) => {
				const configuration = step.configuration ?? {};
				return new ComposeReadinessProbe(
					new OSCommandRunner(),
					String(configuration.command ?? ""),
					Array.isArray(configuration.args)
						? configuration.args.filter(
								(a): a is string => typeof a === "string",
							)
						: [],
					1000,
				);
			},
			container: (containerId) =>
				new ContainerHealthProbe(
					new OSCommandRunner(),
					containerId,
					1000,
					"docker",
				),
			kubernetes: (step) => {
				const configuration = step.configuration ?? {};
				const timeout =
					typeof configuration.timeout === "string" &&
					configuration.timeout !== ""
						? configuration.timeout
						: "5m";
				return new KubernetesPodReadinessProbe(
					new OSCommandRunner(),
					String(configuration.context ?? ""),
					String(configuration.namespace ?? ""),
					`app.kubernetes.io/instance=${String(configuration.resource ?? "")}`,
					timeout,
					1000,
				);
			},
		}),
	);
	const operationHandler: CommandStepHandler = {
		execute: (handlerContext: HandlerContext, step: ActionStepDefinition) =>
			runOperation(context, handlerContext, step),
	};
	const engine = new Engine({
		handlers: new Map<string, CommandStepHandler>([
			[STEP_KIND.command, command],
			[STEP_KIND.cleanup, command],
			[
				STEP_KIND.process,
				new ProcessHandler(
					processes,
					commandSink,
					context.services.scriptInfra,
				),
			],
			[STEP_KIND.readiness, readiness],
			[STEP_KIND.operation, operationHandler],
		]),
		events,
		coordinator: context.coordinator,
	});

	// Inputs arrive from a request body as JSON; Go hands them to the run as
	// public string values, which is also what the TUI sends.
	const inputs = new Map<string, Value>();
	for (const [key, value] of Object.entries(rawInputs)) {
		inputs.set(key, { type: "string", visibility: "public", data: value });
	}
	let status: string = RUN_STATUS.completed;
	try {
		const result = await engine.run(signal, runId, definition, inputs);
		if (signal.aborted) status = RUN_STATUS.canceled;
		else if (result.error || result.outcome === OUTCOME.failed) {
			status = RUN_STATUS.failed;
		}
	} catch (error) {
		status = RUN_STATUS.failed;
		services.logger?.(`[ERROR] action ${runId} failed: ${message(error)}`);
	} finally {
		context.cancels.delete(runId);
		runs.complete(runId, status as typeof RUN_STATUS.completed);
		publishAndPersist(context, "action.completed", { runId, status });
		// Only a completed run moves leases: a failed or cancelled run owns
		// nothing, and a stop that did not complete keeps its dependents' leases.
		if (status === RUN_STATUS.completed) {
			if (definition.type === "run") {
				context.services.leases?.leaseFromDefinition(definition, runId);
				if (definition.owner.kind === "app") {
					const app = services.apps.getAppByIdent(definition.owner.id);
					if (app) context.services.recordRunTarget?.(definition, app);
				}
			}
			if (definition.type === "stop") {
				context.services.leases?.releaseForOwner(definition.owner.id);
			}
		}
	}
}

/**
 * An SDK-only operation: a real Bun capability when one exists (argv-based
 * container and Kubernetes work is a `command` step, not this), otherwise the
 * bounded private adapter. With no adapter configured the step fails loudly
 * rather than reporting success for work that did not happen.
 */
async function runOperation(
	context: ActionRouteContext,
	handlerContext: HandlerContext,
	step: ActionStepDefinition,
): Promise<StepResult> {
	const operation = String(step.configuration?.operation ?? "");
	const runtime = context.services.runtime;
	if (operation === "" || operation === "noop")
		return { outcome: OUTCOME.executed };
	if (!runtime) {
		return {
			outcome: OUTCOME.failed,
			error: new Error(
				`no runtime adapter for operation ${JSON.stringify(operation)}`,
			),
		};
	}
	const result = await runtime.execute({
		operation,
		...(typeof step.configuration?.containerId === "string"
			? { containerId: step.configuration.containerId }
			: {}),
		...(isRecord(step.configuration?.parameters)
			? { parameters: step.configuration.parameters }
			: {}),
		owner: {
			runId: handlerContext.runId,
			stepId: step.id,
			commandId: `${step.id}-command-0`,
		},
		signal: handlerContext.signal,
	});
	if (result.ok) return { outcome: OUTCOME.executed };
	return {
		outcome: OUTCOME.failed,
		error: new Error(result.error ?? "operation failed"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-points an infrastructure Docker action at its configured compose file, as
 * the Go handler does before starting the run.
 */
function prepareInfrastructureDockerAction(
	definition: ActionDefinition,
	services: ActionRouteServices,
): ActionDefinition {
	if (
		definition.owner.kind !== "infrastructure" ||
		definition.runtime !== "docker"
	) {
		return definition;
	}
	const service = services.infraServices.find(
		(s) => s.ident === definition.owner.id,
	);
	if (!service) return definition;
	const sourcePath = path.join(
		services.configDir,
		"apps",
		"compose",
		`${service.ident}-compose.yml`,
	);
	const children = (definition.root.children ?? []).map((child) => {
		if (child.kind !== "command") return child;
		const args = Array.isArray(child.configuration?.args)
			? (child.configuration?.args as string[])
			: [];
		return {
			...child,
			handler: "docker",
			configuration: {
				command: "docker-compose",
				args: ["-f", sourcePath, ...args],
			},
		};
	});
	return { ...definition, root: { ...definition.root, children } };
}

/** Whether a `stop` is refused because an active run still depends on it. */
function dependencyStopBlocked(
	context: ActionRouteContext,
	definition: ActionDefinition,
): string | undefined {
	if (definition.type !== "stop") return undefined;
	for (const run of context.runs.active()) {
		if (run.id === definition.id) continue;
		if (run.appIdent === definition.owner.id) {
			return `${definition.owner.id} has an active run (${run.id})`;
		}
	}
	// A durable lease another app holds on this infrastructure blocks the stop.
	return context.services.leases?.stopBlocked(definition)?.message;
}

export function actionKind(action: string): string {
	if (action.includes("worktree")) return "worktree";
	if (
		action.startsWith("git") ||
		action === "checkout" ||
		action === "pull" ||
		action === "push" ||
		action === "fetch"
	) {
		return "git";
	}
	if (action.includes("kubernetes")) return "kubernetes";
	if (action.includes("infra")) return "infrastructure";
	if (action.includes("task") || action.includes("script")) return "task";
	return "app";
}

async function cancelAction(
	context: ActionRouteContext,
	request: Request,
): Promise<Response> {
	let body: { ident?: string };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "ident field required");
	}
	const ident = (body.ident ?? "").trim();
	if (ident === "") return errorResponse(400, "ident field required");
	for (const run of context.runs.activeForApp(ident)) {
		context.cancels.get(run.id)?.abort(new Error("action canceled"));
		context.runs.cancel(run.id);
		publishAndPersist(context, "action.completed", {
			runId: run.id,
			status: "canceled",
		});
	}
	return json({ success: true });
}

function actionHistory(context: ActionRouteContext, url: URL): Response {
	const raw = url.searchParams.get("limit") ?? "";
	let limit = 50000;
	if (raw !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0 && parsed <= 50000)
			limit = parsed;
	}
	const now = context.services.now ? context.services.now() : new Date();
	let since = new Date(now.getTime() - 10 * 60 * 1000);
	let before: Date | undefined;
	switch (url.searchParams.get("scope")) {
		case "all":
			since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
			break;
		case "older":
			since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
			before = new Date(now.getTime() - 10 * 60 * 1000);
			break;
		default:
			break;
	}
	const stored =
		before === undefined
			? context.services.state.getActionEventsSince(limit, since)
			: context.services.state.getActionEventsBetween(limit, since, before);
	return json(compactActionHistory(stored));
}

/**
 * Joins consecutive output chunks of the same command and stream, so a history
 * consumer receives every byte without one replay step per chunk. Anything that
 * is not a well-formed output event is passed through untouched.
 */
export function compactActionHistory(stored: readonly string[]): unknown[] {
	const result: unknown[] = [];
	let pending:
		| { type: string; properties: Record<string, unknown>; timestamp?: unknown }
		| undefined;
	let pendingKey = "";
	const flush = (): void => {
		if (pending) result.push(pending);
		pending = undefined;
	};
	for (const payload of stored) {
		let event: {
			type?: unknown;
			properties?: unknown;
			timestamp?: unknown;
		};
		try {
			event = JSON.parse(payload) as typeof event;
		} catch {
			flush();
			result.push(payload);
			continue;
		}
		const type = typeof event.type === "string" ? event.type : "";
		const properties = isRecord(event.properties) ? event.properties : {};
		const isOutput =
			type === "action.command.output" || type === "action.step.output";
		if (!isOutput) {
			flush();
			result.push({
				type,
				properties,
				...(event.timestamp !== undefined
					? { timestamp: event.timestamp }
					: {}),
			});
			continue;
		}
		const key = [
			properties.runId,
			properties.stepId,
			properties.commandId,
			properties.stream,
		].join("\u0000");
		if (pending && pendingKey === key) {
			pending.properties.output = `${String(pending.properties.output ?? "")}${String(properties.output ?? "")}`;
			continue;
		}
		flush();
		pending = {
			type,
			properties: { ...properties },
			timestamp: event.timestamp,
		};
		pendingKey = key;
	}
	flush();
	return result;
}

async function reportActionEvent(
	context: ActionRouteContext,
	request: Request,
): Promise<Response> {
	let body: { type?: string; properties?: Record<string, unknown> };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "Invalid action event");
	}
	const type = body.type ?? "";
	if (!type.startsWith("action.") || type === "action.history") {
		return errorResponse(400, "Unsupported action event");
	}
	publishAndPersist(context, type, body.properties ?? {});
	return new Response(null, { status: 204 });
}

async function shellActionScript(
	context: ActionRouteContext,
	request: Request,
): Promise<Response> {
	const { services } = context;
	let body: {
		ident?: string;
		action?: string;
		profile?: string;
		command?: string;
		runtime?: string;
	};
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "Invalid request body");
	}
	const ident = body.ident ?? "";
	const action = body.action ?? "";
	if (ident === "" || action === "") {
		return errorResponse(400, "ident and action fields required");
	}
	if (!services.apps.getAppByIdent(ident)) {
		return errorResponse(404, "App not found");
	}
	const runtime =
		body.runtime === undefined || body.runtime === "" ? "shell" : body.runtime;
	if (runtime !== "shell" && runtime !== "powershell") {
		return errorResponse(400, `unsupported action runtime ${runtime}`);
	}
	try {
		const scriptPath = writeShellActionScript(services.configDir, {
			appIdent: ident,
			action,
			profile: body.profile ?? "",
			command: body.command ?? "",
			extension: runtime === "powershell" ? ".ps1" : ".sh",
		});
		return json({ success: true, path: scriptPath });
	} catch (error) {
		return errorResponse(400, message(error));
	}
}

// --- scripts ---------------------------------------------------------------

async function listScripts(
	context: ActionRouteContext,
	scriptsDirectory: string,
): Promise<Response> {
	const discovered = discoverScripts(scriptsDirectory, {
		platform: process.platform,
	});
	// Metadata discovery forks an interpreter per script, so it is bounded.
	const withMetadata = await mapBounded(
		discovered,
		METADATA_WORKERS,
		async (script) => ({
			...script,
			parameters: await fetchScriptMetadata(script.absolutePath, {
				cache: context.metadataCache,
			}),
		}),
	);
	return json({ scripts: buildScriptTree(withMetadata) });
}

/**
 * Executes one discovered script as a run with a single command step, which is
 * how Go's `runScriptAction` records it: the script is the command, its output
 * is the step's output, and the response carries both streams concatenated. A
 * failing script is still a `200` with `success: false` — the client shows the
 * output, it does not treat it as a transport failure.
 */
async function executeScript(
	context: ActionRouteContext,
	request: Request,
	scriptsDirectory: string,
): Promise<Response> {
	let body: { relativePath?: string; args?: string[] };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "invalid request body");
	}
	const relativePath = (body.relativePath ?? "").trim();
	if (relativePath === "")
		return errorResponse(400, "relativePath is required");
	const discovered = discoverScripts(scriptsDirectory, {
		platform: process.platform,
	});
	const script = discovered.find(
		(candidate) => candidate.relativePath === relativePath.replace(/^\//, ""),
	);
	if (!script) return errorResponse(404, "Script not found");
	let plan: ReturnType<typeof resolveScriptExecutionPlan>;
	try {
		plan = resolveScriptExecutionPlan(script, body.args ?? [], {
			platform: process.platform,
		});
	} catch (error) {
		return errorResponse(400, message(error));
	}

	// One run, one command step: the accounting the client renders.
	const runId = `action-${crypto.randomUUID()}`;
	const ident = `script:${script.relativePath}`;
	const stepId = `${ident}:command-step-0`;
	const commandId = `${stepId}-command-0`;
	const commandLine = [plan.command, ...plan.args].join(" ");
	const run = {
		id: runId,
		title: `Run task ${script.relativePath}`,
		appIdent: ident,
		action: "task.run",
		kind: "task",
		status: RUN_STATUS.active,
		steps: [
			{
				id: stepId,
				label: `Run task ${script.relativePath}`,
				status: RUN_STATUS.active,
				commands: [],
			},
		],
		startedAt: new Date().toISOString(),
		registryVersion: context.registry.snapshot().version,
	};
	context.runs.start(run, ident, "task.run");
	publishAndPersist(context, "action.started", { run });
	publishAndPersist(context, "action.step.started", {
		runId,
		stepId,
		label: run.title,
	});
	publishAndPersist(context, "action.command.started", {
		runId,
		stepId,
		commandId,
		command: commandLine,
		index: 0,
	});

	const controller = new AbortController();
	const result = await new OSCommandRunner().run(
		{
			name: plan.command,
			args: plan.args,
			dir: plan.workingDir,
			runId,
			stepId,
			commandId,
		},
		(stream, chunk) => {
			const payload = {
				type: "action.command.output",
				properties: {
					runId,
					stepId,
					commandId,
					command: commandLine,
					stream,
					output: chunk,
				},
				timestamp: new Date().toISOString(),
			};
			broadcast(context, payload);
			context.services.state.addActionLogEvent(
				runId,
				stepId,
				JSON.stringify(payload),
			);
		},
		controller.signal,
	);
	const output = `${result.stdout}${result.stderr}`;
	const status = result.error ? RUN_STATUS.failed : RUN_STATUS.completed;
	publishAndPersist(
		context,
		result.error ? "action.command.failed" : "action.command.completed",
		{
			runId,
			stepId,
			commandId,
			command: commandLine,
			exitCode: result.exitCode,
			...(result.error ? { error: result.error.message } : {}),
		},
	);
	publishAndPersist(
		context,
		result.error ? "action.step.failed" : "action.step.completed",
		{
			runId,
			stepId,
			...(result.error ? { error: result.error.message } : {}),
		},
	);
	context.runs.complete(runId, status);
	publishAndPersist(context, "action.completed", { runId, status });
	return json({
		success: result.error === undefined,
		relativePath: script.relativePath,
		interpreter: plan.command,
		...(output !== "" ? { output } : {}),
	});
}

async function mutateScript(
	_context: ActionRouteContext,
	request: Request,
	scriptsDirectory: string,
	operation: "create" | "link" | "delete",
): Promise<Response> {
	let body: { targetPath?: string; sourcePath?: string; relativePath?: string };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "invalid request body");
	}
	try {
		const result =
			operation === "create"
				? createScriptFile(
						scriptsDirectory,
						body.targetPath ?? "",
						DEFAULT_NEW_SCRIPT_TEMPLATE,
					)
				: operation === "link"
					? linkScriptFile(
							scriptsDirectory,
							body.targetPath ?? "",
							body.sourcePath ?? "",
						)
					: deleteScriptTarget(scriptsDirectory, body.relativePath ?? "");
		return json({ success: true, operation, ...result });
	} catch (error) {
		return errorResponse(400, message(error));
	}
}

function scriptArgsHistory(context: ActionRouteContext, url: URL): Response {
	const relativePath = (url.searchParams.get("relativePath") ?? "").trim();
	if (relativePath === "")
		return errorResponse(400, "relativePath is required");
	const raw = (url.searchParams.get("limit") ?? "").trim();
	let limit = 50;
	if (raw !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return errorResponse(400, "limit must be a positive integer");
		}
		limit = Math.min(parsed, MAX_ARGS_HISTORY_LIMIT);
	}
	return json({
		relativePath,
		entries: context.services.state.getScriptArgsHistory(relativePath, limit),
	});
}

async function addScriptArgsHistory(
	context: ActionRouteContext,
	request: Request,
): Promise<Response> {
	let body: { relativePath?: string; values?: Record<string, string> };
	try {
		body = (await readJson(request)) as typeof body;
	} catch {
		return errorResponse(400, "invalid request body");
	}
	const relativePath = (body.relativePath ?? "").trim();
	if (relativePath === "")
		return errorResponse(400, "relativePath is required");
	context.services.state.addScriptArgsHistory(
		relativePath,
		body.values ?? {},
		50,
	);
	return json({ success: true });
}

async function scriptMetadata(
	context: ActionRouteContext,
	scriptsDirectory: string,
	url: URL,
): Promise<Response> {
	const relativePath = (url.searchParams.get("path") ?? "").trim();
	if (relativePath === "") {
		return errorResponse(400, "path query parameter is required");
	}
	const absolutePath = path.resolve(
		path.join(scriptsDirectory, ...relativePath.split("/")),
	);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolutePath);
	} catch {
		return errorResponse(404, "Script not found");
	}
	if (stat.isDirectory()) {
		return errorResponse(400, "path must be a file, not a directory");
	}
	const cached = context.metadataCache.get(absolutePath, stat.mtimeMs);
	if (cached) return json({ parameters: cached });
	const parameters = await fetchScriptMetadata(absolutePath, {
		cache: context.metadataCache,
	});
	return json({ parameters });
}

// --- helpers --------------------------------------------------------------

/** Reads a bounded JSON body; a malformed or oversized body throws. */
async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.length > 256 * 1024) throw new Error("body too large");
	return JSON.parse(text) as unknown;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});
}

function errorResponse(status: number, text: string): Response {
	return json({ error: text }, status);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { resolveScriptExecutionPlan };
