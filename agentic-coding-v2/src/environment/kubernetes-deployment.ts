import { isIP } from "node:net";
import { type Config, digest, object } from "../config.ts";
import { openClusterClient } from "./cluster.ts";
import {
	type CreatedResource,
	KubernetesResource,
} from "./kubernetes-resource.ts";
import type { Plan } from "./model.ts";
import type { EnvironmentProcess, Exit, RuntimeStatus } from "./process.ts";
import { processEnvironment } from "./shell.ts";
/** A separately declared native Deployment, not a chart flattened to pods. Only
 * original Deployment/Service create receipts confer authority. Controller pod
 * names, logs, forwards and persisted identifiers never confer a child lease. */
export class KubernetesDeploymentProcess implements EnvironmentProcess {
	readonly pid = null;
	readonly authorization: ReturnType<
		typeof processEnvironment
	>["authorization"];
	readonly queryCredentials: ReturnType<
		typeof processEnvironment
	>["queryCredentials"];
	readonly redact: ReturnType<typeof processEnvironment>["redact"];
	readonly done: Promise<Exit>;
	private complete: ((exit: Exit) => void) | undefined;
	private result: Exit | null = null;
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private controller = new AbortController();
	private client: ReturnType<typeof openClusterClient> | null = null;
	private resources: KubernetesResource[] = [];
	private deployment: KubernetesResource | null = null;
	private generation: number | null = null;
	private uncertain = false;
	private failure = "";
	private labels: Record<string, string>;
	private environment: ReturnType<typeof processEnvironment>["env"];
	private name: string;
	private status: RuntimeStatus;
	constructor(
		private config: Config,
		private plan: Plan,
		run: string,
	) {
		if (
			plan.kubernetes?.workload !== "deployment-v1" ||
			!plan.clusterConnection ||
			plan.kubernetes.portForwards?.length
		)
			throw new Error(
				"An approved explicit Deployment connection with no implicit pod forwards is required",
			);
		const frozen = processEnvironment(config.configDir, plan);
		this.environment = frozen.env;
		this.authorization = frozen.authorization;
		this.queryCredentials = frozen.queryCredentials;
		this.redact = frozen.redact;
		this.labels = {
			"dev.agentic-coding.v2.host": digest(config.stateDir).slice(0, 32),
			"dev.agentic-coding.v2.run": digest(run).slice(0, 32),
		};
		this.name = `acv2-${digest(JSON.stringify([config.stateDir, plan.app])).slice(0, 20)}`;
		this.status = {
			runtime: "kubernetes",
			kind: "deployment",
			name: `${this.target.namespace}/${this.name}`,
			id: null,
			state: "unknown",
			health: null,
			readiness: "deployment-available",
			owned: null,
			observedAt: Date.now(),
		};
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	private get target() {
		const target = this.plan.kubernetes;
		if (target?.workload !== "deployment-v1")
			throw new Error("Explicit Deployment target missing");
		return target;
	}
	get outcome() {
		return this.result;
	}
	get closing() {
		return this.stopping !== null;
	}
	get cleanupFailed() {
		return (
			this.uncertain ||
			this.resources.some((resource) => resource.cleanupFailed) ||
			this.client?.commands.cleanupFailed === true ||
			this.client?.commands.uncertainEffect === true
		);
	}
	get runtimeStatuses() {
		return [{ ...this.status }];
	}
	get logs() {
		return this.failure
			? `${this.failure}\n`
			: "Native Deployment status only: controller pod logs and forwards require separately verified child capabilities; no selector-based pod access is inferred.\n";
	}
	private finish(code: number) {
		if (this.result) return;
		this.result = { code, signal: null };
		this.complete?.(this.result);
	}
	private metadata(name: string) {
		return {
			name,
			namespace: this.target.namespace,
			labels: { ...this.labels },
		};
	}
	private manifest() {
		const env = this.environment;
		return {
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: this.metadata(this.name),
			spec: {
				replicas: this.target.replicas,
				revisionHistoryLimit: 0,
				progressDeadlineSeconds: 600,
				strategy: { type: "Recreate" },
				selector: { matchLabels: { ...this.labels } },
				template: {
					metadata: { labels: { ...this.labels } },
					spec: {
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
								...(this.target.readinessProbe
									? { readinessProbe: this.target.readinessProbe }
									: {}),
								env: [
									...Object.keys(this.plan.environment),
									...Object.keys(this.plan.secretRefs),
								].map((name) => ({
									name,
									value: env[name as keyof typeof env],
								})),
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
								},
							},
						],
					},
				},
			},
		};
	}
	private serviceObservation(resource: CreatedResource) {
		const spec = object(resource.data.spec),
			entry = this.target.services?.find(
				(entry) => entry.name === object(resource.data.metadata).name,
			),
			ports = spec.ports;
		if (
			!entry ||
			spec.type !== "ClusterIP" ||
			typeof spec.clusterIP !== "string" ||
			!isIP(spec.clusterIP) ||
			spec.externalName !== undefined ||
			(Array.isArray(spec.externalIPs)
				? spec.externalIPs.length
				: spec.externalIPs !== undefined) ||
			spec.loadBalancerIP !== undefined ||
			!Array.isArray(ports) ||
			ports.length !== 1
		)
			throw new Error(
				"Original Deployment Service differs from its approved internal-only scope",
			);
		const port = object(ports[0]),
			selector = object(spec.selector);
		if (
			port.port !== entry.port ||
			port.targetPort !== entry.targetPort ||
			port.protocol !== "TCP" ||
			port.nodePort !== undefined ||
			Object.keys(selector).length !== Object.keys(this.labels).length ||
			!Object.entries(this.labels).every(
				([key, value]) => selector[key] === value,
			)
		)
			throw new Error(
				"Original Deployment Service selector or port scope changed",
			);
	}
	private readyObservation(resource: CreatedResource) {
		const metadata = object(resource.data.metadata),
			spec = object(resource.data.spec),
			status = object(resource.data.status ?? {});
		if (
			!Number.isSafeInteger(metadata.generation) ||
			Number(metadata.generation) < 1 ||
			metadata.generation !== this.generation ||
			spec.replicas !== this.target.replicas
		)
			throw new Error(
				"Deployment generation or desired replicas differ from the approved controller",
			);
		const conditions = status.conditions ?? [];
		if (!Array.isArray(conditions) || conditions.length > 32)
			throw new Error("Invalid private Deployment status");
		if (
			conditions
				.map(object)
				.some(
					(condition) =>
						(condition.type === "Progressing" &&
							condition.status === "False") ||
						(condition.type === "ReplicaFailure" &&
							condition.status === "True"),
				)
		)
			throw new Error("Original Deployment reports a failed rollout");
		const count = (value: unknown) =>
			Number.isSafeInteger(value) && Number(value) >= this.target.replicas;
		return (
			Number.isSafeInteger(status.observedGeneration) &&
			Number(status.observedGeneration) >= Number(metadata.generation) &&
			count(status.updatedReplicas) &&
			count(status.readyReplicas) &&
			count(status.availableReplicas) &&
			conditions
				.map(object)
				.some(
					(condition) =>
						condition.type === "Available" && condition.status === "True",
				)
		);
	}
	private async observe(timeoutMs: number, signal?: AbortSignal) {
		if (!this.deployment)
			throw new Error("Original Deployment lease unavailable");
		try {
			const current = await this.deployment.observe(timeoutMs, signal);
			if (!current) throw new Error("Original Deployment is absent");
			const ready = this.readyObservation(current);
			this.status = {
				...this.status,
				id: current.uid,
				state: "running",
				health: ready ? "healthy" : "starting",
				owned: true,
				observedAt: Date.now(),
			};
			return ready;
		} catch {
			this.status = {
				...this.status,
				state: "unknown",
				health: null,
				owned: null,
				observedAt: Date.now(),
			};
			throw new Error(
				"Original Deployment observation failed; no replacement or absence authority inferred",
			);
		}
	}
	private async start() {
		const connection = this.plan.clusterConnection;
		if (!connection) throw new Error("Explicit cluster connection missing");
		this.controller.signal.throwIfAborted();
		this.client = openClusterClient(this.config, connection);
		const deadline = Date.now() + this.plan.timeoutMs,
			remaining = () => {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("Native Deployment startup timed out");
				return left;
			};
		for (const entry of this.target.services ?? []) {
			const resource = new KubernetesResource(
				this.client.commands,
				"Service",
				this.target.namespace,
				entry.name,
				this.labels,
			);
			this.resources.push(resource);
			const created = await resource.create(
				{
					apiVersion: "v1",
					kind: "Service",
					metadata: this.metadata(entry.name),
					spec: {
						type: "ClusterIP",
						selector: { ...this.labels },
						ports: [
							{
								port: entry.port,
								targetPort: entry.targetPort,
								protocol: "TCP",
							},
						],
					},
				},
				remaining(),
				this.controller.signal,
			);
			this.serviceObservation(created);
		}
		this.deployment = new KubernetesResource(
			this.client.commands,
			"Deployment",
			this.target.namespace,
			this.name,
			this.labels,
		);
		this.resources.push(this.deployment);
		const created = await this.deployment.create(
			this.manifest(),
			remaining(),
			this.controller.signal,
		);
		const generation = object(created.data.metadata).generation;
		if (!Number.isSafeInteger(generation) || Number(generation) < 1)
			throw new Error(
				"Native Deployment create receipt has no original generation",
			);
		this.generation = Number(generation);
		while (!(await this.observe(remaining(), this.controller.signal))) {
			this.controller.signal.throwIfAborted();
			await Bun.sleep(Math.min(100, remaining()));
		}
		this.monitoring = this.monitor();
	}
	private async monitor() {
		while (!this.controller.signal.aborted && !this.result) {
			await Bun.sleep(200);
			if (this.controller.signal.aborted) return;
			try {
				for (const resource of this.resources) {
					if (resource === this.deployment) continue;
					const observed = await resource.observe(
						10000,
						this.controller.signal,
					);
					if (!observed)
						throw new Error("Original Deployment Service disappeared");
					this.serviceObservation(observed);
				}
				if (!(await this.observe(10000, this.controller.signal)))
					throw new Error("Original Deployment lost availability");
			} catch {
				if (this.controller.signal.aborted) return;
				this.failure =
					"Native Deployment availability or original resource identity was lost; inspect original receipts, no controller pod access or adoption was attempted";
				void this.stop();
				return;
			}
		}
	}
	async ready(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (this.stopping || this.result)
			throw new Error("Native Deployment is closing");
		const abort = () => this.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			this.starting ??= this.start();
			await this.starting;
			signal?.throwIfAborted();
		} catch {
			this.failure =
				"Native Deployment startup failed; original-handle cleanup only, no existing resource adoption";
			await this.stop();
			throw new Error(this.failure);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	async wait(signal?: AbortSignal) {
		await this.ready(signal);
		if (!signal) return this.done;
		return new Promise<Exit>((resolve, reject) => {
			const abort = () => reject(new Error("Native Deployment wait cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			this.done.then((value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			});
			if (signal.aborted) abort();
		});
	}
	stop() {
		if (!this.stopping) {
			this.controller.abort();
			this.stopping = this.cleanup();
		}
		return this.stopping;
	}
	private async cleanup() {
		await this.starting?.catch(() => {});
		await this.monitoring?.catch(() => {});
		const deadline = Date.now() + 30000;
		for (const resource of [...this.resources].reverse())
			try {
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					throw new Error("Native Deployment cleanup deadline expired");
				await resource.remove(Math.min(15000, remaining));
			} catch {
				this.uncertain = true;
				this.failure =
					"Native Deployment cleanup could not confirm original resource removal; retained for inspection, no name-based adoption or selector delete";
			}
		if (!this.cleanupFailed) {
			this.status = {
				...this.status,
				state: "absent",
				health: null,
				owned: true,
				observedAt: Date.now(),
			};
			try {
				this.client?.close();
			} catch {
				this.uncertain = true;
				this.failure =
					"Native Deployment private client cleanup could not be confirmed; retained for inspection";
			}
		}
		this.finish(this.failure ? 1 : 0);
	}
}
