import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { digest } from "../config.ts";
import { contained } from "../git.ts";
import { EnvironmentCommands } from "./command.ts";
import { inspectContainer, type Observation } from "./container-observation.ts";
import type { Plan } from "./model.ts";
import type { LogTiming, RuntimeStatus } from "./process.ts";
import { type Exit, processEnvironment, ShellProcess } from "./shell.ts";

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
	readonly redact: (value: string) => string;
	private complete: (exit: Exit) => void = () => {};
	private result: Exit | null = null;
	private controller = new AbortController();
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private follower: ShellProcess | null = null;
	private commands: EnvironmentCommands;
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
	private observed: RuntimeStatus;
	private failure = "";
	constructor(
		private plan: Plan,
		private configDir: string,
		stateDir: string,
		private run: string,
		private network?: { id: string; aliases: string[] },
	) {
		if (
			network &&
			(!/^[a-f0-9]{64}$/.test(network.id) ||
				network.aliases.some((alias) => !/^[a-z][a-z0-9-]{0,62}$/.test(alias)))
		)
			throw new Error("Invalid live network attachment");
		const spec = plan.container;
		if (!spec || !(plan.runtime === "docker" || plan.runtime === "podman"))
			throw new Error("Structured container configuration is required");
		const frozen = processEnvironment(configDir, plan);
		this.queryCredentials = frozen.queryCredentials;
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
		);
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	get logs() {
		return `${this.commands.logs}${this.follower?.logs ?? ""}${this.failure ? `\n${this.failure}\n` : ""}`.slice(
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
	get outcome() {
		return this.result;
	}
	get cleanupFailed() {
		return (
			this.uncertain ||
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
	private async observe(cleanup = false): Promise<Observation | null> {
		try {
			const observation = await this.inspect(cleanup);
			const health = observation?.health;
			this.observed = {
				...this.observed,
				id: observation?.id ?? null,
				state: observation
					? observation.running
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
	private async inspect(cleanup: boolean): Promise<Observation | null> {
		const invoke = (args: string[]) =>
			cleanup
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
			const context = contained(this.plan.workspace, this.spec.context),
				dockerfile = contained(this.plan.workspace, this.spec.dockerfile);
			if (
				!fs.statSync(context).isDirectory() ||
				!fs.statSync(dockerfile).isFile()
			)
				throw new Error("Container build context/Dockerfile is unavailable");
			const result = await this.commands.run(
				[
					"build",
					"--file",
					dockerfile,
					"--tag",
					this.spec.image,
					...this.spec.buildArgs.flatMap((key) => ["--build-arg", key]),
					context,
				],
				{
					signal: this.controller.signal,
					timeoutMs: this.budget(),
					effect: true,
				},
			);
			this.finish(result.exit.code, result.exit.signal);
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
				if (!observation.running) {
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
		if (existing.running)
			await this.commands.checked(["stop", "--time", "2", existing.id], {
				timeoutMs: 10000,
				effect: true,
			});
		// Recheck identity after stop; never remove a replacement by name.
		const stopped = await this.observe(true);
		if (stopped) {
			this.owned(stopped);
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
