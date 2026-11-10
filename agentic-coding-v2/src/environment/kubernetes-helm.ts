import fs from "node:fs";
import path from "node:path";
import { type Config, digest, object } from "../config.ts";
import { openClusterClient } from "./cluster.ts";
import { freezeHelmChart, type HelmChartCapture } from "./helm-chart.ts";
import type { HelmTarget } from "./kubernetes-config.ts";
import type { Plan } from "./model.ts";
import type { EnvironmentProcess, Exit, RuntimeStatus } from "./process.ts";

type Release = {
	name: string;
	namespace: string;
	version: number;
	status: string;
	runLabel: string | undefined;
};
const RUN_LABEL = "acv2run";
/** Kinds a namespaced release must never carry: they outlive or escape the
 * release namespace. Unknown custom kinds stay namespaced release effects. */
const CLUSTER_SCOPED = new Set([
	"Namespace",
	"Node",
	"PersistentVolume",
	"StorageClass",
	"PriorityClass",
	"RuntimeClass",
	"IngressClass",
	"GatewayClass",
	"ClusterRole",
	"ClusterRoleBinding",
	"CustomResourceDefinition",
	"APIService",
	"MutatingWebhookConfiguration",
	"ValidatingWebhookConfiguration",
	"ValidatingAdmissionPolicy",
	"ValidatingAdmissionPolicyBinding",
	"CSIDriver",
	"CSINode",
	"VolumeSnapshotClass",
	"ClusterIssuer",
	"ClusterSecretStore",
	"ClusterExternalSecret",
	"ClusterTriggerAuthentication",
]);
/** Rendered release manifest → the Deployments v1 waited for. Every object must
 * stay in the release namespace (unset or equal) and be namespaced. */
export function releaseDeployments(manifest: string, namespace: string) {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(manifest);
	} catch {
		throw new Error("Rendered Helm manifest is not valid YAML");
	}
	const documents = (Array.isArray(parsed) ? parsed : [parsed]).filter(
		(document) => document !== null && document !== undefined,
	);
	if (!documents.length || documents.length > 256)
		throw new Error("Rendered Helm manifest needs 1 to 256 objects");
	const deployments = new Set<string>();
	for (const raw of documents) {
		const document = object(raw),
			metadata = object(document.metadata);
		if (
			typeof document.kind !== "string" ||
			typeof document.apiVersion !== "string" ||
			typeof metadata.name !== "string"
		)
			throw new Error("Rendered Helm object lacks kind/apiVersion/name");
		if (CLUSTER_SCOPED.has(document.kind) || document.kind.endsWith("List"))
			throw new Error(
				"Rendered Helm manifest contains a cluster-scoped or list object",
			);
		if (
			metadata.namespace !== undefined &&
			metadata.namespace !== null &&
			metadata.namespace !== "" &&
			metadata.namespace !== namespace
		)
			throw new Error(
				"Rendered Helm object targets another namespace than the release",
			);
		if (document.kind === "Deployment" && document.apiVersion === "apps/v1")
			deployments.add(metadata.name);
	}
	if (!deployments.size)
		throw new Error(
			"Rendered Helm release has no apps/v1 Deployment to wait for",
		);
	return [...deployments].sort();
}

/** One fresh `helm install` of an approved frozen chart. The original install
 * response (release name, namespace, revision 1 and this run's release label)
 * is the only cleanup capability; an existing release, a later revision, a
 * copied label or saved state never confers authority. No upgrade, rollback,
 * hook, CRD, namespace creation or ownership takeover is ever requested. */
export class KubernetesHelmProcess implements EnvironmentProcess {
	readonly pid = null;
	readonly authorization = () => undefined;
	readonly queryCredentials = () => undefined;
	readonly redact = (value: string) => value;
	readonly done: Promise<Exit>;
	private complete: ((exit: Exit) => void) | undefined;
	private result: Exit | null = null;
	private starting: Promise<void> | null = null;
	private monitoring: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private controller = new AbortController();
	private client: ReturnType<typeof openClusterClient> | null = null;
	private scratch: string | null = null;
	private attempted = false;
	private receipt: Release | null = null;
	private released = false;
	private uncertain = false;
	private failure = "";
	private runLabel: string;
	private deployments: string[] = [];
	private status: RuntimeStatus;
	constructor(
		private config: Config,
		private plan: Plan,
		run: string,
	) {
		if (
			plan.kubernetes?.workload !== "helm-release-v1" ||
			!plan.clusterConnection ||
			!plan.helmChart
		)
			throw new Error(
				"An approved explicit cluster connection and frozen Helm chart are required",
			);
		this.runLabel = digest(JSON.stringify([config.stateDir, run])).slice(0, 32);
		this.status = {
			runtime: "kubernetes",
			kind: "helm-release",
			name: `${this.target.namespace}/${this.target.helm.release}`,
			id: null,
			state: "unknown",
			health: null,
			readiness: "helm-deployments-available",
			owned: null,
			observedAt: Date.now(),
		};
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	private get target(): HelmTarget {
		const target = this.plan.kubernetes;
		if (target?.workload !== "helm-release-v1")
			throw new Error("Explicit Helm release target missing");
		return target;
	}
	private get chart(): HelmChartCapture {
		if (!this.plan.helmChart) throw new Error("Frozen Helm chart missing");
		return this.plan.helmChart;
	}
	private get kubectl() {
		if (!this.client) throw new Error("Cluster client not initialized");
		return this.client.commands;
	}
	private get helm() {
		if (!this.client) throw new Error("Helm client not initialized");
		return this.client.helm;
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
			(this.attempted && !this.released) ||
			this.client?.helm.cleanupFailed === true ||
			this.client?.helm.uncertainEffect === true
		);
	}
	get runtimeStatuses() {
		return [{ ...this.status }];
	}
	get logs() {
		return this.failure
			? `${this.failure}\n`
			: "Native Helm release status only: chart workload logs, forwards, HTTP and SQL require separately verified child capabilities; no selector-based access is inferred.\n";
	}
	private finish(code: number) {
		if (this.result) return;
		this.result = { code, signal: null };
		this.complete?.(this.result);
	}
	/** Strict parse of the install response (`version`, `info.status`) or of
	 * `helm get metadata` (`revision`, `status`, `labels`) for exactly this
	 * release. Only metadata carries release labels; an install response never
	 * proves label ownership by itself. */
	private parse(raw: string, form: "install" | "metadata"): Release {
		const data = object(JSON.parse(raw)),
			version = form === "install" ? data.version : data.revision,
			status = form === "install" ? object(data.info).status : data.status,
			labels = form === "metadata" ? object(data.labels ?? {}) : {};
		if (
			data.name !== this.target.helm.release ||
			data.namespace !== this.target.namespace ||
			!Number.isSafeInteger(version) ||
			Number(version) < 1 ||
			typeof status !== "string"
		)
			throw new Error("Invalid private Helm release identity");
		return {
			name: String(data.name),
			namespace: String(data.namespace),
			version: Number(version),
			status,
			runLabel:
				typeof labels[RUN_LABEL] === "string"
					? String(labels[RUN_LABEL])
					: undefined,
		};
	}
	private scope() {
		return ["--namespace", this.target.namespace];
	}
	/** Fresh status of the named release, or null when Helm affirms absence. */
	private async observe(timeoutMs: number, signal?: AbortSignal) {
		const result = await this.helm.run(
			[
				"get",
				"metadata",
				this.target.helm.release,
				...this.scope(),
				"-o",
				"json",
			],
			{ timeoutMs, signal, machine: true },
		);
		if (result.exit.signal)
			throw new Error(
				"Helm metadata read was interrupted; absence is not confirmed",
			);
		if (result.exit.code !== 0) {
			// Absence must be affirmed by a separate bounded list, never inferred
			// from an arbitrary status failure.
			const listed = await this.helm.checked(
				[
					"list",
					...this.scope(),
					"--all",
					"--filter",
					`^${this.target.helm.release}$`,
					"-o",
					"json",
				],
				{ timeoutMs, signal, machine: true },
			);
			const items = JSON.parse(listed);
			if (!Array.isArray(items) || items.length)
				throw new Error("Helm release presence is ambiguous");
			return null;
		}
		return this.parse(result.stdout, "metadata");
	}
	private owns(release: Release) {
		return (
			this.receipt !== null &&
			release.version === this.receipt.version &&
			release.runLabel === this.runLabel
		);
	}
	private async start() {
		const connection = this.plan.clusterConnection;
		if (!connection) throw new Error("Explicit cluster connection missing");
		this.controller.signal.throwIfAborted();
		const deadline = Date.now() + this.plan.timeoutMs,
			remaining = () => {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("Native Helm startup timed out");
				return left;
			};
		this.client = openClusterClient(this.config, connection);
		fs.mkdirSync(this.config.stateDir, { recursive: true });
		this.scratch = fs.mkdtempSync(
			path.join(this.config.stateDir, "helm-chart-"),
		);
		fs.chmodSync(this.scratch, 0o700);
		const chart = freezeHelmChart(this.chart, this.scratch);
		if (await this.observe(remaining(), this.controller.signal))
			throw new Error(
				"Helm release name is occupied; no existing release was adopted or upgraded",
			);
		const spec = this.target.helm,
			sets = Object.entries(spec.setString).flatMap(([key, value]) => [
				"--set-string",
				`${key}=${value}`,
			]);
		if (spec.replicas !== undefined) {
			if (!spec.replicasValuePath)
				throw new Error("Helm replicas require an explicit value path");
			sets.push("--set", `${spec.replicasValuePath}=${spec.replicas}`);
		}
		const inputs = [
			...this.scope(),
			...spec.values.flatMap((file) => ["--values", path.join(chart, file)]),
			...sets,
		];
		// Offline render of the exact frozen inputs before any cluster effect:
		// cross-namespace and cluster-scoped objects refuse here.
		const rendered = await this.helm.checked(
			["template", spec.release, chart, ...inputs, "--skip-crds"],
			{ timeoutMs: remaining(), signal: this.controller.signal, machine: true },
		);
		const planned = releaseDeployments(rendered, this.target.namespace);
		this.attempted = true;
		// Like v1, Helm itself does not wait; readiness is the release's own
		// Deployments becoming Available (below).
		const raw = await this.helm.checked(
			[
				"install",
				spec.release,
				chart,
				...inputs,
				"--labels",
				`${RUN_LABEL}=${this.runLabel}`,
				"--skip-crds",
				"--no-hooks",
				"-o",
				"json",
			],
			{
				timeoutMs: remaining(),
				signal: this.controller.signal,
				machine: true,
				effect: true,
			},
		);
		let created: Release;
		try {
			created = this.parse(raw, "install");
		} catch {
			this.uncertain = true;
			throw new Error(
				"Helm install response is invalid; refusing name-based adoption",
			);
		}
		if (created.version !== 1 || created.status !== "deployed") {
			this.uncertain = true;
			throw new Error("Helm install did not report a fresh deployed revision");
		}
		this.receipt = { ...created, runLabel: this.runLabel };
		const observed = await this.observe(remaining(), this.controller.signal);
		if (!observed || !this.owns(observed) || observed.status !== "deployed") {
			this.uncertain = true;
			throw new Error(
				"Fresh Helm release observation differs from its original install receipt",
			);
		}
		// The installed manifest of the owned release is the wait set; it must
		// agree with the offline render.
		const installed = releaseDeployments(
			await this.helm.checked(
				["get", "manifest", spec.release, ...this.scope()],
				{
					timeoutMs: remaining(),
					signal: this.controller.signal,
					machine: true,
				},
			),
			this.target.namespace,
		);
		if (JSON.stringify(installed) !== JSON.stringify(planned)) {
			this.failure =
				"Installed Helm manifest differs from the reviewed offline render";
			throw new Error(this.failure);
		}
		this.deployments = installed;
		this.status = {
			...this.status,
			id: `${observed.namespace}/${observed.name}@${observed.version}`,
			state: "unknown",
			health: "starting",
			owned: true,
			observedAt: Date.now(),
		};
		while (!(await this.available(remaining()))) {
			await Bun.sleep(Math.min(1000, remaining()));
			this.controller.signal.throwIfAborted();
		}
		this.status = {
			...this.status,
			state: "running",
			health: "healthy",
			owned: true,
			observedAt: Date.now(),
		};
		this.monitoring = this.monitor();
	}
	/** v1's readiness (`condition=available` for the release's Deployments),
	 * restricted to the Deployments the owned release manifest names and that
	 * carry this release's Helm ownership annotations. */
	private async available(timeoutMs: number) {
		const result = await this.kubectl.run(
			[
				"get",
				"deployment",
				...this.deployments,
				"--namespace",
				this.target.namespace,
				"-o",
				"json",
			],
			{
				timeoutMs: Math.min(timeoutMs, 10000),
				signal: this.controller.signal,
				machine: true,
			},
		);
		if (result.exit.code !== 0 || result.exit.signal) return false;
		const data = object(JSON.parse(result.stdout)),
			items = Array.isArray(data.items)
				? data.items.map(object)
				: [object(data)];
		if (items.length !== this.deployments.length) return false;
		return items.every((item) => {
			const metadata = object(item.metadata),
				annotations = object(metadata.annotations ?? {}),
				status = object(item.status ?? {}),
				conditions = Array.isArray(status.conditions)
					? status.conditions.map(object)
					: [];
			if (
				!this.deployments.includes(String(metadata.name)) ||
				metadata.namespace !== this.target.namespace ||
				annotations["meta.helm.sh/release-name"] !== this.target.helm.release ||
				annotations["meta.helm.sh/release-namespace"] !== this.target.namespace
			)
				throw new Error("Deployment is not owned by this Helm release");
			return (
				Number.isSafeInteger(metadata.generation) &&
				Number(status.observedGeneration) >= Number(metadata.generation) &&
				conditions.some(
					(condition) =>
						condition.type === "Available" && condition.status === "True",
				)
			);
		});
	}
	private async monitor() {
		while (!this.controller.signal.aborted && !this.result) {
			await Bun.sleep(1000);
			if (this.controller.signal.aborted) return;
			try {
				const current = await this.observe(10000, this.controller.signal);
				if (!current || !this.owns(current) || current.status !== "deployed")
					throw new Error();
				this.status = { ...this.status, observedAt: Date.now() };
			} catch {
				if (this.controller.signal.aborted) return;
				this.failure =
					"Native Helm release revision, label or deployed status changed; no upgrade, rollback or adoption was attempted";
				this.status = {
					...this.status,
					state: "unknown",
					health: null,
					owned: null,
					observedAt: Date.now(),
				};
				void this.stop();
				return;
			}
		}
	}
	async ready(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (this.stopping || this.result)
			throw new Error("Native Helm release is closing");
		const abort = () => this.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			this.starting ??= this.start();
			await this.starting;
			signal?.throwIfAborted();
		} catch {
			this.failure ||=
				"Native Helm install failed; original-receipt cleanup only, no existing release adoption";
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
			const abort = () => reject(new Error("Native Helm wait cancelled"));
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
	private async remove(timeoutMs: number) {
		if (!this.attempted) {
			this.released = true;
			return;
		}
		if (!this.receipt) {
			this.uncertain = true;
			throw new Error(
				"No original Helm install receipt; release retained for inspection",
			);
		}
		const deadline = Date.now() + timeoutMs,
			current = await this.observe(timeoutMs);
		if (!current || !this.owns(current)) {
			this.uncertain = true;
			throw new Error(
				"Original Helm release disappeared or changed before cleanup; no replacement was uninstalled",
			);
		}
		const seconds = Math.max(1, Math.floor((deadline - Date.now()) / 1000) - 2);
		await this.helm.checked(
			[
				"uninstall",
				this.target.helm.release,
				...this.scope(),
				"--cascade",
				"foreground",
				"--wait=watcher",
				"--timeout",
				`${seconds}s`,
				"--no-hooks",
			],
			{
				timeoutMs: Math.max(1, deadline - Date.now()),
				machine: true,
				effect: true,
			},
		);
		if (await this.observe(Math.max(1, deadline - Date.now()))) {
			this.uncertain = true;
			throw new Error("Helm release still present after uninstall");
		}
		this.released = true;
	}
	private async cleanup() {
		await this.starting?.catch(() => {});
		await this.monitoring?.catch(() => {});
		try {
			if (this.client) await this.remove(60000);
			else this.released = !this.attempted;
		} catch {
			this.uncertain = true;
			this.failure =
				"Native Helm cleanup could not confirm original release removal; retained for inspection, no name-based adoption";
		}
		if (this.scratch)
			try {
				fs.rmSync(this.scratch, { recursive: true, force: true });
				this.scratch = null;
			} catch {
				this.uncertain = true;
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
			}
		}
		this.finish(this.failure ? 1 : 0);
	}
}
