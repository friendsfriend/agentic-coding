import { type Config, digest, object } from "../config.ts";
import { openClusterClient } from "./cluster.ts";
import type { Plan } from "./model.ts";
import type { EnvironmentProcess, Exit, RuntimeStatus } from "./process.ts";
import { processEnvironment, type ShellProcess } from "./shell.ts";

const hostLabel = "dev.agentic-coding.v2.host",
	runLabel = "dev.agentic-coding.v2.run";
type Pod = {
	uid: string;
	version: string;
	labels: Record<string, unknown>;
	ready: boolean;
	running: boolean;
	stopped: boolean;
	exitCode: number | null;
};
type ClusterService = {
	uid: string;
	version: string;
	labels: Record<string, unknown>;
	clusterIP: string;
};
function budget(ms: number) {
	const until = Date.now() + ms;
	return () => {
		const remaining = until - Date.now();
		if (!Number.isFinite(remaining) || remaining <= 0)
			throw new Error("Kubernetes operation timed out");
		return remaining;
	};
}
/** Bare pods only: no controller adoption, namespace creation or cascading delete.
 * Names/labels are insufficient authority; DELETE always carries the live UID receipt. */
export class KubernetesProcess implements EnvironmentProcess {
	readonly pid = null;
	/** Frozen endpoint credentials and redaction for this approved plan. */
	readonly authorization: ReturnType<
		typeof processEnvironment
	>["authorization"];
	readonly queryCredentials: ReturnType<
		typeof processEnvironment
	>["queryCredentials"];
	readonly redact: ReturnType<typeof processEnvironment>["redact"];
	readonly done: Promise<Exit>;
	private complete: ((exit: Exit) => void) | undefined;
	private client: ReturnType<typeof openClusterClient> | null = null;
	private controller = new AbortController();
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private created = new Map<string, string>();
	private attempted = new Set<string>();
	private createdServices = new Map<string, ClusterService>();
	private attemptedServices = new Set<string>();
	private statuses = new Map<string, RuntimeStatus>();
	private failure = "";
	private uncertain = false;
	private result: Exit | null = null;
	private terminal: Exit | null = null;
	private host: string;
	private run: string;
	private names: string[];
	private followers = new Map<string, ShellProcess>();
	private forwards = new Map<string, ShellProcess>();
	private waiters: {
		name: string;
		resolve: (pod: Pod) => void;
		reject: (error: Error) => void;
	}[] = [];
	constructor(
		private config: Config,
		private plan: Plan,
		run: string,
	) {
		if (
			!plan.kubernetes ||
			plan.kubernetes.workload !== undefined ||
			!plan.clusterConnection
		)
			throw new Error(
				"An approved explicit Kubernetes connection and bare pod plan are required",
			);
		const frozen = processEnvironment(config.configDir, plan);
		this.authorization = frozen.authorization;
		this.queryCredentials = frozen.queryCredentials;
		this.redact = frozen.redact;
		this.host = digest(config.stateDir).slice(0, 32);
		this.run = digest(run).slice(0, 32);
		this.names = Array.from(
			{ length: plan.kubernetes.replicas },
			(_, index) =>
				`acv2-${digest(JSON.stringify([config.stateDir, plan.app])).slice(0, 20)}-${index}`,
		);
		for (const name of this.names)
			this.statuses.set(name, {
				runtime: "kubernetes",
				kind: "pod",
				name: `${plan.kubernetes.namespace}/${name}`,
				id: null,
				state: "unknown",
				health: null,
				readiness: plan.kubernetes.readinessProbe
					? plan.kubernetes.readinessProbe.httpGet
						? "http-probe"
						: "tcp-probe"
					: "pod-ready",
				owned: null,
				observedAt: Date.now(),
			});
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	get outcome() {
		return this.result;
	}
	get closing() {
		return this.stopping !== null;
	}
	/** Pod log buffers are only exposed for a single owned replica: merging
	 * several pods would invent a chronology this adapter cannot verify. Name
	 * an explicit replica instead; an absent selection with several followers
	 * stays refused. */
	get logs() {
		if (this.failure) return `${this.failure}\n`;
		const follower =
			this.followers.size === 1 ? [...this.followers.values()][0] : undefined;
		if (follower) return follower.logs;
		return "Kubernetes pod logs are not exported for this run: capture is limited to one owned replica, and no merge of several pod buffers is invented.\n";
	}
	/** One owned replica's bounded buffer by explicit index, or undefined when
	 * the replica names no followed pod. Never a merged chronology. */
	logsFor(replica: number) {
		if (this.failure) return `${this.failure}\n`;
		if (!Number.isSafeInteger(replica) || replica < 0) return undefined;
		const name = this.names[replica];
		if (name === undefined) return undefined;
		return this.followers.get(name)?.logs;
	}
	get logTiming() {
		return this.failure
			? undefined
			: this.followers.size === 1
				? [...this.followers.values()][0]?.logTiming
				: undefined;
	}
	get cleanupFailed() {
		return (
			this.uncertain ||
			this.client?.commands.cleanupFailed === true ||
			this.client?.commands.uncertainEffect === true
		);
	}
	get runtimeStatuses() {
		return [...this.statuses.values()].map((value) => ({ ...value }));
	}
	/** One fresh read of the owned replica pinned by the declared forward on
	 * this port: the live pod UID/readiness plus whether that forward is still
	 * its own running process. The read is performed by the single observation
	 * loop, so a diagnostic never competes with it for the CLI. A forward is a
	 * local client, never readiness, ownership or network proof. */
	async diagnostic(local: number, signal?: AbortSignal) {
		const forward = this.target.portForwards?.find(
			(candidate) => candidate.local === local,
		);
		const name =
			forward === undefined ? undefined : this.names[forward.replica ?? 0];
		if (forward === undefined || name === undefined)
			throw new Error(
				"Kubernetes diagnostics require a declared loopback port forward pinning one owned pod replica",
			);
		if (this.stopping || this.result)
			throw new Error("Owned Kubernetes pod runtime is closing");
		const pod = await new Promise<Pod>((resolve, reject) => {
			const timer = setTimeout(
					() =>
						reject(
							new Error("Kubernetes diagnostic observation did not complete"),
						),
					15000,
				),
				settle = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
				},
				cancel = () => {
					settle();
					reject(new Error("Kubernetes diagnostic observation was cancelled"));
				};
			signal?.addEventListener("abort", cancel, { once: true });
			this.waiters.push({
				name,
				resolve: (value) => {
					settle();
					resolve(value);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});
		});
		this.owned(pod, name);
		const status = this.statuses.get(name);
		if (!status) throw new Error("Owned Kubernetes pod is not observed");
		return {
			status: { ...status },
			/** Exactly the plan's declared forward, still running, not reopened. */
			forwarded: (local: number, remote: number) => {
				if (
					!this.target.portForwards?.some(
						(candidate) =>
							candidate.local === local && candidate.remote === remote,
					)
				)
					return false;
				const forward = this.forwards.get(`${local}:${remote}`);
				return forward !== undefined && !forward.closing && !forward.outcome;
			},
		};
	}
	private get target() {
		const target = this.plan.kubernetes;
		if (!target || target.workload) throw new Error("Bare pod target missing");
		return target;
	}
	private get commands() {
		if (!this.client) throw new Error("Kubernetes client not initialized");
		return this.client.commands;
	}
	private path(name?: string) {
		const base = `/api/v1/namespaces/${this.target.namespace}/pods`;
		return name ? `${base}/${name}` : base;
	}
	private servicePath(name?: string) {
		const base = `/api/v1/namespaces/${this.target.namespace}/services`;
		return name ? `${base}/${name}` : base;
	}
	private parseService(raw: unknown, name: string): ClusterService {
		try {
			const value = object(raw),
				metadata = object(value.metadata),
				labels = object(metadata.labels ?? {}),
				spec = object(value.spec ?? {});
			if (
				value.kind !== "Service" ||
				metadata.name !== name ||
				metadata.namespace !== this.target.namespace ||
				typeof metadata.resourceVersion !== "string" ||
				!metadata.resourceVersion ||
				typeof metadata.uid !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
					metadata.uid,
				) ||
				typeof spec.clusterIP !== "string" ||
				!spec.clusterIP ||
				spec.clusterIP === "None"
			)
				throw new Error();
			return {
				uid: metadata.uid,
				version: metadata.resourceVersion,
				labels,
				clusterIP: spec.clusterIP,
			};
		} catch {
			throw new Error(
				"Invalid private Kubernetes service observation; absence is not confirmed",
			);
		}
	}
	private parse(raw: unknown, name: string): Pod {
		try {
			const value = object(raw),
				metadata = object(value.metadata),
				labels = object(metadata.labels ?? {}),
				status = object(value.status ?? {});
			if (
				value.kind !== "Pod" ||
				metadata.name !== name ||
				metadata.namespace !== this.target.namespace ||
				typeof metadata.resourceVersion !== "string" ||
				!metadata.resourceVersion ||
				metadata.resourceVersion.length > 200 ||
				typeof metadata.uid !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
					metadata.uid,
				)
			)
				throw new Error();
			const conditions = Array.isArray(status.conditions)
				? status.conditions.map(object)
				: [];
			const containers = Array.isArray(status.containerStatuses)
					? status.containerStatuses.map(object)
					: [],
				app = containers.find((container) => container.name === "app"),
				state = object(app?.state ?? {}),
				terminated =
					state.terminated === undefined ? null : object(state.terminated);
			return {
				uid: metadata.uid,
				version: metadata.resourceVersion,
				labels,
				ready:
					conditions.some(
						(condition) =>
							condition.type === "Ready" && condition.status === "True",
					) &&
					status.phase === "Running" &&
					!metadata.deletionTimestamp,
				running: status.phase === "Running",
				stopped: status.phase === "Succeeded" || status.phase === "Failed",
				exitCode:
					terminated &&
					Number.isSafeInteger(terminated.exitCode) &&
					Number(terminated.exitCode) >= 0 &&
					Number(terminated.exitCode) <= 255
						? Number(terminated.exitCode)
						: null,
			};
		} catch {
			throw new Error(
				"Invalid private Kubernetes pod observation; absence is not confirmed",
			);
		}
	}
	private owned(pod: Pod, name: string) {
		if (
			this.created.get(name) !== pod.uid ||
			pod.labels[hostLabel] !== this.host ||
			pod.labels[runLabel] !== this.run
		)
			throw new Error(
				"Pod ownership or live creation UID changed; refusing mutation",
			);
	}
	private ownedService(service: ClusterService, name: string) {
		if (
			this.createdServices.get(name)?.uid !== service.uid ||
			service.labels[hostLabel] !== this.host ||
			service.labels[runLabel] !== this.run
		)
			throw new Error(
				"Service ownership or live creation UID changed; refusing mutation",
			);
	}
	/** Null when no service answers under this name. A failed observation is
	 * not absence: creation still runs and refuses on an occupied name rather
	 * than adopting it. */
	private async observeService(
		name: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ClusterService | null> {
		try {
			const raw = await this.commands.checked(
				["get", "--raw", this.servicePath(name)],
				{ timeoutMs, signal, machine: true },
			);
			return this.parseService(JSON.parse(raw), name);
		} catch {
			return null;
		}
	}
	/** ClusterIP only with this run's owner labels as the single selector.
	 * No type, external, headless or port overrides are declarable. */
	private serviceManifest(entry: {
		name: string;
		port: number;
		targetPort: number;
	}) {
		return {
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: entry.name,
				namespace: this.target.namespace,
				labels: { [hostLabel]: this.host, [runLabel]: this.run },
			},
			spec: {
				type: "ClusterIP",
				selector: { [hostLabel]: this.host, [runLabel]: this.run },
				ports: [
					{
						port: entry.port,
						targetPort: entry.targetPort,
						protocol: "TCP",
					},
				],
			},
		};
	}
	private async observe(name: string, timeoutMs: number, signal?: AbortSignal) {
		try {
			const raw = await this.commands.checked(
				[
					"get",
					"--raw",
					`${this.path()}?fieldSelector=${encodeURIComponent(`metadata.name=${name}`)}&limit=2`,
				],
				{ timeoutMs, signal, machine: true },
			);
			const data = object(JSON.parse(raw)),
				pagination = object(data.metadata ?? {}).continue;
			if (
				data.kind !== "PodList" ||
				!Array.isArray(data.items) ||
				data.items.length > 1 ||
				(pagination !== undefined && pagination !== "")
			)
				throw new Error();
			const pod = data.items.length ? this.parse(data.items[0], name) : null,
				previous = this.statuses.get(name);
			if (!previous) throw new Error();
			this.statuses.set(name, {
				...previous,
				id: pod?.uid ?? null,
				state: pod
					? pod.stopped
						? "stopped"
						: pod.running
							? "running"
							: "unknown"
					: "absent",
				health:
					!pod || pod.stopped
						? null
						: pod.ready
							? "healthy"
							: previous.health === "healthy" || previous.health === "unhealthy"
								? "unhealthy"
								: "starting",
				owned: pod
					? this.created.has(name)
						? this.created.get(name) === pod.uid &&
							pod.labels[hostLabel] === this.host &&
							pod.labels[runLabel] === this.run
						: false
					: null,
				observedAt: Date.now(),
			});
			return pod;
		} catch {
			const previous = this.statuses.get(name);
			if (previous)
				this.statuses.set(name, {
					...previous,
					state: "unknown",
					health: null,
					owned: null,
					observedAt: Date.now(),
				});
			throw new Error(
				"Kubernetes observation failed; absence is not confirmed",
			);
		}
	}
	private manifest(name: string) {
		const env = processEnvironment(this.config.configDir, this.plan).env;
		return {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name,
				namespace: this.target.namespace,
				labels: { [hostLabel]: this.host, [runLabel]: this.run },
			},
			spec: {
				restartPolicy: "Never",
				automountServiceAccountToken: false,
				enableServiceLinks: false,
				containers: [
					{
						name: "app",
						image: this.target.image,
						...(this.target.readinessProbe
							? { readinessProbe: this.target.readinessProbe }
							: {}),
						...(this.target.command.length
							? { command: this.target.command }
							: {}),
						...(this.target.args.length ? { args: this.target.args } : {}),
						env: [
							...Object.keys(this.plan.environment),
							...Object.keys(this.plan.secretRefs),
						].map((name) => ({ name, value: env[name as keyof typeof env] })),
						securityContext: {
							allowPrivilegeEscalation: false,
							capabilities: { drop: ["ALL"] },
						},
					},
				],
			},
		};
	}
	private async start() {
		if (!this.plan.clusterConnection)
			throw new Error("Explicit Kubernetes connection missing");
		const remaining = budget(this.plan.timeoutMs);
		this.controller.signal.throwIfAborted();
		this.client = openClusterClient(this.config, this.plan.clusterConnection);
		// Services select by owner labels before any pod exists, so peer-dependent
		// readiness can resolve through in-cluster DNS. An occupied name refuses
		// without adoption even when creation later confirms it.
		for (const entry of this.target.services ?? []) {
			this.controller.signal.throwIfAborted();
			if (
				await this.observeService(
					entry.name,
					remaining(),
					this.controller.signal,
				)
			)
				throw new Error(
					"Service name is occupied; no existing service was adopted",
				);
			const input = JSON.stringify(this.serviceManifest(entry));
			if (Buffer.byteLength(input) > 1048576)
				throw new Error("Kubernetes service request exceeds its size bound");
			this.attemptedServices.add(entry.name);
			const raw = await this.commands.checked(
				["create", "--raw", this.servicePath(), "-f", "-"],
				{
					timeoutMs: remaining(),
					signal: this.controller.signal,
					machine: true,
					effect: true,
					input,
				},
			);
			let service: ClusterService;
			try {
				service = this.parseService(JSON.parse(raw), entry.name);
			} catch {
				this.uncertain = true;
				throw new Error(
					"Kubernetes service creation receipt is invalid; refusing name-based adoption",
				);
			}
			if (
				service.labels[hostLabel] !== this.host ||
				service.labels[runLabel] !== this.run
			) {
				this.uncertain = true;
				throw new Error(
					"Kubernetes service creation receipt ownership mismatch",
				);
			}
			this.createdServices.set(entry.name, service);
		}
		for (const name of this.names) {
			this.controller.signal.throwIfAborted();
			if (await this.observe(name, remaining(), this.controller.signal))
				throw new Error("Pod name is occupied; no existing pod was adopted");
			const input = JSON.stringify(this.manifest(name));
			if (Buffer.byteLength(input) > 1048576)
				throw new Error("Kubernetes pod request exceeds its size bound");
			this.attempted.add(name);
			const raw = await this.commands.checked(
				["create", "--raw", this.path(), "-f", "-"],
				{
					timeoutMs: remaining(),
					signal: this.controller.signal,
					machine: true,
					effect: true,
					input,
				},
			);
			let pod: Pod;
			try {
				pod = this.parse(JSON.parse(raw), name);
			} catch {
				this.uncertain = true;
				throw new Error(
					"Kubernetes creation receipt is invalid; refusing name-based adoption",
				);
			}
			if (
				pod.labels[hostLabel] !== this.host ||
				pod.labels[runLabel] !== this.run
			) {
				this.uncertain = true;
				throw new Error("Kubernetes creation receipt ownership mismatch");
			}
			this.created.set(name, pod.uid);
		}
		// Log capture starts only after every replica is ready, so a follower never
		// becomes an independent health or adoption signal.
		// Create every replica before waiting: a pod's readiness may depend on peers.
		for (const name of this.names) {
			for (;;) {
				this.controller.signal.throwIfAborted();
				const observed = await this.observe(
					name,
					remaining(),
					this.controller.signal,
				);
				if (!observed) throw new Error("Created Kubernetes pod disappeared");
				this.owned(observed, name);
				if (observed.stopped) {
					this.terminal = { code: observed.exitCode, signal: null };
					throw new Error("Kubernetes app exited before readiness");
				}
				if (observed.ready) break;
				await Bun.sleep(Math.min(100, remaining()));
			}
		}
		if (this.client) {
			for (const forward of this.target.portForwards ?? []) {
				const target = this.names[forward.replica ?? 0];
				if (!target) throw new Error("Kubernetes pod identity is missing");
				const process = this.client.forward(
					this.target.namespace,
					target,
					forward.local,
					forward.remote,
				);
				if (!(await process.spawned))
					throw new Error("Kubernetes port forward could not start");
				this.forwards.set(`${forward.local}:${forward.remote}`, process);
			}
			for (const name of this.names) {
				const follower = this.client.follow(this.target.namespace, name);
				if (await follower.spawned) this.followers.set(name, follower);
			}
		}
	}
	private async monitor() {
		try {
			while (!this.controller.signal.aborted) {
				await Bun.sleep(200);
				if (this.controller.signal.aborted) return;
				for (const name of this.names) {
					const pod = await this.observe(name, 10000, this.controller.signal);
					if (!pod) throw new Error("Owned Kubernetes pod disappeared");
					this.owned(pod, name);
					if (pod.stopped) {
						this.terminal = { code: pod.exitCode, signal: null };
						void this.stop();
						return;
					}
					// A diagnostic waits for its own pinned replica only: resolving
					// another pod's observation would refuse on the UID check.
					for (let index = this.waiters.length - 1; index >= 0; index--) {
						const waiter = this.waiters[index];
						if (waiter?.name === name) {
							this.waiters.splice(index, 1);
							waiter.resolve(pod);
						}
					}
				}
			}
		} catch {
			for (const waiter of this.waiters.splice(0))
				waiter.reject(
					new Error("Kubernetes observation was lost; no diagnostic binding"),
				);
			if (!this.controller.signal.aborted) {
				this.uncertain = true;
				this.failure =
					"Kubernetes runtime identity or observation was lost; resources require inspection";
				void this.stop();
			}
		}
	}
	async ready(signal?: AbortSignal) {
		signal?.throwIfAborted();
		const abort = () => {
			void this.stop();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			this.starting ??= this.start();
			await this.starting;
			signal?.throwIfAborted();
			this.controller.signal.throwIfAborted();
			this.monitoring ??= this.monitor();
		} catch (error) {
			this.failure =
				error instanceof Error ? error.message : "Kubernetes startup failed";
			await this.stop();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	async wait(signal?: AbortSignal) {
		await this.ready(signal);
		return this.done;
	}
	async stop() {
		this.stopping ??= (async () => {
			this.controller.abort();
			for (const forward of this.forwards.values())
				try {
					await forward.stop();
					if (forward.cleanupFailed) this.uncertain = true;
				} catch {
					this.uncertain = true;
				}
			this.forwards.clear();
			for (const waiter of this.waiters.splice(0))
				waiter.reject(new Error("Owned Kubernetes pod runtime is closing"));
			for (const follower of this.followers.values())
				try {
					await follower.stop();
					if (follower.cleanupFailed) this.uncertain = true;
				} catch {
					this.uncertain = true;
				}
			this.followers.clear();
			await this.starting?.catch(() => {});
			await this.monitoring?.catch(() => {});
			const remaining = budget(15000),
				deleting: string[] = [];
			if (this.client)
				for (const name of [...this.attempted].reverse())
					try {
						const pod = await this.observe(name, remaining());
						if (!pod) continue;
						this.owned(pod, name);
						await this.commands.checked(
							["delete", "--raw", this.path(name), "-f", "-"],
							{
								timeoutMs: remaining(),
								machine: true,
								effect: true,
								input: JSON.stringify({
									apiVersion: "v1",
									kind: "DeleteOptions",
									preconditions: { uid: pod.uid, resourceVersion: pod.version },
									propagationPolicy: "Orphan",
									gracePeriodSeconds: 5,
								}),
							},
						);
						deleting.push(name);
					} catch {
						this.uncertain = true;
						this.failure =
							"Kubernetes cleanup is uncertain or UID ownership changed; resources remain quarantined";
					}
			// Issue all checked deletes before waiting so replica grace periods overlap.
			for (const name of deleting)
				try {
					for (;;) {
						const current = await this.observe(name, remaining());
						if (!current) break;
						this.owned(current, name);
						await Bun.sleep(Math.min(100, remaining()));
					}
				} catch {
					this.uncertain = true;
					this.failure =
						"Kubernetes deletion was not confirmed; app slot remains quarantined";
				}
			// Services delete after their pods with the live creation UID and
			// observed resource version; a missing or changed service quarantines
			// instead of claiming cleanup.
			for (const name of [...this.attemptedServices].reverse())
				try {
					const service = await this.observeService(name, remaining());
					if (!service) throw new Error("Owned Kubernetes service is gone");
					this.ownedService(service, name);
					await this.commands.checked(
						["delete", "--raw", this.servicePath(name), "-f", "-"],
						{
							timeoutMs: remaining(),
							machine: true,
							effect: true,
							input: JSON.stringify({
								apiVersion: "v1",
								kind: "DeleteOptions",
								preconditions: {
									uid: service.uid,
									resourceVersion: service.version,
								},
								propagationPolicy: "Orphan",
								gracePeriodSeconds: 5,
							}),
						},
					);
					for (;;) {
						const current = await this.observeService(name, remaining());
						if (!current) break;
						this.ownedService(current, name);
						await Bun.sleep(Math.min(100, remaining()));
					}
				} catch {
					this.uncertain = true;
					this.failure =
						"Kubernetes service cleanup is uncertain or UID ownership changed; resources remain quarantined";
				}
			try {
				this.client?.close();
			} catch {
				this.uncertain = true;
				this.failure =
					"Private Kubernetes client cleanup failed; app slot remains quarantined";
			}
			this.result = this.cleanupFailed
				? { code: null, signal: null }
				: (this.terminal ?? { code: null, signal: null });
			this.complete?.(this.result);
		})();
		await this.stopping;
	}
}
