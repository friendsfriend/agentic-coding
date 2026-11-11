// The v2 backend behind the ported v1 environments client facade.
//
// Every v1 `DevEnvClient` method arrives here by name. Reads are projected from
// the authenticated gateway's native snapshot (`state.read`); a run/build/test
// becomes one interactive `environment.action` (the key press is the approval)
// and stop binds to an exact run revision through `environment.stop`. Native run
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
	revision: number;
	batch: string;
	owner: number;
	state: "reserved" | "running" | "stopping" | "exited" | "interrupted";
	createdAt: number;
	ready: boolean | null;
	exitCode: number | null;
	signal: string | null;
	error: string | null;
	runtimeStatus?: RuntimeStatus;
	endpoints?: Record<string, string>;
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

type ClusterReceipt = {
	id: string;
	cluster: string;
	operation: string;
	state: "issued" | "completed" | "failed";
	createdAt: number;
	output?: string;
	error?: string;
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

type GitRow = {
	app: string;
	path: string;
	branch: string;
	status: string;
	activeWorktree: string | null;
	mainWorktreeBranch: string;
};

export class GatewayBackend implements DevEnvBackend {
	/** Last native Git observation per app, refreshed with every status read. */
	private git = new Map<string, GitRow>();
	/** Provider serving each app's origin remote (v1 `provider`/`sourceType`). */
	private identities: Record<
		string,
		{ provider?: string; sourceType?: string }
	> = {};
	/** Output already published per native run, for incremental action events. */
	private published = new Map<string, number>();
	private announced = new Map<string, ActionRunStatus>();
	private clusterRuns = new Map<string, ClusterReceipt>();
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

	private async refreshGit() {
		try {
			const rows = (await this.client.call("environment.git", {
				operation: "status",
			})) as GitRow[];
			this.git = new Map(rows.map((row) => [row.app, row]));
		} catch {
			// Git status is decoration; the table keeps its last observation.
		}
		try {
			this.identities = (await this.client.call("providers.workbench", {
				operation: "identity",
			})) as typeof this.identities;
		} catch {
			// Provider identity is decoration too.
		}
	}
	private gitCall(operation: string, app: string, branch?: string) {
		return this.client
			.call("environment.git", {
				operation: operation as "fetch",
				app,
				...(branch ? { branch } : {}),
			})
			.then(async (value) => {
				await this.refreshGit();
				return value;
			});
	}

	private app(project: Project): App {
		const run = this.latest(project.id);
		const runtimeStatus = runtimeOf(run);
		const git = this.git.get(project.id);
		return {
			ident: project.id,
			resourceId: project.id,
			resourceKind: project.kind,
			displayName: project.id,
			localDirectoryPath: git?.path ?? project.repository,
			repositoryPath: project.repository,
			branch: git?.branch ?? "",
			...(git ? { gitStatus: git.status } : {}),
			...(git?.activeWorktree ? { activeWorktree: git.activeWorktree } : {}),
			...(git?.mainWorktreeBranch
				? { mainWorktreeBranch: git.mainWorktreeBranch }
				: {}),
			appType: project.kind === "library" ? "LIB" : "APP",
			...(this.identities[project.id]?.provider
				? {
						provider: this.identities[project.id]?.provider,
						sourceType: this.identities[project.id]?.sourceType as
							| "github"
							| "gitlab",
					}
				: {}),
			containerBaseName: project.id,
			...(runtimeStatus ? { runtimeStatus } : {}),
			status: runtimeStatus?.state ?? "stopped",
			...(this.dockerInfo(run, project.id)
				? { dockerInfo: this.dockerInfo(run, project.id) }
				: {}),
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
	/** v1's per-app live container handle. The "container ID" is the app ident:
	 * the server resolves it to the current live native run, never a saved ID. */
	private dockerInfo(run: Run | undefined, app: string) {
		if (run?.state !== "running" || run.ready === false) return undefined;
		if (
			!["docker", "podman", "compose", "shell", "systemshell"].includes(
				run.plan.runtime,
			)
		)
			return undefined;
		return {
			Status: "running",
			ContainerID: app,
			Ports: Object.values(run.endpoints ?? {})
				.map((url) => {
					try {
						return new URL(url).port;
					} catch {
						return "";
					}
				})
				.filter(Boolean)
				.join(", "),
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
				actions.push(
					definition("start"),
					definition("stop"),
					definition("restart"),
				);
		}
		return { version: 1, actions };
	}

	private async start(id: string) {
		const { app, action, target } = parseDefinition(id);
		if (app === "local") return this.clusterAction(action, target);
		if (action === "stop") return this.stop(app);
		if (action === "restart") return this.restart(app);
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
	/** Direct UI stop binds to one observed run and its exact native revision.
	 * The server validates operator ownership and revokes its whole batch. */
	private async stop(app: string) {
		const run = this.latest(app);
		if (!run || run.state === "exited")
			throw new Error(`${app} has no live native run`);
		await this.client.call("environment.stop", {
			runId: run.id,
			revision: run.revision,
			requestId: `tui-stop-${crypto.randomUUID()}`,
		});
	}

	private async restart(app: string) {
		const run = this.latest(app);
		if (run?.state !== "running" || run.plan.action !== "run")
			throw new Error(`${app} has no running native run to restart`);
		// Stop acknowledgement is issued only after certain native cleanup. Never
		// retry or start after a stale revision, disconnection or uncertain cleanup.
		await this.stop(app);
		await this.start(definitionId(app, "run", run.plan.id));
	}

	private async logs(app: string) {
		const value = (await this.client.call("environment.inspect", {
			operation: "logs",
			selection: { app, options: { tail: 1000 } },
		})) as { runs?: { output?: string }[] };
		return value.runs?.[0]?.output ?? "";
	}

	/** Polls native output and yields only new lines (v1's follow stream). */
	private async streamLogs(
		app: string,
		signal: AbortSignal,
		onLine: (line: string) => void,
		onError?: (error: Error) => void,
		tail = "100",
	) {
		let seen: string | null = null;
		const limit = Number(tail);
		while (!signal.aborted) {
			try {
				const output = await this.logs(app);
				const lines = output ? output.replace(/\n$/, "").split("\n") : [];
				let fresh: string[];
				if (seen === null)
					fresh = limit > 0 ? lines.slice(-limit) : limit === 0 ? [] : lines;
				else if (output.startsWith(seen))
					fresh = output
						.slice(seen.length)
						.replace(/^\n/, "")
						.replace(/\n$/, "")
						.split("\n")
						.filter((line, index, all) => line || index < all.length - 1);
				else fresh = lines.slice(-Math.max(limit, 100));
				seen = output;
				for (const line of fresh) if (!signal.aborted) onLine(line);
			} catch (error) {
				onError?.(error instanceof Error ? error : new Error(String(error)));
			}
			await this.pause(signal, 1000);
		}
	}
	private async streamStats(
		app: string,
		signal: AbortSignal,
		onData: (stats: never) => void,
		onError?: (error: Error) => void,
	) {
		while (!signal.aborted) {
			try {
				onData((await this.client.call("environment.stats", { app })) as never);
			} catch (error) {
				// Shell runs have no container statistics; stop polling quietly.
				onError?.(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			await this.pause(signal, 2000);
		}
	}
	private pause(signal: AbortSignal, ms: number) {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
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
					branch: app.branch,
					...(app.dockerInfo ? { dockerInfo: app.dockerInfo } : {}),
					...(app.gitStatus ? { gitStatus: app.gitStatus } : {}),
					...(app.activeWorktree ? { activeWorktree: app.activeWorktree } : {}),
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

	private tasks(
		operation: string,
		input: {
			path?: string;
			sourcePath?: string;
			values?: Data;
			limit?: number;
		} = {},
	) {
		return this.client.call("environment.tasks", {
			operation: operation as "list",
			...input,
		}) as Promise<never>;
	}
	/** Native kind cluster status (read-only; never creates or deletes). */
	private async cluster(): Promise<KubernetesClusterStatus> {
		try {
			return (await this.client.call("environment.cluster", {
				operation: "status",
			})) as unknown as KubernetesClusterStatus;
		} catch (error) {
			const cluster = list<{ id: string; context: string; provision?: Data }>(
				this.environments().clusters,
			).find((item) => item.id === "devenv");
			return {
				clusterName: cluster?.id ?? "devenv",
				contextName: cluster?.context ?? "kind-devenv",
				provider: String(cluster?.provision?.provider ?? "docker"),
				exists: false,
				reachable: false,
				state: "unreachable",
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
				warnings: [error instanceof Error ? error.message : String(error)],
				collectedAt: new Date().toISOString(),
			};
		}
	}
	/** v1's `local` Kubernetes cluster actions, one per lifecycle operation. */
	private clusterDefinitions(): ActionDefinitionList {
		const cluster = list<{ id: string; provision?: Data }>(
			this.environments().clusters,
		).find((item) => item.provision);
		if (!cluster) return { version: 1, actions: [] };
		const provider = String(cluster.provision?.provider ?? "docker");
		return {
			version: 1,
			actions: (
				[
					["create", "Create cluster"],
					["delete", "Delete cluster"],
					["recreate", "Recreate cluster"],
					["export-kubeconfig", "Export kubeconfig"],
				] as const
			).map(([type, label]) => ({
				id: definitionId("local", type, cluster.id),
				owner: { kind: "kubernetes", id: "local" },
				type,
				runtime: provider,
				label,
				inputs: [],
				availability: { available: true },
				root: {
					id: `${cluster.id}:${type}`,
					kind: "process",
					label,
				},
			})) as ActionDefinition[],
		};
	}
	private async clusterAction(operation: string, cluster = "devenv") {
		const receipt = (await this.client.call("environment.cluster", {
			operation: operation as "create",
			cluster,
			requestId: `tui-cluster-${crypto.randomUUID()}`,
		})) as unknown as ClusterReceipt;
		this.clusterRuns.set(receipt.id, receipt);
	}
	/** Cluster operation receipts as v1 action-run events. */
	private async clusterEvents(): Promise<ServerEvent[]> {
		if (![...this.clusterRuns.values()].some((r) => r.state === "issued"))
			return [];
		const receipts = (await this.client
			.call("environment.cluster", { operation: "operations" })
			.catch(() => [])) as unknown as ClusterReceipt[];
		const events: ServerEvent[] = [],
			at = new Date().toISOString();
		for (const receipt of receipts) {
			const known = this.clusterRuns.get(receipt.id);
			if (!known) continue;
			const step = `${receipt.id}:process`;
			if (!this.announced.has(receipt.id)) {
				events.push({
					type: "action.started",
					properties: {
						run: {
							id: receipt.id,
							appIdent: "local",
							action: receipt.operation,
							kind: "kubernetes",
							title: `${receipt.operation} kind cluster ${receipt.cluster}`,
							status: "active",
							startedAt: new Date(receipt.createdAt).toISOString(),
							steps: [
								{
									id: step,
									label: `kind ${receipt.operation}`,
									status: "active",
									commands: [],
								},
							],
						} satisfies ActionRun,
					} as unknown as Data,
					timestamp: at,
				});
				this.announced.set(receipt.id, "active");
			}
			if (receipt.state === "issued") continue;
			this.clusterRuns.set(receipt.id, receipt);
			events.push(
				{
					type: "action.command.output",
					properties: {
						runId: receipt.id,
						stepId: step,
						commandId: `${step}:0`,
						command: receipt.operation,
						stream: "stdout",
						output: `${receipt.output ?? receipt.error ?? ""}\n`,
					},
					timestamp: at,
				},
				{
					type:
						receipt.state === "completed"
							? "action.step.completed"
							: "action.step.failed",
					properties: {
						runId: receipt.id,
						stepId: step,
						error: receipt.error ?? "",
					},
					timestamp: at,
				},
				{
					type: "action.completed",
					properties: {
						runId: receipt.id,
						status: receipt.state === "completed" ? "completed" : "failed",
						appIdent: "local",
						resourceKind: "kubernetes",
					},
					timestamp: at,
				},
			);
			if (receipt.operation === "delete" && receipt.state === "completed")
				events.push({
					type: "kubernetes.cluster.deleted",
					properties: {},
					timestamp: at,
				});
			events.push({
				type: "kubernetes.cluster.refreshed",
				properties: (await this.cluster()) as unknown as Data,
				timestamp: at,
			});
			this.announced.set(receipt.id, receipt.state);
		}
		return events;
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
			for (const event of await this.clusterEvents()) yield event;
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
				return this.refreshGit().then(() =>
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
				return this.refreshGit().then(() => this.status());
			case "getGitInfo":
				return this.refreshGit().then(() => ({
					branch: this.git.get(arg(0))?.branch ?? "",
					status: this.git.get(arg(0))?.status ?? "",
				}));
			case "gitPull":
				return this.gitCall("pull", arg(0)).then(() => undefined);
			case "gitPush":
				return this.gitCall("push", arg(0)).then(() => undefined);
			case "gitFetch":
				return this.gitCall("fetch", arg(0)).then(() => undefined);
			case "gitCheckout":
				return this.gitCall("checkout", arg(0), arg(1)).then(() => undefined);
			case "gitCreateBranch":
				return this.gitCall("create-branch", arg(0), arg(1)).then(
					() => undefined,
				);
			case "createWorktree":
				return this.gitCall("create-worktree", arg(0), arg(1)).then(
					() => undefined,
				);
			case "switchWorktree":
				return this.gitCall("switch-worktree", arg(0), arg(1)).then(
					() => undefined,
				);
			case "removeWorktree":
				return this.gitCall("remove-worktree", arg(0), arg(1)).then(
					() => undefined,
				);
			case "getBranches":
				return this.client.call("environment.git", {
					operation: "branches",
					app: arg(0),
				});
			case "listWorktrees":
				return this.client.call("environment.git", {
					operation: "worktrees",
					app: arg(0),
				});
			case "getScripts":
				return this.tasks("list").then((scripts) => ({ scripts }));
			case "getScriptMetadata":
				return this.tasks("metadata", { path: arg(0) });
			case "createScript":
				return this.tasks("create", { path: arg(0) });
			case "linkScript":
				return this.tasks("link", { path: arg(0), sourcePath: arg(1) });
			case "deleteScript":
				return this.tasks("delete", { path: arg(0) });
			case "getScriptArgsHistory":
				return this.tasks("history", {
					path: arg(0),
					limit: typeof args[1] === "number" ? args[1] : 50,
				});
			case "addScriptArgsHistory":
				return this.tasks("add-history", {
					path: arg(0),
					values: (args[1] ?? {}) as Data,
				}).then(() => undefined);
			case "getProviders":
				return this.client.call("providers.read", {});
			// Restored v1 provider workbench: issues, change requests and CI of
			// the provider serving each app's origin remote.
			case "getChangeRequests":
				return this.workbench("changes", arg(0), {
					state: arg(1) || "opened",
					scope: args[2] === "all" ? "all" : "current",
					page: args[4] ?? 1,
					perPage: args[5] ?? 50,
					...(args[6] ? { search: arg(6) } : {}),
					...(args[7] ? { sort: arg(7) } : {}),
					...(args[8] ? { direction: arg(8) } : {}),
					...(Array.isArray(args[9]) ? { labels: args[9] } : {}),
				});
			case "getChangeRequest":
				return this.workbench("change", arg(0), { number: args[1] });
			case "getChangeRequestChanges":
				return this.workbench("change-files", arg(0), { number: args[1] });
			case "getCRVersions":
				return this.workbench("change-versions", arg(0), { number: args[1] });
			case "getCRDiscussions":
				return this.workbench("discussions", arg(0), { number: args[1] });
			case "getCRLinkedIssues":
				return this.workbench("change-issues", arg(0), { number: args[1] });
			case "createCRComment":
				return this.workbench("comment-change", arg(0), {
					number: args[1],
					body: arg(2),
					...(args[3] ? { position: args[3] as Data } : {}),
				});
			case "approveChangeRequest":
				return this.workbench("approve-change", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "unapproveChangeRequest":
				return this.workbench("unapprove-change", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "toggleCRApproval":
				return this.workbench("toggle-approval", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "rebaseCR":
				return this.workbench("rebase-change", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "replyToDiscussion":
				return this.workbench("reply-discussion", arg(0), {
					number: args[1],
					thread: arg(2),
					body: arg(3),
				});
			case "resolveDiscussion":
				return this.workbench("resolve-discussion", arg(0), {
					number: args[1],
					thread: arg(2),
					resolved: args[3] === "resolve",
				});
			case "getIssues":
				return this.workbench("issues", arg(0), {
					scope: arg(1) || "all",
					page: args[3] ?? 1,
					perPage: args[4] ?? 50,
					...(args[5] ? { search: arg(5) } : {}),
					...(args[6] ? { state: arg(6) } : {}),
					...(args[7] ? { sort: arg(7) } : {}),
					...(args[8] ? { direction: arg(8) } : {}),
					...(Array.isArray(args[9]) ? { labels: args[9] } : {}),
				});
			case "getIssue":
				return this.workbench("issue", arg(0), { number: args[1] });
			case "getIssueComments":
				return this.workbench("issue-comments", arg(0), { number: args[1] });
			case "getIssueLinkedCRs":
				return this.workbench("issue-changes", arg(0), { number: args[1] });
			case "getIssueReferencedIssues":
				return this.workbench("issue-references", arg(0), {
					number: args[1],
				});
			case "getRepoLabels":
				return this.workbench("labels", arg(0));
			case "getRepoCollaborators":
				return this.workbench("collaborators", arg(0));
			case "closeIssue":
				return this.workbench("close-issue", arg(0), {
					number: args[1],
					...(args[3] ? { reason: arg(3) } : {}),
				});
			case "reopenIssue":
				return this.workbench("reopen-issue", arg(0), { number: args[1] });
			case "setIssueLabels":
				return this.workbench("set-issue-labels", arg(0), {
					number: args[1],
					labels: (args[3] ?? []) as Data,
				});
			case "setIssueAssignee":
				return this.workbench("assign-issue", arg(0), {
					number: args[1],
					assignee: arg(3),
				});
			case "removeIssueAssignee":
				return this.workbench("unassign-issue", arg(0), { number: args[1] });
			case "addIssueComment":
				return this.workbench("comment-issue", arg(0), {
					number: args[1],
					body: arg(3),
				});
			case "getPipelineJobs":
				return this.workbench("jobs", arg(0), { number: args[1] });
			case "getTestSummary":
				return this.workbench("tests", arg(0), { number: args[1] });
			case "getJobLogs":
				return this.workbench("job-logs", arg(0), { number: args[1] });
			case "streamJobLogs":
				return this.streamJobLogs(
					arg(0),
					Number(args[1]),
					args[2] as AbortSignal,
					args[3] as (line: string) => void,
				);
			case "retryJob":
				return this.workbench("retry-job", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "cancelJob":
				return this.workbench("cancel-job", arg(0), {
					number: args[1],
				}).then(() => undefined);
			case "getStages":
				return Promise.resolve({ configDir: "", stages: [], excluded: [] });
			case "getAppSlots":
				return Promise.resolve(this.slots());
			case "getActionDefinitions":
				return Promise.resolve().then(() =>
					arg(0) === "local"
						? this.clusterDefinitions()
						: this.definitions(arg(0)),
				);
			case "getActionDefinition":
				return Promise.resolve().then(() => {
					const { app } = parseDefinition(arg(0));
					const found = (
						app === "local" ? this.clusterDefinitions() : this.definitions(app)
					).actions.find((item) => item.id === arg(0));
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
			case "restartContainer":
				return this.restart(arg(1) || arg(0));
			case "stopContainer":
				return this.stop(arg(1) || arg(0));
			case "streamContainerLogs":
				return this.streamLogs(
					arg(0),
					args[1] as AbortSignal,
					args[2] as (line: string) => void,
					args[3] as ((error: Error) => void) | undefined,
					String(args[4] ?? "100"),
				);
			case "streamContainerStats":
				return this.streamStats(
					arg(0),
					args[1] as AbortSignal,
					args[2] as (stats: never) => void,
					args[3] as ((error: Error) => void) | undefined,
				);
			case "getDockerInfo":
				return Promise.resolve(
					this.dockerInfo(this.latest(arg(0)), arg(0)) ?? {
						Status: "stopped",
						ContainerID: "",
						Ports: "",
					},
				);
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
				return this.cluster();
			case "createKubernetesCluster":
				return this.clusterAction("create");
			case "deleteKubernetesCluster":
				return this.clusterAction("delete");
			case "recreateKubernetesCluster":
				return this.clusterAction("recreate");
			case "exportKubernetesKubeconfig":
				return this.clusterAction("export-kubeconfig");
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

	private workbench(
		operation: string,
		app: string,
		input: Record<string, unknown> = {},
	) {
		return this.client.call("providers.workbench", {
			operation,
			app,
			...input,
		}) as Promise<never>;
	}
	/** v1 streamed GitLab job traces; v2 polls the bounded trace every 2 s and
	 * emits only new lines until aborted. */
	private async streamJobLogs(
		app: string,
		job: number,
		signal: AbortSignal,
		onLine: (line: string) => void,
	) {
		let seen = 0;
		while (!signal.aborted) {
			try {
				const text = (await this.workbench("job-logs", app, {
					number: job,
				})) as string;
				const lines = text.split("\n");
				if (lines.length < seen) seen = 0;
				for (const line of lines.slice(seen)) onLine(line);
				seen = lines.length;
			} catch {
				// The polling fallback in log-effects keeps the modal current.
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
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
