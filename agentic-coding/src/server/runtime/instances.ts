import fs from "node:fs";
import { discoverActionTargets } from "../actions/discovery.ts";
import type { ActionTarget } from "../actions/targets.ts";
import type { App } from "../environment/config.ts";
import {
	composeProjectName,
	type EnvironmentInstance,
	type EnvironmentOwner,
	environmentInstanceId,
	environmentInstanceStorageId,
	parseEnvironmentOwner,
} from "../environment/instances/model.ts";
import {
	EnvironmentPortAllocator,
	PortUnavailableError,
	parsePortRange,
} from "../environment/instances/ports.ts";
import { resolveInstanceVariables } from "../environment/instances/variables.ts";
import type {
	EnvironmentInstanceRecord,
	EnvironmentStateStore,
	PortAllocationRecord,
} from "../environment/state-store.ts";
import {
	composeCommandForRuntime,
	type DockerRuntimeSelection,
} from "./docker.ts";
import {
	INSTANCE_SCRIPT_ENV_DENYLIST,
	ScriptInfrastructure,
	type ScriptStatus,
} from "./script-infrastructure.ts";

const DEFAULT_PORT_RANGE = "20000-29999";
const LIFECYCLE_RECONCILE_GRACE_MS = 5 * 60 * 1000;
const WORKFLOW_CHILD_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TMUX",
	"TMUX_PANE",
	"XDG_RUNTIME_DIR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"DEVENV_CONTAINER_RUNTIME",
	"DOCKER_CONFIG",
	"DOCKER_HOST",
	"DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH",
	"DOCKER_CONTEXT",
	"COMPOSE_FILE",
	"COMPOSE_PROFILES",
	"COMPOSE_PROJECT_NAME",
	"COMPOSE_PATH_SEPARATOR",
	"COMPOSE_CONVERT_WINDOWS_PATHS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
]);

export type EnvironmentInstanceState = Pick<
	EnvironmentStateStore,
	| "getEnvironmentInstances"
	| "getEnvironmentInstance"
	| "findEnvironmentInstance"
	| "claimEnvironmentInstance"
	| "claimEnvironmentInstanceStop"
	| "compareAndSetEnvironmentInstanceStatus"
	| "transitionEnvironmentInstanceStatus"
	| "releasePortAllocationsIfStatus"
	| "deleteEnvironmentInstanceIfStatus"
	| "updateEnvironmentInstanceStatus"
	| "deleteEnvironmentInstance"
	| "getPortAllocations"
	| "setPortAllocation"
	| "deletePortAllocations"
>;

type InstanceScriptLifecycle = Pick<
	ScriptInfrastructure,
	"launch" | "status" | "stop" | "executionHandle"
> &
	Partial<Pick<ScriptInfrastructure, "observe">>;

export class EnvironmentInstanceError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(
		code: string,
		status: number,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "EnvironmentInstanceError";
		this.code = code;
		this.status = status;
	}
}

export interface EnvironmentInstanceControllerOptions {
	readonly state: EnvironmentInstanceState;
	readonly apps: () => readonly App[];
	readonly configDir: string;
	readonly docker?: DockerRuntimeSelection;
	readonly resolveDocker?: () => Promise<DockerRuntimeSelection | undefined>;
	/** Required for workflow-owned starts; paths never come directly from a request. */
	readonly resolveOwnerCheckout?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined | Promise<string | undefined>;
	/** Read the configured environment.instances.port_range value. */
	readonly portRange?: () => string;
	readonly isPortBindable?: (port: number) => Promise<boolean>;
	readonly scriptInfra?: InstanceScriptLifecycle;
	readonly runCommand?: (
		command: string,
		args: readonly string[],
		options: { cwd: string; env: Readonly<Record<string, string>> },
	) => Promise<{ exitCode: number; output: string }>;
	readonly now?: () => Date;
	readonly logger?: (message: string) => void;
}

export interface StartEnvironmentInstanceRequest {
	readonly owner: string;
	readonly app: string;
	readonly target?: string;
	readonly profile?: string;
	readonly configOverlay?: string;
}

export interface StartEnvironmentInstanceResult {
	readonly outcome: "started" | "already-running";
	readonly instance: EnvironmentInstance;
}

/** Direct per-instance lifecycle controller, separate from singleton app routes. */
export class EnvironmentInstanceController {
	private readonly state: EnvironmentInstanceState;
	private readonly apps: () => readonly App[];
	private readonly configDir: string;
	private docker?: DockerRuntimeSelection;
	private readonly resolveDocker?: EnvironmentInstanceControllerOptions["resolveDocker"];
	private dockerPromise?: Promise<DockerRuntimeSelection | undefined>;
	private readonly resolveOwnerCheckout?: EnvironmentInstanceControllerOptions["resolveOwnerCheckout"];
	private readonly portRange: () => string;
	private readonly ports: EnvironmentPortAllocator;
	private readonly scriptInfra: InstanceScriptLifecycle;
	private readonly runCommand: NonNullable<
		EnvironmentInstanceControllerOptions["runCommand"]
	>;
	private readonly now: () => Date;
	private readonly logger?: (message: string) => void;
	readonly ready: Promise<void>;

	constructor(options: EnvironmentInstanceControllerOptions) {
		this.state = options.state;
		this.apps = options.apps;
		this.configDir = options.configDir;
		this.docker = options.docker;
		this.resolveDocker = options.resolveDocker;
		if (options.docker) this.dockerPromise = Promise.resolve(options.docker);
		this.resolveOwnerCheckout = options.resolveOwnerCheckout;
		this.portRange = options.portRange ?? (() => DEFAULT_PORT_RANGE);
		this.ports = new EnvironmentPortAllocator({
			store: options.state,
			...(options.isPortBindable ? { isBindable: options.isPortBindable } : {}),
		});
		this.scriptInfra =
			options.scriptInfra ??
			new ScriptInfrastructure({
				runCommand: async (command, args) => {
					const result = await executeCommand(
						command,
						args,
						process.cwd(),
						environmentWith({}, "workflow:instance-runtime"),
					);
					return {
						output: result.output,
						...(result.exitCode === 0
							? {}
							: { error: new Error(`exit status ${result.exitCode}`) }),
					};
				},
			});
		this.runCommand =
			options.runCommand ??
			((command, args, options) =>
				executeCommand(command, args, options.cwd, options.env));
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger;
		this.ready = this.reconcile().catch((error: unknown) => {
			this.logger?.(
				`[instances] startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	async list(): Promise<EnvironmentInstance[]> {
		await this.ready;
		const records = await Promise.all(
			this.state
				.getEnvironmentInstances()
				.map((record) => this.refreshScriptInstance(record)),
		);
		const allocations = new Map<string, PortAllocationRecord[]>();
		for (const allocation of this.state.getPortAllocations()) {
			const forInstance = allocations.get(allocation.instanceId) ?? [];
			forInstance.push(allocation);
			allocations.set(allocation.instanceId, forInstance);
		}
		return records.map((record) =>
			this.toPublic(record, allocations.get(record.id) ?? []),
		);
	}

	async get(id: string, app?: string): Promise<EnvironmentInstance> {
		await this.ready;
		const matches = this.state
			.getEnvironmentInstances()
			.filter(
				(record) =>
					publicInstanceId(record) === id &&
					(app === undefined || record.app === app),
			);
		if (matches.length === 0)
			throw new EnvironmentInstanceError(
				"instance-not-found",
				404,
				`environment instance ${JSON.stringify(id)} not found`,
			);
		if (matches.length > 1)
			throw new EnvironmentInstanceError(
				"app-required",
				400,
				"app query parameter is required when instance id is shared by multiple apps",
			);
		return this.toPublic(
			await this.refreshScriptInstance(matches[0] as EnvironmentInstanceRecord),
		);
	}

	async start(
		input: StartEnvironmentInstanceRequest,
	): Promise<StartEnvironmentInstanceResult> {
		await this.ready;
		let owner: EnvironmentOwner;
		try {
			owner = parseEnvironmentOwner(input.owner);
		} catch (error) {
			throw new EnvironmentInstanceError("invalid-owner", 400, message(error), {
				cause: error,
			});
		}
		const app = this.apps().find((candidate) => candidate.ident === input.app);
		if (!app || app.appType === "library" || app.appType === "LIB")
			throw new EnvironmentInstanceError(
				"app-not-found",
				404,
				`app ${JSON.stringify(input.app)} not found`,
			);
		let storageId = environmentInstanceStorageId(owner, app.ident);
		const previous = this.state.findEnvironmentInstance(owner, app.ident);
		if (previous?.status === "running")
			return { outcome: "already-running", instance: this.toPublic(previous) };
		if (previous?.status === "unknown")
			throw new EnvironmentInstanceError(
				"instance-unknown",
				409,
				"instance runtime state is unknown; reconcile or stop it before starting again",
			);
		if (previous?.status === "starting")
			throw new EnvironmentInstanceError(
				"already-starting",
				409,
				"an instance start is already in progress",
			);
		if (previous?.status === "stopping")
			throw new EnvironmentInstanceError(
				"instance-stopping",
				409,
				"instance stop is in progress",
			);
		const docker = await this.dockerRuntime();
		const checkoutPath =
			owner === "user"
				? app.localDirectoryPath
				: await this.resolveOwnerCheckout?.(owner, app);
		if (!checkoutPath)
			throw new EnvironmentInstanceError(
				"owner-checkout-unavailable",
				503,
				`no managed checkout is available for ${owner}`,
			);
		const configOverlay = input.configOverlay;
		const targets = discoverTargets(
			this.configDir,
			app,
			checkoutPath,
			configOverlay,
		);
		const selected = selectTarget(targets, input, docker !== undefined);
		if (selected.runtime === "kubernetes")
			throw new EnvironmentInstanceError(
				"explicit-runtime-required",
				400,
				"Kubernetes is not supported by environment instances in this change",
			);
		if (owner !== "user" && selected.runtime === "docker") {
			const refusal = untemplatedConstruct(selected.sourcePath);
			if (refusal)
				throw new EnvironmentInstanceError(
					"untemplated-target",
					409,
					`untemplated target uses ${refusal}`,
				);
		}
		const source = readSource(selected.sourcePath);
		const instanceId =
			owner === "user"
				? "default"
				: (previous?.id ?? environmentInstanceId(owner, app.ident));
		const timestamp = this.now().toISOString();
		const record: EnvironmentInstanceRecord = {
			id: storageId,
			owner,
			app: app.ident,
			targetId: selected.id,
			runtime: selected.runtime,
			checkoutPath,
			...(configOverlay ? { configOverlay } : {}),
			imageTag:
				owner === "user" ? "latest" : (previous?.imageTag ?? instanceId),
			status: "starting",
			createdAt: previous?.createdAt ?? timestamp,
			lastActivityAt: timestamp,
		};
		const claimedId = this.state.claimEnvironmentInstance(record);
		if (!claimedId) {
			const raced = this.state.findEnvironmentInstance(owner, app.ident);
			if (raced?.status === "running")
				return { outcome: "already-running", instance: this.toPublic(raced) };
			throw new EnvironmentInstanceError(
				raced?.status === "stopping" ? "instance-stopping" : "already-starting",
				409,
				"another instance lifecycle operation is in progress",
			);
		}
		storageId = claimedId;
		let allocations: Record<string, number> = {};
		try {
			allocations = await this.ports.allocate({
				instanceId: storageId,
				owner,
				source,
				range: parsePortRange(this.portRange()),
			});
			let variables = resolveInstanceVariables({
				instanceId,
				owner,
				appDir: checkoutPath,
				ports: allocations,
			});
			if (selected.runtime === "docker") {
				const docker = await this.dockerRuntime();
				if (!docker)
					throw new EnvironmentInstanceError(
						"runtime-unavailable",
						503,
						"no Docker-compatible runtime is available",
					);
				const project = composeProjectName(app.ident, instanceId);
				const command = composeCommandForRuntime(docker.runtime.name);
				const args = ["-p", project, "-f", selected.sourcePath, "up", "-d"];
				let result = await this.runCommand(command, args, {
					cwd: checkoutPath,
					env: environmentWith(variables, owner),
				});
				docker.client.invalidateCache();
				if (result.exitCode !== 0 && isPortBindConflict(result.output)) {
					const rejected = Object.values(allocations);
					this.ports.free(storageId);
					allocations = await this.ports.allocate({
						instanceId: storageId,
						owner,
						source,
						range: parsePortRange(this.portRange()),
						excludePorts: rejected,
					});
					variables = resolveInstanceVariables({
						instanceId,
						owner,
						appDir: checkoutPath,
						ports: allocations,
					});
					result = await this.runCommand(command, args, {
						cwd: checkoutPath,
						env: environmentWith(variables, owner),
					});
					docker.client.invalidateCache();
					if (result.exitCode !== 0 && isPortBindConflict(result.output))
						throw new PortUnavailableError(
							result.output || "allocated host port could not be bound",
						);
				}
				if (result.exitCode !== 0)
					throw new EnvironmentInstanceError(
						"start-failed",
						500,
						result.output || `compose exited ${result.exitCode}`,
					);
			} else {
				const key = scriptHandleKey(storageId);
				const launch = await this.scriptInfra.launch({
					ident: key,
					runner: "shell",
					command: selected.command ?? "sh",
					args: selected.args ?? [selected.sourcePath],
					dir: selected.workingDir ?? checkoutPath,
					env: environmentWith(variables, owner),
					...(owner === "user" ? {} : { forceLogged: true }),
					spawn: () => {
						const proc = Bun.spawn(
							[
								selected.command ?? "sh",
								...(selected.args ?? [selected.sourcePath]),
							],
							{
								cwd: selected.workingDir ?? checkoutPath,
								env: environmentWith(variables, owner),
								stdout: "ignore",
								stderr: "ignore",
							},
						);
						void proc.exited.then((exitCode) => {
							if (this.scriptInfra instanceof ScriptInfrastructure)
								this.scriptInfra.noteExit(key, exitCode, "", proc.pid);
							const handle = this.scriptInfra.executionHandle(key);
							if (handle?.pid !== proc.pid) return;
							const current = this.state.getEnvironmentInstance(storageId);
							if (current?.status !== "running") return;
							const terminal = exitCode === 0 ? "stopped" : "failed";
							this.state.transitionEnvironmentInstanceStatus(
								storageId,
								"running",
								terminal,
								this.now().toISOString(),
								true,
							);
						});
						return { pid: proc.pid };
					},
				});
				if (launch.status !== "running")
					throw new EnvironmentInstanceError(
						"start-failed",
						500,
						`script exited during startup with status ${launch.status}`,
					);
			}
			if (
				!this.state.compareAndSetEnvironmentInstanceStatus(
					storageId,
					"starting",
					"running",
					this.now().toISOString(),
				)
			)
				throw new EnvironmentInstanceError(
					"lifecycle-conflict",
					409,
					"instance state changed while the target was starting",
				);
			const running = this.state.getEnvironmentInstance(storageId);
			if (!running)
				throw new EnvironmentInstanceError(
					"state-error",
					500,
					"instance disappeared after start",
				);
			return { outcome: "started", instance: this.toPublic(running) };
		} catch (error) {
			if (error instanceof PortUnavailableError) {
				this.state.deleteEnvironmentInstanceIfStatus(storageId, "starting");
				throw new EnvironmentInstanceError(
					"port-unavailable",
					409,
					error.message,
					{ cause: error },
				);
			}
			this.state.transitionEnvironmentInstanceStatus(
				storageId,
				"starting",
				"failed",
				this.now().toISOString(),
				true,
			);
			throw error;
		}
	}

	async stop(id: string, app?: string): Promise<EnvironmentInstance> {
		await this.ready;
		const matches = this.state
			.getEnvironmentInstances()
			.filter(
				(record) =>
					publicInstanceId(record) === id &&
					(app === undefined || record.app === app),
			);
		if (matches.length === 0)
			throw new EnvironmentInstanceError(
				"instance-not-found",
				404,
				`environment instance ${JSON.stringify(id)} not found`,
			);
		if (matches.length > 1)
			throw new EnvironmentInstanceError(
				"app-required",
				400,
				"app query parameter is required when instance id is shared by multiple apps",
			);
		const record = matches[0] as EnvironmentInstanceRecord;
		if (record.status === "stopped") {
			this.state.releasePortAllocationsIfStatus(record.id, "stopped");
			return this.toPublic(record);
		}
		if (record.status === "starting" || record.status === "stopping")
			throw new EnvironmentInstanceError(
				"instance-busy",
				409,
				`cannot stop an instance while it is ${record.status}`,
			);
		if (
			!this.state.claimEnvironmentInstanceStop(
				record.id,
				this.now().toISOString(),
			)
		) {
			const current = this.state.getEnvironmentInstance(record.id);
			if (current?.status === "stopped") {
				this.state.releasePortAllocationsIfStatus(record.id, "stopped");
				return this.toPublic(current);
			}
			throw new EnvironmentInstanceError(
				"instance-busy",
				409,
				`cannot claim stop while the instance is ${current?.status ?? "missing"}`,
			);
		}
		try {
			if (record.runtime === "docker") {
				const docker = await this.dockerRuntime();
				if (!docker)
					throw new EnvironmentInstanceError(
						"runtime-unavailable",
						503,
						"Docker runtime is unavailable; instance ports are retained",
					);
				const instanceId = publicInstanceId(record);
				const project = composeProjectName(record.app, instanceId);
				const app = this.apps().find(
					(candidate) => candidate.ident === record.app,
				);
				const target = app
					? discoverTargets(
							this.configDir,
							app,
							record.checkoutPath,
							record.configOverlay,
						).find((candidate) => candidate.id === record.targetId)
					: undefined;
				if (target && fs.existsSync(target.sourcePath)) {
					const allocations = Object.fromEntries(
						this.state
							.getPortAllocations(record.id)
							.map(({ name, port }) => [name, port]),
					);
					const variables = resolveInstanceVariables({
						instanceId,
						owner: parseEnvironmentOwner(record.owner),
						appDir: record.checkoutPath,
						ports: allocations,
					});
					const result = await this.runCommand(
						composeCommandForRuntime(docker.runtime.name),
						["-p", project, "-f", target.sourcePath, "down"],
						{
							cwd: record.checkoutPath,
							env: environmentWith(
								variables,
								parseEnvironmentOwner(record.owner),
							),
						},
					);
					if (result.exitCode !== 0)
						throw new EnvironmentInstanceError(
							"stop-failed",
							500,
							result.output || `compose exited ${result.exitCode}`,
						);
					docker.client.invalidateCache();
					await this.stopObservedDockerProject(docker, project);
				} else {
					await this.stopObservedDockerProject(docker, project);
				}
			} else {
				const key = scriptHandleKey(record.id);
				if (!this.scriptInfra.executionHandle(key))
					throw new EnvironmentInstanceError(
						"script-handle-unavailable",
						409,
						"script process handle is unavailable; instance ports are retained",
					);
				await this.scriptInfra.stop(key);
			}
		} catch (error) {
			this.state.compareAndSetEnvironmentInstanceStatus(
				record.id,
				"stopping",
				"unknown",
				this.now().toISOString(),
			);
			if (error instanceof EnvironmentInstanceError) throw error;
			throw new EnvironmentInstanceError("stop-failed", 500, message(error), {
				cause: error,
			});
		}
		const stoppedAt = this.now().toISOString();
		if (
			!this.state.transitionEnvironmentInstanceStatus(
				record.id,
				"stopping",
				"stopped",
				stoppedAt,
				true,
			)
		)
			throw new EnvironmentInstanceError(
				"lifecycle-conflict",
				409,
				"instance state changed while stopping",
			);
		const stopped = this.state.getEnvironmentInstance(record.id);
		if (!stopped)
			throw new EnvironmentInstanceError(
				"state-error",
				500,
				"instance disappeared after stop",
			);
		return this.toPublic(stopped);
	}

	private async stopObservedDockerProject(
		docker: DockerRuntimeSelection,
		project: string,
	): Promise<void> {
		docker.client.invalidateCache();
		const containers = await docker.client.allContainers();
		const owned = containers.filter(
			(container) =>
				container.Labels?.["com.docker.compose.project"] === project,
		);
		const results = await Promise.allSettled(
			owned.map((container) => docker.client.removeContainer(container.Id)),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		docker.client.invalidateCache();
		const remaining = await docker.client.allContainers();
		if (
			remaining.some(
				(container) =>
					container.Labels?.["com.docker.compose.project"] === project,
			)
		)
			throw new Error(
				`Docker project ${JSON.stringify(project)} still has containers after removal`,
			);
	}

	/** Startup observation never mistakes an unavailable runtime for absence. */
	async reconcile(): Promise<void> {
		const persisted = this.state.getEnvironmentInstances();
		if (persisted.some((instance) => instance.runtime === "docker"))
			await this.dockerRuntime();
		for (const record of persisted) {
			if (record.status === "failed" || record.status === "stopped") {
				this.state.releasePortAllocationsIfStatus(record.id, record.status);
				continue;
			}
			if (record.status === "starting" || record.status === "stopping") {
				const lastActivity = Date.parse(record.lastActivityAt);
				const age = this.now().getTime() - lastActivity;
				if (
					!Number.isFinite(lastActivity) ||
					age < LIFECYCLE_RECONCILE_GRACE_MS
				)
					continue;
			}
			if (
				record.status !== "running" &&
				record.status !== "starting" &&
				record.status !== "stopping" &&
				record.status !== "unknown"
			)
				continue;
			if (record.runtime === "docker") {
				if (!this.docker) {
					this.state.compareAndSetEnvironmentInstanceStatus(
						record.id,
						record.status,
						"unknown",
						this.now().toISOString(),
					);
					continue;
				}
				try {
					const containers = await this.docker.client.allContainers();
					const project = composeProjectName(
						record.app,
						publicInstanceId(record),
					);
					const owned = containers.filter(
						(container) =>
							container.Labels?.["com.docker.compose.project"] === project,
					);
					const unlabeledPrefixCandidate = containers.some(
						(container) =>
							container.Labels?.["com.docker.compose.project"] === undefined &&
							container.Names.some((name) =>
								name.replace(/^\//, "").startsWith(`${project}-`),
							),
					);
					if (
						owned.length === 0 &&
						(unlabeledPrefixCandidate || record.owner === "user")
					) {
						const app = this.apps().find(
							(candidate) => candidate.ident === record.app,
						);
						const target = app
							? discoverTargets(
									this.configDir,
									app,
									record.checkoutPath,
									record.configOverlay,
								).find((candidate) => candidate.id === record.targetId)
							: undefined;
						if (!target || untemplatedConstruct(target.sourcePath)) {
							this.state.compareAndSetEnvironmentInstanceStatus(
								record.id,
								record.status,
								"unknown",
								this.now().toISOString(),
							);
							continue;
						}
					}
					const status = owned.some(
						(container) => container.State === "running",
					)
						? "running"
						: "stopped";
					this.state.transitionEnvironmentInstanceStatus(
						record.id,
						record.status,
						status,
						this.now().toISOString(),
						status === "stopped",
					);
				} catch {
					this.state.compareAndSetEnvironmentInstanceStatus(
						record.id,
						record.status,
						"unknown",
						this.now().toISOString(),
					);
				}
				continue;
			}
			const key = scriptHandleKey(record.id);
			if (!this.scriptInfra.executionHandle(key)) {
				this.state.compareAndSetEnvironmentInstanceStatus(
					record.id,
					record.status,
					"unknown",
					this.now().toISOString(),
				);
				continue;
			}
			try {
				const observed: ScriptStatus = this.scriptInfra.observe
					? await this.scriptInfra.observe(key)
					: await this.scriptInfra.status(key);
				const status =
					observed.status === "running"
						? "running"
						: observed.status === "stopped" || observed.status === "failed"
							? observed.status
							: "unknown";
				this.state.transitionEnvironmentInstanceStatus(
					record.id,
					record.status,
					status,
					this.now().toISOString(),
					status === "stopped" || status === "failed",
				);
			} catch {
				this.state.compareAndSetEnvironmentInstanceStatus(
					record.id,
					record.status,
					"unknown",
					this.now().toISOString(),
				);
			}
		}
	}

	private async refreshScriptInstance(
		record: EnvironmentInstanceRecord,
	): Promise<EnvironmentInstanceRecord> {
		if (
			record.runtime === "docker" ||
			(record.status !== "running" && record.status !== "unknown")
		)
			return record;
		const key = scriptHandleKey(record.id);
		try {
			const observed = this.scriptInfra.observe
				? await this.scriptInfra.observe(key)
				: await this.scriptInfra.status(key);
			const status =
				observed.status === "running"
					? "running"
					: observed.status === "failed"
						? "failed"
						: observed.status === "stopped"
							? "stopped"
							: "unknown";
			if (status !== record.status)
				this.state.transitionEnvironmentInstanceStatus(
					record.id,
					record.status,
					status,
					this.now().toISOString(),
					status === "stopped" || status === "failed",
				);
		} catch {
			this.state.compareAndSetEnvironmentInstanceStatus(
				record.id,
				record.status,
				"unknown",
				this.now().toISOString(),
			);
		}
		return this.state.getEnvironmentInstance(record.id) ?? record;
	}

	private async dockerRuntime(): Promise<DockerRuntimeSelection | undefined> {
		if (this.docker) return this.docker;
		if (!this.resolveDocker) return undefined;
		this.dockerPromise ??= (async () => {
			try {
				this.docker = await this.resolveDocker?.();
			} catch (error) {
				this.logger?.(
					`[instances] Docker runtime selection failed: ${message(error)}`,
				);
			}
			return this.docker;
		})();
		return this.dockerPromise;
	}

	private toPublic(
		record: EnvironmentInstanceRecord,
		allocations: readonly PortAllocationRecord[] = this.state.getPortAllocations(
			record.id,
		),
	): EnvironmentInstance {
		const endpoints = Object.fromEntries(
			allocations.map(({ name, port }) => [name, `http://127.0.0.1:${port}`]),
		);
		return {
			id: publicInstanceId(record),
			owner: parseEnvironmentOwner(record.owner),
			app: record.app,
			targetId: record.targetId,
			runtime: record.runtime,
			checkoutPath: record.checkoutPath,
			...(record.configOverlay ? { configOverlay: record.configOverlay } : {}),
			imageTag: record.imageTag,
			status: record.status as EnvironmentInstance["status"],
			createdAt: record.createdAt,
			lastActivityAt: record.lastActivityAt,
			endpoints,
		};
	}
}

function publicInstanceId(
	record: Pick<EnvironmentInstanceRecord, "id" | "owner">,
): string {
	return record.owner === "user" ? "default" : record.id;
}

function discoverTargets(
	configDir: string,
	app: App,
	checkoutPath: string,
	configOverlay?: string,
): ActionTarget[] {
	const targets = discoverActionTargets({
		appIdent: app.ident,
		localDir: checkoutPath,
		action: "run",
		configDir,
	});
	if (!configOverlay) return targets;
	const overlay = discoverActionTargets({
		appIdent: app.ident,
		localDir: checkoutPath,
		action: "run",
		configDir: configOverlay,
	});
	const byId = new Map<string, ActionTarget>();
	for (const target of targets) byId.set(target.id, target);
	for (const target of overlay) byId.set(target.id, target);
	return [...byId.values()];
}

function selectTarget(
	targets: readonly ActionTarget[],
	request: StartEnvironmentInstanceRequest,
	dockerAvailable: boolean,
): ActionTarget {
	const named = request.target
		? targets.find(
				(candidate) =>
					candidate.id === request.target || candidate.label === request.target,
			)
		: undefined;
	if (request.target && !named)
		throw new EnvironmentInstanceError(
			"target-not-found",
			404,
			`run target ${JSON.stringify(request.target)} not found`,
		);
	if (named) return named;
	let candidates = [...targets].filter(
		(target) =>
			target.runtime === "docker" ||
			target.runtime === "shell" ||
			target.runtime === "systemshell",
	);
	if (!dockerAvailable)
		candidates = candidates.filter((target) => target.runtime !== "docker");
	if (request.profile)
		candidates = candidates.filter(
			(target) =>
				target.profile === request.profile ||
				(!target.profile && request.profile === "default"),
		);
	for (const runtime of ["docker", "shell", "systemshell"]) {
		const matching = candidates.filter((target) => target.runtime === runtime);
		if (matching.length === 0) continue;
		const defaultTarget = matching.find(
			(target) => (target.profile ?? "default") === "default",
		);
		if (defaultTarget) return defaultTarget;
		if (matching.length === 1) return matching[0] as ActionTarget;
		throw new EnvironmentInstanceError(
			"profile-required",
			400,
			`multiple ${runtime} run profiles are available; specify a target or profile`,
		);
	}
	if (targets.length === 0)
		throw new EnvironmentInstanceError(
			"target-not-found",
			404,
			"no run target is configured for this app",
		);
	throw new EnvironmentInstanceError(
		"runtime-unavailable",
		503,
		"no eligible Docker or script run target is available",
	);
}

function untemplatedConstruct(sourcePath: string): string | undefined {
	const source = readSource(sourcePath);
	if (/^\s*container_name\s*:/m.test(source)) return "container_name";
	if (/^\s*include\s*:/m.test(source)) return "include: infrastructure compose";
	return undefined;
}

function readSource(sourcePath: string): string {
	try {
		return fs.readFileSync(sourcePath, "utf8");
	} catch (error) {
		throw new EnvironmentInstanceError(
			"target-unreadable",
			400,
			`cannot read target ${sourcePath}: ${message(error)}`,
			{ cause: error },
		);
	}
}

function isPortBindConflict(output: string): boolean {
	return /address already in use|port is already allocated|failed to bind.*port|port.*already in use/i.test(
		output,
	);
}

function scriptHandleKey(storageId: string): string {
	return `environment-instance:${storageId}`;
}

function environmentWith(
	overrides: Readonly<Record<string, string>>,
	owner: EnvironmentOwner = "workflow:instance-runtime",
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (
			INSTANCE_SCRIPT_ENV_DENYLIST.includes(
				key as (typeof INSTANCE_SCRIPT_ENV_DENYLIST)[number],
			)
		)
			continue;
		if (owner !== "user" && !WORKFLOW_CHILD_ENV_ALLOWLIST.has(key)) continue;
		env[key] = value;
	}
	return Object.assign(env, overrides);
}

async function executeCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn([command, ...args], {
		cwd,
		env: { ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const exitCode = await child.exited;
	return { exitCode, output: `${stdout}${stderr}`.trim() };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
