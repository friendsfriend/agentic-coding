import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { digest } from "../config.ts";
import { contained } from "../git.ts";
import { freezeBuildSecrets } from "./build-secrets.ts";
import { EnvironmentCommands } from "./command.ts";
import { inspectContainer, type Observation } from "./container-observation.ts";
import { HostBuild } from "./host-build.ts";
import type { Plan } from "./model.ts";
import type { LogTiming, RuntimeStatus } from "./process.ts";
import { type Exit, processEnvironment, ShellProcess } from "./shell.ts";
import type { TelemetryCollector } from "./telemetry.ts";

const hostLabel = "dev.agentic-coding.v2.host",
	runLabel = "dev.agentic-coding.v2.run";
/** Resources are controlled only through this live handle and exact labels.
 * Neither names, saved PIDs nor an empty/failed daemon response grant adoption. */
export class ContainerProcess {
	readonly pid = null;
	readonly done: Promise<Exit>;
	readonly queryCredentials: () =>
		| { username: string; password: string }
		| undefined;
	readonly authorization: (endpoint: string) => string | undefined;
	readonly redact: (value: string) => string;
	private complete: (exit: Exit) => void = () => {};
	private result: Exit | null = null;
	private controller = new AbortController();
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private follower: ShellProcess | null = null;
	private commands: EnvironmentCommands;
	private observing: Promise<void> = Promise.resolve();
	private frozen: ReturnType<typeof processEnvironment>;
	private mayHaveCreated = false;
	private createdId: string | null = null;
	private didStart = false;
	private applicationExit: number | null = null;
	private uncertain = false;
	private deadline = 0;
	private spec;
	private name: string;
	private host: string;
	private prefix: string[];
	private buildSecretArguments: string[];
	private observed: RuntimeStatus;
	private failure = "";
	private hostBuild: HostBuild | null = null;
	constructor(
		private plan: Plan,
		private configDir: string,
		private stateDir: string,
		private run: string,
		private network?: { id: string; aliases: string[] },
		startupEnvironment?: ReturnType<typeof processEnvironment>,
		private volumeMounts: {
			name: string;
			target: string;
			readOnly: boolean;
		}[] = [],
		private collector?: TelemetryCollector,
	) {
		if (
			network &&
			(!/^[a-f0-9]{64}$/.test(network.id) ||
				network.aliases.some((alias) => !/^[a-z][a-z0-9-]{0,62}$/.test(alias)))
		)
			throw new Error("Invalid live network attachment");
		if (
			volumeMounts.some(
				(mount) =>
					!/^acv2-volume-[a-f0-9]{32}$/.test(mount.name) ||
					!mount.target.startsWith("/") ||
					/[,\0\r\n]/.test(mount.target),
			)
		)
			throw new Error("Invalid live native volume attachment");
		const spec = plan.container;
		if (!spec || !(plan.runtime === "docker" || plan.runtime === "podman"))
			throw new Error("Structured container configuration is required");
		const build = freezeBuildSecrets(
			plan,
			startupEnvironment ?? processEnvironment(configDir, plan),
		);
		const frozen = build.environment;
		this.buildSecretArguments = build.arguments;
		this.frozen = frozen;
		this.queryCredentials = frozen.queryCredentials;
		this.authorization = frozen.authorization;
		this.redact = frozen.redact;
		this.spec = spec;
		this.host = digest(stateDir);
		this.name = spec.name ?? `acv2-${plan.app}-${this.host.slice(0, 8)}`;
		this.observed = {
			runtime: plan.runtime,
			name: this.name,
			id: null,
			state: "unknown",
			health: null,
			owned: null,
			observedAt: Date.now(),
		};
		this.prefix = [
			plan.runtime === "docker" ? "--host" : "--url",
			plan.runtime === "docker"
				? `unix://${spec.socket}`
				: pathToFileURL(spec.socket).href.replace(/^file:/, "unix:"),
		];
		this.commands = new EnvironmentCommands(
			plan,
			configDir,
			plan.runtime,
			this.prefix,
			frozen,
		);
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	get logs() {
		return `${this.hostBuild?.logs ?? ""}${this.commands.logs}${this.follower?.logs ?? ""}${this.failure ? `\n${this.failure}\n` : ""}`.slice(
			-64000,
		);
	}
	/** Only when the retained buffer is the follower's own text plus an untimed
	 * CLI prefix: a failure suffix would break completed-line alignment. */
	get logTiming(): LogTiming | undefined {
		return this.follower && !this.failure ? this.follower.logTiming : undefined;
	}
	get runtimeStatus(): RuntimeStatus | undefined {
		// An image build has an exit receipt/artifact tag, not a container's health or lifecycle.
		return this.plan.action === "build" ? undefined : { ...this.observed };
	}
	get closing() {
		return this.controller.signal.aborted;
	}
	get outcome() {
		return this.result;
	}
	get cleanupFailed() {
		return (
			this.uncertain ||
			this.hostBuild?.cleanupFailed ||
			this.commands.cleanupFailed ||
			this.commands.uncertainEffect
		);
	}
	private finish(code: number | null, signal: string | null = null) {
		if (this.result) return;
		this.result = { code, signal };
		this.complete(this.result);
	}
	private fail(message: string): never {
		this.failure = message;
		throw new Error(message);
	}
	private budget() {
		this.controller.signal.throwIfAborted();
		const left = this.deadline - Date.now();
		if (left <= 0) this.fail("Container operation timed out");
		return left;
	}
	private command(args: string[], machine = false, effect = false) {
		return this.commands.checked(args, {
			signal: this.controller.signal,
			timeoutMs: this.budget(),
			machine,
			effect,
		});
	}
	/** Live re-observation for admission decisions: a start-time health reading is
	 * never treated as continuing authority. Failure stays unknown, never healthy. */
	async refresh(signal?: AbortSignal): Promise<RuntimeStatus | undefined> {
		if (this.result || this.cleanupFailed) return this.runtimeStatus;
		const bounded = AbortSignal.any([
			this.controller.signal,
			AbortSignal.timeout(2000),
			...(signal ? [signal] : []),
		]);
		await this.observe(false, bounded);
		return this.runtimeStatus;
	}
	private observe(
		cleanup = false,
		diagnosticSignal?: AbortSignal,
	): Promise<Observation | null> {
		// Serialize monitor and diagnostic reads without borrowing each other's
		// cancellation authority. A cancelled queued diagnostic never executes.
		const operation = this.observing.then(() => {
			diagnosticSignal?.throwIfAborted();
			return this.observeCurrent(cleanup, diagnosticSignal);
		});
		this.observing = operation.then(
			() => {},
			() => {},
		);
		if (!diagnosticSignal) return operation;
		return new Promise((resolve, reject) => {
			const abort = () =>
				reject(
					new Error(
						"Container diagnostic observation interrupted or timed out",
					),
				);
			diagnosticSignal.addEventListener("abort", abort, { once: true });
			const detach = () => diagnosticSignal.removeEventListener("abort", abort);
			operation.then(
				(value) => {
					detach();
					resolve(value);
				},
				(error: unknown) => {
					detach();
					reject(error);
				},
			);
			if (diagnosticSignal.aborted) {
				detach();
				abort();
			}
		});
	}
	private async observeCurrent(
		cleanup = false,
		diagnosticSignal?: AbortSignal,
	): Promise<Observation | null> {
		try {
			const observation = await this.inspect(cleanup, diagnosticSignal);
			const health = observation?.health;
			this.observed = {
				...this.observed,
				id: observation?.id ?? null,
				state: observation
					? observation.restarting
						? "unknown"
						: observation.running
							? "running"
							: "stopped"
					: "absent",
				health:
					health === "healthy" ||
					health === "unhealthy" ||
					health === "starting"
						? health
						: null,
				owned: observation ? this.ownership(observation) : null,
				observedAt: Date.now(),
			};
			return observation;
		} catch {
			this.observed = {
				...this.observed,
				state: "unknown",
				health: null,
				owned: null,
				observedAt: Date.now(),
			};
			throw new Error("Container observation failed; absence is not confirmed");
		}
	}
	private async inspect(
		cleanup: boolean,
		diagnosticSignal?: AbortSignal,
	): Promise<Observation | null> {
		const invoke = (args: string[]) =>
			diagnosticSignal
				? this.commands.checked(args, {
						signal: diagnosticSignal,
						timeoutMs: 2000,
						machine: true,
					})
				: cleanup
					? this.commands.checked(args, { timeoutMs: 10000, machine: true })
					: this.command(args, true);
		return inspectContainer(this.name, invoke);
	}
	private ownership(observation: Observation): boolean | null {
		if (
			observation.labels[hostLabel] !== this.host ||
			observation.labels[runLabel] !== this.run
		)
			return false;
		return this.createdId === null ? null : observation.id === this.createdId;
	}
	private owned(observation: Observation) {
		if (this.ownership(observation) !== true) {
			this.failure =
				"Container ownership or live creation identity could not be verified; refusing to mutate or remove an unverified resource";
			throw new Error(this.failure);
		}
	}
	private async start() {
		this.deadline = Date.now() + this.plan.timeoutMs;
		// Resolve mount/build paths immediately before their effects, not just at approval.
		if (this.plan.action === "build") {
			let exit: Exit | undefined;
			try {
				if (this.spec.hostPreparation)
					this.hostBuild = new HostBuild(
						this.plan,
						this.configDir,
						this.stateDir,
						this.frozen,
					);
				const context = this.hostBuild
					? await this.hostBuild.prepare(this.controller.signal, this.deadline)
					: contained(this.plan.workspace, this.spec.context);
				if (!fs.statSync(context).isDirectory())
					throw new Error("Container build context is unavailable");
				let directory: string | undefined;
				let dockerfile: string;
				if (this.spec.dockerfileSource !== undefined) {
					directory = fs.mkdtempSync(
						path.join(this.stateDir, "environment-build-source-"),
					);
					fs.chmodSync(directory, 0o700);
					dockerfile = path.join(directory, "Dockerfile");
				} else
					dockerfile = contained(this.plan.workspace, this.spec.dockerfile);
				try {
					if (this.spec.dockerfileSource !== undefined)
						fs.writeFileSync(dockerfile, this.spec.dockerfileSource, {
							flag: "wx",
							mode: 0o600,
						});
					if (!fs.statSync(dockerfile).isFile())
						throw new Error("Container Dockerfile is unavailable");
					this.hostBuild?.verify();
					const result = await this.commands.run(
						[
							"build",
							"--file",
							dockerfile,
							"--tag",
							this.spec.image,
							...this.spec.buildArgs.flatMap((key) => ["--build-arg", key]),
							...this.buildSecretArguments,
							context,
						],
						{
							signal: this.controller.signal,
							timeoutMs: this.budget(),
							effect: true,
						},
					);
					exit = result.exit;
				} finally {
					if (directory)
						try {
							fs.unlinkSync(dockerfile);
							fs.rmdirSync(directory);
						} catch {
							this.uncertain = true;
							this.failure =
								"Captured build-source cleanup uncertain; inspection required";
						}
				}
				if (this.uncertain) throw new Error(this.failure);
			} finally {
				this.hostBuild?.cleanup();
			}
			if (exit) this.finish(exit.code, exit.signal);
			return;
		}
		const mounts = this.spec.mounts.flatMap((mount) => {
			const source = contained(this.plan.workspace, mount.source);
			if (!fs.existsSync(source) || source.includes(","))
				throw new Error("Invalid container bind source");
			return [
				"--mount",
				`type=bind,src=${source},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
			];
		});
		// Even matching labels are not automatic adoption authority for a new effect.
		if (await this.observe()) {
			this.failure =
				"The configured container name is already occupied; no existing container was adopted or stopped";
			throw new Error(this.failure);
		}
		const variables = [
			...Object.keys(this.plan.environment),
			...Object.keys(this.plan.secretRefs),
			...Object.keys(this.collector?.containerEnvironment() ?? {}),
		];
		const create = [
			"create",
			"--name",
			this.name,
			"--label",
			`${hostLabel}=${this.host}`,
			"--label",
			`${runLabel}=${this.run}`,
			...(this.network
				? [
						"--network",
						this.network.id,
						...this.network.aliases.flatMap((alias) => [
							"--network-alias",
							alias,
						]),
					]
				: []),
			...this.spec.ports.flatMap((port) => [
				"--publish",
				`${port.address.includes(":") ? `[${port.address}]` : port.address}:${port.host}:${port.container}/${port.protocol}`,
			]),
			...mounts,
			...(this.collector ? ["--mount", this.collector.certificateMount()] : []),
			...this.volumeMounts.flatMap((mount) => [
				"--mount",
				`type=volume,src=${mount.name},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
			]),
			...(this.spec.restart ? ["--restart", this.spec.restart] : []),
			...(this.spec.shmSize === undefined
				? []
				: ["--shm-size", String(this.spec.shmSize)]),
			...Object.entries(this.spec.extraHosts ?? {}).flatMap(
				([host, address]) => ["--add-host", `${host}=${address}`],
			),
			...variables.flatMap((key) => ["--env", key]),
			...(this.spec.entrypoint ? ["--entrypoint", this.spec.entrypoint] : []),
			...(this.spec.health
				? [
						"--health-cmd",
						this.spec.health.command,
						"--health-interval",
						this.spec.health.interval,
						"--health-timeout",
						this.spec.health.timeout,
						"--health-retries",
						String(this.spec.health.retries),
						...(this.spec.health.startPeriod
							? ["--health-start-period", this.spec.health.startPeriod]
							: []),
					]
				: []),
			this.spec.image,
			...this.spec.command,
		];
		this.mayHaveCreated = true;
		const receipt = (await this.command(create, true, true)).trim();
		if (!/^[a-f0-9]{64}$/.test(receipt)) {
			this.uncertain = true;
			throw new Error(
				"Created container identity receipt is invalid; labels alone do not grant cleanup authority",
			);
		}
		this.createdId = receipt;
		const created = await this.observe();
		if (!created) throw new Error("Created container could not be observed");
		this.owned(created);
		// Use the immutable ID returned by the ownership check for each mutation.
		await this.command(["start", created.id], false, true);
		this.didStart = true;
		this.follower = new ShellProcess(
			{ ...this.plan, readyText: null },
			this.configDir,
			{
				executable: this.plan.runtime,
				args: [
					...this.prefix,
					"logs",
					"--follow",
					"--timestamps",
					"--tail",
					"200",
					created.id,
				],
				runtimeTimestamps: true,
				environment: this.frozen,
			},
		);
		if (!(await this.follower.spawned))
			throw new Error("Container log follower could not start");
		// A declared one-shot run has no long-lived readiness: its exit receipt is
		// the result, exactly like a build/test action.
		if (this.plan.action !== "run" || this.spec.completion) {
			const receipt = (await this.command(["wait", created.id], true)).trim();
			const code = Number(receipt);
			if (!/^\d{1,3}$/.test(receipt) || code > 255)
				throw new Error("Invalid container exit receipt");
			await this.cleanup();
			this.finish(code);
			return;
		}
		for (;;) {
			this.budget();
			const observed = await this.observe();
			if (!observed) this.fail("Container disappeared during startup");
			this.owned(observed);
			if (observed.restarting) {
				await Bun.sleep(100);
				continue;
			}
			if (
				observed.running &&
				(this.spec.readiness === "running" || observed.health === "healthy")
			)
				break;
			if (!observed.running) this.fail("Container exited during startup");
			if (observed.health === "unhealthy")
				this.fail("Container reported unhealthy");
			await Bun.sleep(100);
		}
		this.monitoring = this.monitor();
	}
	private async monitor() {
		while (!this.controller.signal.aborted && !this.result) {
			await delay(1000, undefined, { signal: this.controller.signal }).catch(
				() => {},
			);
			if (this.controller.signal.aborted || this.result) return;
			// Startup timeout does not become an artificial lifetime limit.
			this.deadline = Date.now() + 10000;
			try {
				const observation = await this.observe();
				if (!observation) throw new Error("Container observation disappeared");
				this.owned(observation);
				if (!observation.running && !observation.restarting) {
					await this.cleanup();
					this.finish(observation.exitCode);
					return;
				}
			} catch {
				if (!this.controller.signal.aborted) {
					this.uncertain = true;
					this.failure ||=
						"Container observation or cleanup failed; the resource remains quarantined, not absent";
					// A failed daemon observation must not orphan the local log client.
					try {
						await this.follower?.stop();
					} catch {
						/* The lease stays quarantined. */
					}
					this.finish(null);
				}
				return;
			}
		}
	}
	async ready(signal?: AbortSignal) {
		const abort = () => this.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			if (!this.starting)
				this.starting = this.start().catch((error) => {
					this.failure ||=
						Date.now() >= this.deadline
							? "Container startup/action timed out; inspect redacted CLI logs and resource status"
							: "Container startup/action failed or was interrupted; inspect redacted CLI logs and resource status";
					throw error;
				});
			await this.starting;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	async wait(signal?: AbortSignal) {
		await this.ready(signal);
		return this.done;
	}
	private async cleanup() {
		if (this.follower) {
			await this.follower.stop();
			if (this.follower.cleanupFailed)
				throw new Error("Container log follower cleanup is uncertain");
		}
		if (!this.mayHaveCreated) return;
		const existing = await this.observe(true);
		if (!existing) {
			this.mayHaveCreated = false;
			return;
		}
		this.owned(existing);
		if (existing.running || existing.restarting)
			await this.commands.checked(["stop", "--time", "2", existing.id], {
				timeoutMs: 10000,
				effect: true,
			});
		// Recheck identity after stop; never remove a replacement by name.
		const stopped = await this.observe(true);
		if (stopped) {
			this.owned(stopped);
			if (stopped.running || stopped.restarting)
				throw new Error("Container stop has not settled; refusing removal");
			if (this.didStart && !stopped.running)
				this.applicationExit = stopped.exitCode;
			if (stopped.id !== existing.id)
				throw new Error("Container identity changed during cleanup");
			await this.commands.checked(["rm", stopped.id], {
				timeoutMs: 10000,
				effect: true,
			});
		}
		if (await this.observe(true))
			throw new Error("Container removal could not be confirmed");
		this.mayHaveCreated = false;
	}
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			this.controller.abort();
			try {
				await this.starting;
			} catch {
				/* Cleanup still owns any partial creation. */
			}
			await this.monitoring;
			try {
				await this.cleanup();
			} catch {
				this.uncertain = true;
				this.failure ||=
					"Container cleanup could not be confirmed; inspect the resource before releasing its slot";
			}
			this.finish(this.cleanupFailed ? null : this.applicationExit);
			if (this.cleanupFailed)
				throw new Error("Container cleanup is uncertain; inspection required");
		})();
		return this.stopping;
	}
}
