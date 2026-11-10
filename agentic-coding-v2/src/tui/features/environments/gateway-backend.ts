// The v2 backend behind the ported v1 environments client facade.
//
// Every v1 `DevEnvClient` method arrives here by name. Reads are projected from
// the authenticated gateway's native snapshot (`state.read`); a run/build/test
// becomes one interactive `environment.action` (the key press is the approval)
// and a stop becomes `task.cancel` of the owning operator task. Native run
// output is presented as v1's action-run event stream so the original action
// modal renders it. A v1 operation v2 does not offer rejects with a visible
// message; it never falls back to a shell, Docker or another server.
import type { ClientConnection } from "../../client/connection.ts";
import type { DevEnvBackend, DevEnvMethod } from "./core/client.ts";
import type { DomainEventMessage } from "./core/domain-events-client.ts";
import type { AppSlot } from "./core/environment-client.ts";
import type {
	ActionDefinition,
	ActionDefinitionList,
	ActionRun,
	ActionRunStatus,
	ActionTarget,
	App,
	AppStatus,
	InfraService,
	KubernetesClusterStatus,
	RuntimeStatus,
	ServerEvent,
} from "./types/index.ts";

type Data = Record<string, unknown>;
type Target = {
	id: string;
	action: "run" | "build" | "test";
	runtime: string;
	profile?: string;
	label?: string;
	availability?: { eligible: boolean | null; reason: string };
};
type Project = {
	id: string;
	kind: "app" | "library" | "infrastructure";
	repository: string;
	targets: Target[];
	requires?: string[];
	defaultTargets?: Partial<
		Record<Target["action"], { id: string | null; reason: string }>
	>;
};
type Run = {
	id: string;
	batch: string;
	owner: number;
	state: "reserved" | "running" | "stopping" | "exited" | "interrupted";
	createdAt: number;
	ready: boolean | null;
	exitCode: number | null;
	signal: string | null;
	error: string | null;
	runtimeStatus?: RuntimeStatus;
	plan: {
		app: string;
		id: string;
		action: Target["action"];
		runtime: string;
		profile?: string;
		label?: string;
		projectKind?: Project["kind"];
	};
};
type Task = {
	id: number;
	kind?: string;
	status: string | null;
	detail?: string;
};

const unavailable = (what: string) =>
	new Error(
		`${what} is not available in agentic-coding-v2 yet. The native gateway refused nothing; this operation has no native backend.`,
	);

const list = <T>(value: unknown): T[] =>
	Array.isArray(value) ? (value as T[]) : [];

/** A definition id carries the native identity: `<app>/<action>/<target>`. */
const definitionId = (app: string, action: string, target: string) =>
	`${app}/${action}/${target}`;
const parseDefinition = (id: string) => {
	const [app, action, ...rest] = id.split("/");
	const target = rest.join("/");
	if (!app || !action || !target) throw new Error(`Unknown action ${id}`);
	return { app, action, target };
};

const runtimeOf = (run: Run | undefined): RuntimeStatus | undefined => {
	if (!run) return undefined;
	if (run.runtimeStatus) return run.runtimeStatus;
	switch (run.state) {
		case "reserved":
			return { state: "starting", detail: "reserved" };
		case "running":
			return run.ready === false
				? { state: "starting", detail: "starting" }
				: { state: "running", detail: run.plan.runtime };
		case "stopping":
			return { state: "starting", detail: "stopping" };
		case "interrupted":
			return { state: "failed", detail: "interrupted" };
		default:
			return run.exitCode === 0 || run.signal
				? { state: "stopped" }
				: { state: "failed", detail: run.error ?? `exit ${run.exitCode}` };
	}
};

const runStatus = (run: Run): ActionRunStatus =>
	run.state === "exited"
		? run.exitCode === 0
			? "completed"
			: run.signal
				? "canceled"
				: "failed"
		: run.state === "interrupted"
			? "failed"
			: "active";

export class GatewayBackend implements DevEnvBackend {
	/** Output already published per native run, for incremental action events. */
	private published = new Map<string, number>();
	private announced = new Map<string, ActionRunStatus>();
	constructor(
		private readonly client: ClientConnection,
		private readonly showError: (title: string, message: string) => void,
	) {}

	private environments(): Data {
		const value = this.client.state?.environments;
		return value && typeof value === "object" ? (value as Data) : {};
	}
	private projects(): Project[] {
		return list<Project>(this.environments().projects);
	}
	private runs(): Run[] {
		return list<Run>(this.environments().runs);
	}
	private tasks(): Task[] {
		return list<Task>(this.client.state?.tasks);
	}
	private project(app: string) {
		const project = this.projects().find((item) => item.id === app);
		if (!project) throw new Error(`Unknown environment app ${app}`);
		return project;
	}
	/** The newest run of an app, live runs first. */
	private latest(app: string) {
		return this.runs()
			.filter((run) => run.plan.app === app)
			.sort(
				(a, b) =>
					Number(b.state !== "exited") - Number(a.state !== "exited") ||
					b.createdAt - a.createdAt,
			)[0];
	}

	private app(project: Project): App {
		const run = this.latest(project.id);
		const runtimeStatus = runtimeOf(run);
		return {
			ident: project.id,
			resourceId: project.id,
			resourceKind: project.kind,
			displayName: project.id,
			localDirectoryPath: project.repository,
			repositoryPath: project.repository,
			branch: "",
			appType: project.kind === "library" ? "LIB" : "APP",
			containerBaseName: project.id,
			...(runtimeStatus ? { runtimeStatus } : {}),
			status: runtimeStatus?.state ?? "stopped",
			...(run && run.state !== "exited"
				? {
						runTargetInfo: {
							runtime: run.plan.runtime,
							...(run.plan.profile ? { profile: run.plan.profile } : {}),
							targetId: run.plan.id,
							label: run.plan.label ?? run.plan.id,
							startedAt: new Date(run.createdAt).toISOString(),
							display: `${run.plan.runtime} · ${run.plan.id}`,
						},
					}
				: {}),
		};
	}
	private infra(project: Project): InfraService {
		const run = this.latest(project.id);
		const runtimeStatus = runtimeOf(run);
		const runtime = project.targets.find(
			(target) => target.action === "run",
		)?.runtime;
		return {
			ident: project.id,
			resourceId: project.id,
			resourceKind: "infrastructure",
			displayName: project.id,
			type: runtime === "kubernetes" ? "kubernetes" : "docker",
			containerBaseName: project.id,
			...(runtimeStatus ? { runtimeStatus } : {}),
			status: runtimeStatus?.state ?? "stopped",
		};
	}

	private definitions(app: string): ActionDefinitionList {
		const project = this.project(app);
		const actions: ActionDefinition[] = [];
		for (const target of project.targets) {
			const chosen = project.defaultTargets?.[target.action];
			const definition = (type: string): ActionDefinition => ({
				id: definitionId(app, type, target.id),
				owner: { kind: project.kind, id: app },
				type,
				runtime: target.runtime,
				label: target.label ?? target.id,
				inputs: [],
				availability: {
					available: target.availability?.eligible !== false,
					...(target.availability?.reason
						? { reason: target.availability.reason }
						: {}),
				},
				root: {
					id: target.id,
					kind: "composite",
					label: target.label ?? target.id,
					children: [
						{
							id: `${target.id}:execute`,
							kind: "process",
							label: target.label ?? target.id,
							configuration: {
								...(target.profile ? { profile: target.profile } : {}),
								...(project.requires
									? {
											requires: project.requires.map((id) => ({
												ident: id,
											})),
										}
									: {}),
							},
						},
					],
				},
				...(type === target.action && chosen?.id === target.id
					? {
							default: true,
							defaultTargetId: target.id,
							defaultReason: chosen.reason,
						}
					: {}),
			});
			actions.push(definition(target.action));
			// v1 infrastructure rows start/stop; a native run target serves both.
			if (target.action === "run")
				actions.push(definition("start"), definition("stop"));
		}
		return { version: 1, actions };
	}

	private async start(id: string) {
		const { app, action, target } = parseDefinition(id);
		if (action === "stop") return this.stop(app);
		const native = action === "start" ? "run" : action;
		if (native !== "run" && native !== "build" && native !== "test")
			throw unavailable(`The ${action} action`);
		const project = this.project(app);
		const chosen = project.targets.find(
			(item) => item.id === target && item.action === native,
		);
		if (!chosen) throw new Error(`Unknown ${native} target ${target}`);
		await this.client.call("environment.action", {
			apps: [app],
			action: native,
			target: chosen.id,
			...(chosen.profile ? { profile: chosen.profile } : {}),
			requestId: `tui-${app}-${native}-${chosen.id}-${crypto.randomUUID()}`,
		});
	}
	/** Stop = cancel the operator task that holds the app's live run. */
	private async stop(app: string) {
		const live = this.runs().filter(
			(run) => run.plan.app === app && run.state !== "exited",
		);
		if (!live.length) throw new Error(`${app} has no live native run`);
		const owners = [...new Set(live.map((run) => run.owner))];
		const operator = new Set(
			this.tasks()
				.filter((task) => task.kind === "operator-environment")
				.map((task) => task.id),
		);
		const foreign = owners.filter((owner) => !operator.has(owner));
		if (foreign.length)
			throw new Error(
				`${app} is held by task ${foreign.join(", ")}; only runs you started from this UI stop here`,
			);
		for (const owner of owners)
			await this.client.call("task.cancel", { id: owner });
	}

	private async logs(app: string) {
		const value = (await this.client.call("environment.inspect", {
			operation: "logs",
			selection: { app, options: { tail: 1000 } },
		})) as { runs?: { output?: string }[] };
		return value.runs?.[0]?.output ?? "";
	}

	private status(): AppStatus[] {
		return this.projects()
			.filter((project) => project.kind !== "infrastructure")
			.map((project) => {
				const app = this.app(project);
				return {
					ident: app.ident,
					resourceId: app.resourceId,
					resourceKind: app.resourceKind,
					runtimeStatus: app.runtimeStatus ?? null,
					runTargetInfo: app.runTargetInfo ?? null,
					status: app.status,
				};
			});
	}

	private slots(): AppSlot[] {
		const waiters = list<{ apps: string[]; owner: number; since?: number }>(
			this.environments().waiters,
		);
		return this.projects().map((project) => {
			const run = this.runs().find(
				(item) => item.plan.app === project.id && item.state !== "exited",
			);
			const waiting = waiters.filter((waiter) =>
				waiter.apps.includes(project.id),
			);
			return {
				app: project.id,
				holder: run ? `task:${run.owner}` : null,
				status: run ? (runtimeOf(run)?.state ?? run.state) : null,
				waiters: waiting.map((waiter) => `task:${waiter.owner}`),
				waiting: waiting.map((waiter, index) => ({
					owner: `task:${waiter.owner}`,
					since: new Date(waiter.since ?? Date.now()).toISOString(),
					position: index + 1,
				})),
				holderSince: run ? new Date(run.createdAt).toISOString() : null,
			};
		});
	}

	private cluster(): KubernetesClusterStatus {
		const cluster = list<{ id: string; context: string; provision?: Data }>(
			this.environments().clusters,
		).find((item) => item.id === "devenv");
		return {
			clusterName: cluster?.id ?? "devenv",
			contextName: cluster?.context ?? "kind-devenv",
			provider: String(cluster?.provision?.provider ?? "docker"),
			exists: false,
			reachable: false,
			state: "missing",
			nodes: [],
			namespaces: [],
			pods: {
				total: 0,
				running: 0,
				pending: 0,
				succeeded: 0,
				failed: 0,
				unknown: 0,
			},
			releases: [],
			warnings: [
				"agentic-coding-v2 creates the devenv kind cluster on the first Kubernetes run; it is never deleted here.",
			],
			collectedAt: new Date().toISOString(),
		};
	}

	/** Native runs as v1 action-run events: started, output, completed. */
	private actionEvents(run: Run, output: string | undefined): ServerEvent[] {
		const at = new Date().toISOString();
		const events: ServerEvent[] = [];
		const status = runStatus(run);
		const step = `${run.id}:process`;
		if (!this.announced.has(run.id)) {
			const action: ActionRun = {
				id: run.id,
				appIdent: run.plan.app,
				action: run.plan.action,
				kind:
					run.plan.projectKind === "infrastructure" ? "infrastructure" : "app",
				...(run.plan.profile ? { profile: run.plan.profile } : {}),
				targetLabel: run.plan.label ?? run.plan.id,
				title: `${run.plan.action} ${run.plan.app} · ${run.plan.id}`,
				status: "active",
				startedAt: new Date(run.createdAt).toISOString(),
				steps: [
					{
						id: step,
						label: `${run.plan.runtime} ${run.plan.id}`,
						status: "active",
						commands: [],
					},
				],
			};
			events.push({
				type: "action.started",
				properties: { run: action },
				timestamp: at,
			});
			this.announced.set(run.id, "active");
		}
		if (output !== undefined) {
			const seen = this.published.get(run.id) ?? 0;
			const fresh = output.length >= seen ? output.slice(seen) : output;
			if (fresh)
				events.push({
					type: "action.command.output",
					properties: {
						runId: run.id,
						stepId: step,
						commandId: `${step}:0`,
						command: run.plan.id,
						stream: "stdout",
						output: fresh,
					},
					timestamp: at,
				});
			this.published.set(run.id, output.length);
		}
		if (status !== "active" && this.announced.get(run.id) === "active") {
			events.push({
				type:
					status === "completed"
						? "action.step.completed"
						: "action.step.failed",
				properties: {
					runId: run.id,
					stepId: step,
					error: run.error ?? (run.exitCode ? `exit ${run.exitCode}` : ""),
				},
				timestamp: at,
			});
			events.push({
				type: "action.completed",
				properties: {
					runId: run.id,
					status,
					appIdent: run.plan.app,
					resourceKind: run.plan.projectKind,
				},
				timestamp: at,
			});
			this.announced.set(run.id, status);
		}
		return events;
	}

	private async outputs(runs: Run[]) {
		const outputs = new Map<string, string>();
		for (const app of new Set(runs.map((run) => run.plan.app))) {
			try {
				const value = (await this.client.call("environment.inspect", {
					operation: "logs",
					selection: { app, options: { tail: 1000 } },
				})) as { runs?: { id: string; output?: string }[] };
				for (const run of value.runs ?? [])
					outputs.set(run.id, run.output ?? "");
			} catch {
				// Logs are diagnostic; a refused read leaves the event without output.
			}
		}
		return outputs;
	}

	private history = (): Promise<ServerEvent[]> => {
		// History starts at the native runs this snapshot still retains.
		const runs = [...this.runs()].sort((a, b) => a.createdAt - b.createdAt);
		return Promise.resolve(
			runs.flatMap((run) => this.actionEvents(run, undefined)),
		);
	};

	private async *events(signal?: AbortSignal): AsyncGenerator<ServerEvent> {
		yield {
			type: "connection.established",
			properties: {},
			timestamp: new Date().toISOString(),
		};
		let previous = "";
		while (!signal?.aborted) {
			const runs = this.runs();
			const key = JSON.stringify(
				runs.map((run) => [run.id, run.state, run.ready, run.exitCode]),
			);
			const live = runs.filter(
				(run) =>
					run.state !== "exited" ||
					this.announced.get(run.id) === "active" ||
					!this.announced.has(run.id),
			);
			const outputs = live.length ? await this.outputs(live) : new Map();
			for (const run of live)
				for (const event of this.actionEvents(run, outputs.get(run.id)))
					yield event;
			if (key !== previous) {
				previous = key;
				for (const status of this.status())
					yield {
						type: "status.updated",
						properties: status as unknown as Data,
						timestamp: new Date().toISOString(),
					};
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 1000);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
		}
	}

	private async *domainEvents(
		signal?: AbortSignal,
	): AsyncGenerator<DomainEventMessage> {
		// Slots re-read the native snapshot on every resync; v2 has no slot stream.
		let previous = "";
		while (!signal?.aborted) {
			const key = JSON.stringify(this.slots());
			if (key !== previous) {
				previous = key;
				yield { type: "resync", reason: "native snapshot changed" };
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	call(method: DevEnvMethod, ...args: unknown[]): never {
		return this.dispatch(method, args) as never;
	}

	private dispatch(method: DevEnvMethod, args: unknown[]): unknown {
		const arg = (index: number) => String(args[index] ?? "");
		switch (method) {
			case "health":
				return Promise.resolve(this.client.status === "connected");
			case "getActionRegistryStatus": {
				const count = this.projects().reduce(
					(total, project) => total + project.targets.length,
					0,
				);
				return Promise.resolve({
					version: 1,
					actionsCount: count,
					error: "",
					available: this.client.state !== null,
				});
			}
			case "getApps":
				return Promise.resolve(
					this.projects()
						.filter((project) => project.kind !== "infrastructure")
						.map((project) => this.app(project)),
				);
			case "getInfraServices":
				return Promise.resolve(
					this.projects()
						.filter((project) => project.kind === "infrastructure")
						.map((project) => this.infra(project)),
				);
			case "getStatus":
				return Promise.resolve(this.status());
			case "getScripts":
				return Promise.resolve({ scripts: [] });
			case "getProviders":
				return Promise.resolve([]);
			case "getStages":
				return Promise.resolve({ configDir: "", stages: [], excluded: [] });
			case "getAppSlots":
				return Promise.resolve(this.slots());
			case "getActionDefinitions":
				return Promise.resolve().then(() => this.definitions(arg(0)));
			case "getActionDefinition":
				return Promise.resolve().then(() => {
					const { app } = parseDefinition(arg(0));
					const found = this.definitions(app).actions.find(
						(item) => item.id === arg(0),
					);
					if (!found) throw new Error(`Unknown action ${arg(0)}`);
					return found;
				});
			case "getActionTargets":
				return Promise.resolve().then(() =>
					this.project(arg(0))
						.targets.filter((target) => target.action === args[1])
						.map(
							(target): ActionTarget => ({
								id: target.id,
								action: target.action,
								runtime: target.runtime as ActionTarget["runtime"],
								label: target.label ?? target.id,
								...(target.profile ? { profile: target.profile } : {}),
								sourcePath: "",
							}),
						),
				);
			case "getProfiles":
				return Promise.resolve().then(() => ({
					profiles: [
						...new Set(
							this.project(arg(0)).targets.map(
								(target) => target.profile ?? "default",
							),
						),
					],
					hasDockerfile: false,
				}));
			case "startActionRun":
				return this.start(arg(0));
			case "runApp":
			case "buildApp":
			case "testApp":
				return Promise.resolve().then(() => {
					const action =
						method === "runApp"
							? "run"
							: method === "buildApp"
								? "build"
								: "test";
					const target =
						(method === "runApp" ? args[2] : args[1]) ??
						this.project(arg(0)).defaultTargets?.[action]?.id;
					if (typeof target !== "string" || !target)
						throw new Error(`Choose a ${action} target for ${arg(0)}`);
					return this.start(definitionId(arg(0), action, target));
				});
			case "startApp":
				return Promise.resolve()
					.then(() => {
						const target =
							(args[2] as string | undefined) ??
							this.project(arg(0)).defaultTargets?.run?.id;
						if (!target) throw new Error(`Choose a run target for ${arg(0)}`);
						return this.start(definitionId(arg(0), "run", target));
					})
					.then(() => ({}));
			case "stopApp":
			case "cancelAction":
			case "releaseApp":
				return this.stop(arg(0));
			case "stopContainer":
				return this.stop(arg(1) || arg(0));
			case "getContainerLogs":
			case "getInfraServiceLogs":
			case "getKubernetesLogs":
				return this.logs(arg(0));
			case "getActionHistory":
				return args[0] === "older" ? Promise.resolve([]) : this.history();
			case "getActionLogs":
				return Promise.resolve([]);
			case "subscribeToEvents":
				return this.events(args[0] as AbortSignal | undefined);
			case "subscribeDomainEvents":
				return this.domainEvents(args[0] as AbortSignal | undefined);
			case "getKubernetesClusterStatus":
			case "refreshKubernetesCluster":
				return Promise.resolve(this.cluster());
			case "reportActionEvent":
				return Promise.resolve();
			case "getPiSessions":
				return Promise.resolve([]);
			default: {
				const error = unavailable(`"${method}"`);
				return Promise.reject(error);
			}
		}
	}

	/** Surface a refusal the way v1 did: one error dialog. */
	report(title: string, error: unknown) {
		this.showError(
			title,
			error instanceof Error ? error.message : String(error),
		);
	}
}
