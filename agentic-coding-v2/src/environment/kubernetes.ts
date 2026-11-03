import { type Config, digest, object } from "../config.ts";
import type { Plan } from "./catalog.ts";
import { openClusterClient } from "./cluster.ts";
import type { EnvironmentProcess, Exit, RuntimeStatus } from "./process.ts";
import { processEnvironment } from "./shell.ts";

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
	readonly done: Promise<Exit>;
	private complete: ((exit: Exit) => void) | undefined;
	private client: ReturnType<typeof openClusterClient> | null = null;
	private controller = new AbortController();
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private created = new Map<string, string>();
	private attempted = new Set<string>();
	private statuses = new Map<string, RuntimeStatus>();
	private failure = "";
	private uncertain = false;
	private result: Exit | null = null;
	private terminal: Exit | null = null;
	private host: string;
	private run: string;
	private names: string[];
	constructor(
		private config: Config,
		private plan: Plan,
		run: string,
	) {
		if (!plan.kubernetes || !plan.clusterConnection)
			throw new Error(
				"An approved explicit Kubernetes connection and bare pod plan are required",
			);
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
	get logs() {
		return this.failure
			? `${this.failure}\n`
			: "Kubernetes pod logs are not exported by this adapter: name-based log reads do not provide UID preconditions.\n";
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
	private get target() {
		if (!this.plan.kubernetes) throw new Error("Kubernetes target missing");
		return this.plan.kubernetes;
	}
	private get commands() {
		if (!this.client) throw new Error("Kubernetes client not initialized");
		return this.client.commands;
	}
	private path(name?: string) {
		const base = `/api/v1/namespaces/${this.target.namespace}/pods`;
		return name ? `${base}/${name}` : base;
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
				health: pod ? (pod.ready ? "healthy" : "starting") : null,
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
				}
			}
		} catch {
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
