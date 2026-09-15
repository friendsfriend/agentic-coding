// Bun-owned Kubernetes/Helm runtime (`port-environment-runtimes-to-bun`, section 3).
//
// Ported from `server/pkg/kubernetes/{runtime,identity,cluster_service,
// cluster_status,image,secrets,status_logs}.go` and the Kubernetes parts of
// `server/pkg/build/kubernetes_lifecycle.go` and
// `server/pkg/operations/kubernetes_infra.go`.
//
// Go already drove Kubernetes through `kind`/`kubectl`/`helm` argv, so the port
// keeps argv as the adapter: every command is built by a pure function so a
// fixture can assert it, and only `KubernetesExec` spawns a process. Secrets
// never leave the process except through the redacted argv a caller logs.
//
// Deliberate differences from the Go implementation, all asserted by a test:
//
//   - **The runner is a value, not a global.** Go's `Runner` reads the selected
//     container runtime from package state; here the runtime is a field, so a
//     test can pin `podman` without mutating the process.
//   - **Namespace listing is stable-sorted.** Go iterated a map, so the
//     namespace list order changed between calls; Bun sorts by name.
//   - **Warnings never replace a failure.** An unreachable observation records a
//     warning and leaves the state as `unreachable`/`degraded`; it is never
//     reported as confirmed absence.
import { spawn } from "node:child_process";

export const DEFAULT_CLUSTER_NAME = "devenv";
export const DEFAULT_CONTEXT_NAME = "kind-devenv";

export interface Command {
	readonly name: string;
	readonly args: string[];
	readonly env?: string[];
}

export interface KubernetesIdentity {
	readonly provider: "docker" | "podman";
	readonly cluster: string;
	readonly context: string;
}

/** Resolves cluster identity the way `pkg/kubernetes/identity.go` does. */
export function resolveIdentity(
	provider: string,
	cluster: string,
	context: string,
): KubernetesIdentity {
	const resolvedProvider = provider === "podman" ? "podman" : "docker";
	const resolvedCluster = cluster === "" ? DEFAULT_CLUSTER_NAME : cluster;
	const resolvedContext = context === "" ? `kind-${resolvedCluster}` : context;
	return {
		provider: resolvedProvider,
		cluster: resolvedCluster,
		context: resolvedContext,
	};
}

export function identityEnv(identity: KubernetesIdentity): string[] {
	return identity.provider === "podman"
		? ["KIND_EXPERIMENTAL_PROVIDER=podman"]
		: [];
}

/** Safe archive path for `kind load image-archive`. */
export function identityArchive(actionId: string, tmpDir = "/tmp"): string {
	const safe = actionId.replace(/[/: ]/g, "-");
	return `${tmpDir}/devenv-image-${safe}.tar`;
}

// --- runner ---------------------------------------------------------------

export interface RunnerOptions {
	readonly kindCommand?: string;
	readonly kubectlCommand?: string;
	readonly helmCommand?: string;
	readonly clusterName?: string;
	readonly contextName?: string;
	readonly containerCommand?: string;
	readonly containerName?: string;
	/** Resolves a binary on PATH; injectable so preflight is testable. */
	readonly lookPath?: (name: string) => string | undefined;
}

/** Builds the argv Go's `Runner` built, with no ambient process state. */
export class Runner {
	readonly kindCommand: string;
	readonly kubectlCommand: string;
	readonly helmCommand: string;
	readonly clusterName: string;
	readonly contextName: string;
	readonly containerCommand: string;
	readonly containerName: string;
	private readonly lookPath: (name: string) => string | undefined;

	constructor(options: RunnerOptions = {}) {
		this.kindCommand = options.kindCommand ?? "kind";
		this.kubectlCommand = options.kubectlCommand ?? "kubectl";
		this.helmCommand = options.helmCommand ?? "helm";
		this.clusterName = options.clusterName ?? DEFAULT_CLUSTER_NAME;
		this.contextName = options.contextName ?? DEFAULT_CONTEXT_NAME;
		this.containerCommand = options.containerCommand ?? "docker";
		this.containerName = options.containerName ?? "docker";
		this.lookPath =
			options.lookPath ?? ((name) => Bun.which(name) ?? undefined);
	}

	/** Fails when a required tool is missing, so an action fails loudly rather
	 * than reporting success for a cluster that was never created. */
	preflight(): void {
		for (const tool of [
			this.kindCommand,
			this.kubectlCommand,
			this.helmCommand,
		]) {
			if (this.lookPath(tool) === undefined) {
				throw new Error(
					`missing required Kubernetes tool ${JSON.stringify(tool)}`,
				);
			}
		}
		if (this.containerCommand === "") {
			throw new Error("missing container runtime command");
		}
		if (this.lookPath(this.containerCommand) === undefined) {
			throw new Error(
				`missing container runtime ${JSON.stringify(this.containerCommand)}`,
			);
		}
	}

	kindEnv(): string[] {
		return this.containerName === "podman"
			? ["KIND_EXPERIMENTAL_PROVIDER=podman"]
			: [];
	}

	kindGetClusters(): Command {
		return {
			name: this.kindCommand,
			args: ["get", "clusters"],
			env: this.kindEnv(),
		};
	}

	kindCreateCluster(): Command {
		return {
			name: this.kindCommand,
			args: ["create", "cluster", "--name", this.clusterName],
			env: this.kindEnv(),
		};
	}

	kindDeleteCluster(): Command {
		return {
			name: this.kindCommand,
			args: ["delete", "cluster", "--name", this.clusterName],
			env: this.kindEnv(),
		};
	}

	kindLoadImage(image: string): Command {
		return {
			name: this.kindCommand,
			args: ["load", "docker-image", image, "--name", this.clusterName],
			env: this.kindEnv(),
		};
	}

	kindLoadImageArchive(path: string): Command {
		return {
			name: this.kindCommand,
			args: ["load", "image-archive", path, "--name", this.clusterName],
			env: this.kindEnv(),
		};
	}

	kindExportKubeconfig(): Command {
		return {
			name: this.kindCommand,
			args: ["export", "kubeconfig", "--name", this.clusterName],
			env: this.kindEnv(),
		};
	}

	kubectl(...args: string[]): Command {
		return {
			name: this.kubectlCommand,
			args: ["--context", this.contextName, ...args],
		};
	}

	helm(...args: string[]): Command {
		return {
			name: this.helmCommand,
			args: ["--kube-context", this.contextName, ...args],
		};
	}
}

// --- execution boundary ---------------------------------------------------

export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
}

/** Runs one argv. Injectable so every cluster test runs without a cluster. */
export type KubernetesExec = (
	command: Command,
	signal?: AbortSignal,
) => Promise<CommandResult>;

export function spawnKubernetesExec(): KubernetesExec {
	return (command, signal) =>
		new Promise((resolve) => {
			const child = spawn(command.name, command.args, {
				env: { ...process.env, ...envPairs(command.env) },
				stdio: ["ignore", "pipe", "pipe"],
				signal,
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => resolve({ stdout, stderr, error }));
			child.on("close", (code) => {
				if (code === 0) return resolve({ stdout, stderr });
				resolve({
					stdout,
					stderr,
					error: new Error(
						`${command.name} ${command.args.join(" ")}: exit ${code}`,
					),
				});
			});
		});
}

function envPairs(env: readonly string[] | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of env ?? []) {
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		result[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return result;
}

export interface CommandObservation {
	readonly command: Command;
	readonly output: string;
	readonly stderr: string;
	readonly error?: Error;
}

// --- cluster service ------------------------------------------------------

export interface ClusterServiceOptions {
	readonly runner: Runner;
	readonly exec: KubernetesExec;
	readonly now?: () => number;
	/** Receives every command the service runs, for logs and fixtures. */
	readonly observe?: (observation: CommandObservation) => void;
}

export class KubernetesClusterService {
	readonly runner: Runner;
	private readonly exec: KubernetesExec;
	private readonly now: () => number;
	private readonly observe?: (observation: CommandObservation) => void;
	/** Last collected status; the poller publishes it and a refresh re-reads. */
	private lastStatus?: ClusterStatus;

	constructor(options: ClusterServiceOptions) {
		this.runner = options.runner;
		this.exec = options.exec;
		this.now = options.now ?? Date.now;
		this.observe = options.observe;
	}

	/** Runs one command, recording it. Throws Go's wrapped error message. */
	private async run(
		command: Command,
		signal?: AbortSignal,
	): Promise<{ stdout: string; stderr: string }> {
		const result = await this.exec(command, signal);
		this.observe?.({
			command,
			output: result.stdout,
			stderr: result.stderr,
			...(result.error ? { error: result.error } : {}),
		});
		if (result.error) {
			throw new Error(
				`${command.name} ${command.args.join(" ")}: ${result.error.message}: ${result.stderr.trim()}`,
			);
		}
		return { stdout: result.stdout, stderr: result.stderr };
	}

	/** Creates the cluster when it is missing, then exports its kubeconfig. */
	async create(signal?: AbortSignal): Promise<void> {
		this.runner.preflight();
		const clusters = await this.run(this.runner.kindGetClusters(), signal);
		if (!clusterListContains(clusters.stdout, this.runner.clusterName)) {
			await this.run(this.runner.kindCreateCluster(), signal);
		}
		await this.exportKubeconfig(signal);
	}

	async delete(signal?: AbortSignal): Promise<void> {
		this.runner.preflight();
		await this.run(this.runner.kindDeleteCluster(), signal);
	}

	async recreate(signal?: AbortSignal): Promise<void> {
		await this.delete(signal);
		await this.create(signal);
	}

	async exportKubeconfig(signal?: AbortSignal): Promise<void> {
		this.runner.preflight();
		await this.run(this.runner.kindExportKubeconfig(), signal);
	}

	/**
	 * Collects cluster status. An unavailable observation is a warning, never
	 * confirmed absence: a runtime failure leaves the state unreachable and the
	 * cluster is not recreated on the strength of it.
	 */
	async status(signal?: AbortSignal): Promise<ClusterStatus> {
		const runner = this.runner;
		const status: ClusterStatus = {
			clusterName: runner.clusterName,
			contextName: runner.contextName,
			provider: runner.containerName || runner.containerCommand,
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
			podList: [],
			releases: [],
			collectedAt: new Date(this.now()).toISOString(),
		};
		const exec: KubernetesExec = this.exec;
		let clusters: { stdout: string };
		try {
			clusters = await this.run(runner.kindGetClusters(), signal);
		} catch (error) {
			const fallback = await this.kindExistsFromRuntimeFallback(
				runner,
				exec,
				error as Error,
				signal,
			);
			if (!fallback.ok) {
				status.warnings = [message(error)];
				return status;
			}
			status.exists = fallback.exists;
			clusters = { stdout: "" };
		}
		if (clusters.stdout !== "") {
			status.exists = clusterListContains(clusters.stdout, runner.clusterName);
		}
		if (!status.exists) return status;

		status.state = "unreachable";
		try {
			const version = await this.run(
				runner.kubectl("version", "-o", "json"),
				signal,
			);
			status.reachable = true;
			status.state = "running";
			status.kubernetesVersion = parseKubernetesVersion(version.stdout);
		} catch (error) {
			status.warnings = [message(error)];
		}
		if (!status.reachable) return status;

		try {
			const nodes = await this.run(
				runner.kubectl("get", "nodes", "-o", "json"),
				signal,
			);
			status.nodes = parseNodes(nodes.stdout);
		} catch (error) {
			status.warnings = [...(status.warnings ?? []), message(error)];
			status.state = "degraded";
		}
		try {
			const pods = await this.run(
				runner.kubectl("get", "pods", "--all-namespaces", "-o", "json"),
				signal,
			);
			const parsed = parsePods(pods.stdout);
			status.pods = parsed.summary;
			status.namespaces = parsed.namespaces;
			status.podList = parsed.pods;
		} catch (error) {
			status.warnings = [...(status.warnings ?? []), message(error)];
			status.state = "degraded";
		}
		try {
			const releases = await this.run(
				runner.helm("list", "--all-namespaces", "-o", "json"),
				signal,
			);
			status.releases = parseReleases(releases.stdout);
		} catch (error) {
			status.warnings = [...(status.warnings ?? []), message(error)];
		}

		const stats = await this.collectKindNodeStats(runner, exec, signal);
		if (stats.stats) {
			status.stats = stats.stats;
		} else {
			status.warnings = [...(status.warnings ?? []), ...stats.warnings];
			if (status.state === "running" && stats.warnings.length > 0) {
				status.state = "degraded";
			}
		}
		this.lastStatus = status;
		return status;
	}

	/** The most recent collected status, without running any command. */
	peek(): ClusterStatus | undefined {
		return this.lastStatus;
	}

	/**
	 * Recovers cluster existence from the container runtime when `kind get
	 * clusters` fails with the known `KIND_EXPERIMENTAL_PROVIDER` Podman bug,
	 * instead of reporting the cluster missing and recreating it.
	 */
	private async kindExistsFromRuntimeFallback(
		runner: Runner,
		exec: KubernetesExec,
		kindError: Error,
		signal?: AbortSignal,
	): Promise<{ ok: boolean; exists: boolean }> {
		if (!isKindPodmanListBug(kindError)) return { ok: false, exists: false };
		const provider = runner.containerCommand || runner.containerName;
		if (provider === "") return { ok: false, exists: false };
		const result = await exec(
			{ name: provider, args: ["ps", "-a", "--format", "{{.Names}}"] },
			signal,
		);
		this.observe?.({
			command: { name: provider, args: ["ps", "-a", "--format", "{{.Names}}"] },
			output: result.stdout,
			stderr: result.stderr,
			...(result.error ? { error: result.error } : {}),
		});
		if (result.error) return { ok: false, exists: false };
		for (const name of fields(result.stdout)) {
			if (
				name === `${runner.clusterName}-control-plane` ||
				name.startsWith(`${runner.clusterName}-`)
			) {
				return { ok: true, exists: true };
			}
		}
		return { ok: true, exists: false };
	}

	private async collectKindNodeStats(
		runner: Runner,
		exec: KubernetesExec,
		signal?: AbortSignal,
	): Promise<{ stats?: ClusterResourceStats; warnings: string[] }> {
		const provider = runner.containerCommand || runner.containerName;
		if (provider === "") {
			return { warnings: ["container runtime unavailable for stats"] };
		}
		const ps = await exec(
			{ name: provider, args: ["ps", "--format", "{{.Names}}"] },
			signal,
		);
		if (ps.error) return { warnings: [ps.error.message] };
		const names = fields(ps.stdout).filter(
			(name) =>
				name.startsWith(`${runner.clusterName}-`) || name.startsWith("devenv-"),
		);
		if (names.length === 0)
			return { warnings: ["kind node containers not found"] };
		const stats: ClusterResourceStats = {
			cpuPercent: 0,
			memoryUsageBytes: 0,
			memoryLimitBytes: 0,
			memoryPercent: 0,
			nodes: [],
			collectedAt: new Date(this.now()).toISOString(),
		};
		for (const name of names) {
			const node = await tryCollectNodeStats(exec, provider, name, signal);
			if (!node) continue;
			stats.cpuPercent += node.cpuPercent;
			stats.memoryUsageBytes += node.memoryUsageBytes;
			stats.memoryLimitBytes += node.memoryLimitBytes;
			stats.nodes.push(node);
		}
		if (stats.nodes.length === 0) {
			return { warnings: ["unable to collect stats from any node container"] };
		}
		if (stats.memoryLimitBytes > 0) {
			stats.memoryPercent =
				(stats.memoryUsageBytes / stats.memoryLimitBytes) * 100;
		}
		return { stats, warnings: [] };
	}
}

// --- status model ---------------------------------------------------------

export type ClusterState = "missing" | "running" | "degraded" | "unreachable";

export interface ClusterStatus {
	clusterName: string;
	contextName: string;
	provider: string;
	exists: boolean;
	reachable: boolean;
	state: ClusterState;
	kubernetesVersion?: string;
	nodes: ClusterNodeSummary[];
	namespaces: NamespaceSummary[];
	pods: PodSummary;
	podList: PodListItem[];
	releases: DevEnvReleaseSummary[];
	stats?: ClusterResourceStats;
	warnings?: string[];
	collectedAt: string;
}

export interface ClusterNodeSummary {
	name: string;
	ready: boolean;
	role?: string;
	kubeletVersion?: string;
}

export interface NamespaceSummary {
	name: string;
	pods: number;
}

export interface PodSummary {
	total: number;
	running: number;
	pending: number;
	succeeded: number;
	failed: number;
	unknown: number;
}

export interface PodListItem {
	name: string;
	namespace: string;
	status: string;
}

export interface DevEnvReleaseSummary {
	name: string;
	namespace: string;
	status: string;
	chart?: string;
	revision?: string;
}

export interface ClusterResourceStats {
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
	nodes: NodeResourceStats[];
	collectedAt: string;
}

export interface NodeResourceStats {
	name: string;
	containerName: string;
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
}

// --- parsers --------------------------------------------------------------

export function clusterListContains(output: string, name: string): boolean {
	return fields(output).includes(name);
}

export function isKindPodmanListBug(error: Error): boolean {
	const text = error.message;
	return (
		text.includes("KIND_EXPERIMENTAL_PROVIDER") &&
		text.includes("failed to list clusters") &&
		text.includes("cannot index slice/array with type string")
	);
}

export function parseKubernetesVersion(output: string): string {
	const parsed = parseJson(output) as {
		serverVersion?: { gitVersion?: string };
	};
	return parsed?.serverVersion?.gitVersion ?? "";
}

export function parseNodes(output: string): ClusterNodeSummary[] {
	const parsed = parseJson(output) as {
		items?: {
			metadata?: { name?: string };
			status?: {
				nodeInfo?: { kubeletVersion?: string };
				conditions?: { type?: string; status?: string }[];
			};
		}[];
	};
	return (parsed?.items ?? []).map((item) => {
		const ready = (item.status?.conditions ?? []).some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		);
		return {
			name: item.metadata?.name ?? "",
			ready,
			kubeletVersion: item.status?.nodeInfo?.kubeletVersion ?? "",
		};
	});
}

export function parsePods(output: string): {
	summary: PodSummary;
	namespaces: NamespaceSummary[];
	pods: PodListItem[];
} {
	const parsed = parseJson(output) as {
		items?: {
			metadata?: { name?: string; namespace?: string };
			status?: { phase?: string };
		}[];
	};
	const summary: PodSummary = {
		total: 0,
		running: 0,
		pending: 0,
		succeeded: 0,
		failed: 0,
		unknown: 0,
	};
	const byNamespace = new Map<string, number>();
	const pods: PodListItem[] = [];
	for (const item of parsed?.items ?? []) {
		summary.total++;
		const namespace = item.metadata?.namespace ?? "";
		byNamespace.set(namespace, (byNamespace.get(namespace) ?? 0) + 1);
		let status = item.status?.phase ?? "";
		switch (status) {
			case "Running":
				summary.running++;
				break;
			case "Pending":
				summary.pending++;
				break;
			case "Succeeded":
				summary.succeeded++;
				break;
			case "Failed":
				summary.failed++;
				break;
			default:
				summary.unknown++;
				if (status === "") status = "Unknown";
				break;
		}
		pods.push({
			name: item.metadata?.name ?? "",
			namespace,
			status,
		});
	}
	// Go iterated a map; the port sorts so a status read is reproducible.
	const namespaces = [...byNamespace.entries()]
		.map(([name, count]) => ({ name, pods: count }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { summary, namespaces, pods };
}

export function parseReleases(output: string): DevEnvReleaseSummary[] {
	const parsed = parseJson(output) as {
		name?: string;
		namespace?: string;
		status?: string;
		chart?: string;
		revision?: string;
	}[];
	return (parsed ?? []).map((item) => ({
		name: item.name ?? "",
		namespace: item.namespace ?? "",
		status: item.status ?? "",
		chart: item.chart ?? "",
		revision: item.revision ?? "",
	}));
}

/** Node stats from the container runtime's `stats` output (JSON, then tab). */
export async function tryCollectNodeStats(
	exec: KubernetesExec,
	provider: string,
	name: string,
	signal?: AbortSignal,
): Promise<NodeResourceStats | undefined> {
	const json = await exec(
		{
			name: provider,
			args: ["stats", "--no-stream", "--format", "{{json .}}", name],
		},
		signal,
	);
	if (!json.error) {
		const node = parseRuntimeStatsJson(name, json.stdout);
		if (node) return node;
	}
	const tab = await exec(
		{
			name: provider,
			args: [
				"stats",
				"--no-stream",
				"--format",
				"{{.CPU}}\t{{.MemUsage}}\t{{.MemPerc}}",
				name,
			],
		},
		signal,
	);
	if (!tab.error) {
		const node = parseRuntimeStatsTab(name, tab.stdout);
		if (node) return node;
	}
	return undefined;
}

export function parseRuntimeStatsJson(
	name: string,
	output: string,
): NodeResourceStats | undefined {
	const raw = parseJson(output.trim()) as Record<string, unknown> | undefined;
	if (!raw || Object.keys(raw).length === 0) return undefined;
	const cpu = parsePercent(
		pick(raw, ["CPUPerc", "CPU", "cpu", "Cpu", "CpuPerc"]),
	);
	const memUsage = raw.MemUsage;
	const memLimit = raw.MemLimit;
	if (typeof memUsage === "number" && typeof memLimit === "number") {
		return {
			name: name.replace(/^devenv-/, ""),
			containerName: name,
			cpuPercent: cpu,
			memoryUsageBytes: memUsage,
			memoryLimitBytes: memLimit,
			memoryPercent: parsePercent(
				pick(raw, ["MemPerc", "mem_perc", "Memperc", "memperc"]),
			),
		};
	}
	const memUsageText = pick(raw, [
		"MemUsage",
		"mem_usage",
		"Mem",
		"Memusage",
		"memusage",
		"Memory",
		"memory",
	]);
	if (memUsageText === "") return undefined;
	const [usage, limit] = parseMemoryPair(memUsageText);
	return {
		name: name.replace(/^devenv-/, ""),
		containerName: name,
		cpuPercent: cpu,
		memoryUsageBytes: usage,
		memoryLimitBytes: limit,
		memoryPercent: parsePercent(
			pick(raw, ["MemPerc", "mem_perc", "Memperc", "memperc", "Mem", "memory"]),
		),
	};
}

export function parseRuntimeStatsTab(
	name: string,
	output: string,
): NodeResourceStats | undefined {
	const line = output.trim().replace(/\t/g, "|");
	const parts = line.split("|");
	if (parts.length < 3) return undefined;
	const [usage, limit] = parseMemoryPair(parts[1].trim());
	return {
		name: name.replace(/^devenv-/, ""),
		containerName: name,
		cpuPercent: parsePercent(parts[0].trim()),
		memoryUsageBytes: usage,
		memoryLimitBytes: limit,
		memoryPercent: parsePercent(parts[2].trim()),
	};
}

export function parsePercent(text: string): number {
	const value = Number.parseFloat(text.trim().replace(/%$/, ""));
	return Number.isFinite(value) ? value : 0;
}

export function parseMemoryPair(text: string): [number, number] {
	const parts = text.split("/");
	if (parts.length !== 2) return [0, 0];
	return [parseBytes(parts[0]), parseBytes(parts[1])];
}

export function parseBytes(text: string): number {
	const trimmed = text.trim();
	const units: [string, number][] = [
		["GiB", 1024 ** 3],
		["MiB", 1024 ** 2],
		["KiB", 1024],
		["GB", 1e9],
		["MB", 1e6],
		["KB", 1e3],
		["B", 1],
	];
	for (const [suffix, multiplier] of units) {
		if (!trimmed.endsWith(suffix)) continue;
		const value = Number.parseFloat(trimmed.slice(0, -suffix.length).trim());
		if (!Number.isFinite(value)) return 0;
		return Math.trunc(value * multiplier);
	}
	return 0;
}

// --- images ---------------------------------------------------------------

export interface KubernetesImageConfig {
	repository: string;
	tag: string;
	pullPolicy: string;
	build?: {
		enabled?: boolean;
		context?: string;
		dockerfile?: string;
	};
	valuePaths: { repository: string; tag: string; pullPolicy: string };
}

export interface ImageBuildPlan {
	command?: Command;
	image: string;
	repository: string;
	tag: string;
	pullPolicy: string;
}

/** Build plan for an app image; `undefined` when the config disables building. */
export function resolveImageBuild(
	appIdent: string,
	appDir: string,
	config: KubernetesImageConfig | undefined,
	runtimeCommand: string,
): ImageBuildPlan | undefined {
	const build = config?.build;
	if (!build || (build.enabled !== undefined && !build.enabled)) {
		return undefined;
	}
	const repository = adjustRepository(
		config.repository === "" ? appIdent : config.repository,
		runtimeCommand,
	);
	const tag = config.tag === "" ? "dev" : config.tag;
	const context = build.context === "" ? appDir : (build.context ?? appDir);
	const dockerfile =
		build.dockerfile === undefined || build.dockerfile === ""
			? `${appDir}/Dockerfile`
			: build.dockerfile;
	return {
		command: {
			name: runtimeCommand,
			args: ["build", "-f", dockerfile, "-t", `${repository}:${tag}`, context],
		},
		image: `${repository}:${tag}`,
		repository,
		tag,
		pullPolicy: config.pullPolicy === "" ? "IfNotPresent" : config.pullPolicy,
	};
}

/** Image reference only; no build command. */
export function resolveImageReference(
	appIdent: string,
	config: KubernetesImageConfig | undefined,
	runtimeCommand: string,
): ImageBuildPlan | undefined {
	if (!config) return undefined;
	const repository = adjustRepository(
		config.repository === "" ? appIdent : config.repository,
		runtimeCommand,
	);
	const tag = config.tag === "" ? "latest" : config.tag;
	return {
		image: `${repository}:${tag}`,
		repository,
		tag,
		pullPolicy: config.pullPolicy === "" ? "IfNotPresent" : config.pullPolicy,
	};
}

/** Podman requires a fully qualified registry for a short name. */
function adjustRepository(repository: string, runtimeCommand: string): string {
	if (runtimeCommand !== "podman") return repository;
	return isShortImageName(repository) ? `localhost/${repository}` : repository;
}

export function isShortImageName(repository: string): boolean {
	return (
		!repository.includes("/") &&
		!repository.includes(".") &&
		!repository.includes(":")
	);
}

/** `--set-string` overrides for the chart's repository/tag/pull-policy paths. */
export function helmImageOverrides(
	config: KubernetesImageConfig,
	plan: ImageBuildPlan,
): string[] {
	const args: string[] = [];
	const add = (path: string, value: string): void => {
		if (path !== "" && value !== "") {
			args.push("--set-string", `${path}=${value}`);
		}
	};
	add(config.valuePaths.repository, plan.repository);
	add(config.valuePaths.tag, plan.tag);
	add(config.valuePaths.pullPolicy, plan.pullPolicy);
	return args;
}

// --- secrets --------------------------------------------------------------

export interface KubernetesSecretConfig {
	name: string;
	keys: string[];
}

export interface SecretApplyPlan {
	name: string;
	namespace: string;
	keys: string[];
	values: Record<string, string>;
	command: Command;
}

/**
 * Builds `kubectl create secret` plans from the environment. A key the
 * environment does not carry fails the plan: a secret is never applied with a
 * missing value, and the values are only ever held in memory.
 */
export function buildSecretPlans(
	runner: Runner,
	namespace: string,
	secrets: readonly KubernetesSecretConfig[],
	env: Record<string, string>,
): SecretApplyPlan[] {
	const plans: SecretApplyPlan[] = [];
	for (const secret of secrets) {
		const values: Record<string, string> = {};
		const keys = [...secret.keys].sort();
		for (const key of keys) {
			const value = env[key];
			if (value === undefined) {
				throw new Error(
					`missing env key ${JSON.stringify(key)} for Kubernetes Secret ${JSON.stringify(secret.name)}`,
				);
			}
			values[key] = value;
		}
		const args = [
			"create",
			"secret",
			"generic",
			secret.name,
			"--namespace",
			namespace,
			"--dry-run=client",
			"-o",
			"yaml",
		];
		for (const key of keys) {
			args.push("--from-literal", `${key}=${values[key]}`);
		}
		plans.push({
			name: secret.name,
			namespace,
			keys,
			values,
			command: runner.kubectl(...args),
		});
	}
	return plans;
}

/** The argv a caller may log: every literal value replaced by `<redacted>`. */
export function redactSecretCommand(plan: SecretApplyPlan): Command {
	return {
		name: plan.command.name,
		env: [...(plan.command.env ?? [])],
		args: plan.command.args.map((arg) => {
			if (!arg.includes("=")) return arg;
			for (const key of plan.keys) {
				if (arg.startsWith(`${key}=`)) return `${key}=<redacted>`;
			}
			return arg;
		}),
	};
}

// --- infrastructure lifecycle --------------------------------------------

export interface KubernetesDeploymentPlan {
	readonly name: string;
	readonly namespace: string;
	readonly release: string;
	readonly chart: string;
	readonly commands: readonly Command[];
	readonly readiness: readonly Command[];
}

/**
 * The Helm sequence for one infrastructure deployment: cluster create when
 * needed, image load, secret applies, `helm upgrade --install`, then the
 * readiness wait. Nothing here mutates a cluster by itself.
 */
export function planKubernetesDeployment(input: {
	readonly runner: Runner;
	readonly name: string;
	readonly namespace: string;
	readonly release: string;
	readonly chart: string;
	readonly values: readonly string[];
	readonly images: readonly string[];
	readonly secrets: readonly SecretApplyPlan[];
	readonly waitTimeout?: string;
}): KubernetesDeploymentPlan {
	const { runner } = input;
	const commands: Command[] = [];
	commands.push(runner.kindGetClusters());
	for (const image of input.images) {
		commands.push(runner.kindLoadImage(image));
	}
	for (const secret of input.secrets) {
		// The plan holds the argv a caller runs; redaction happens at log time.
		commands.push(secret.command);
	}
	commands.push(
		runner.helm(
			"upgrade",
			"--install",
			input.release,
			input.chart,
			"--namespace",
			input.namespace,
			"--create-namespace",
			...input.values.flatMap((value) => ["--values", value]),
		),
	);
	const readiness = [
		runner.kubectl(
			"wait",
			"--for=condition=available",
			"deployment",
			"-l",
			`app.kubernetes.io/instance=${input.release}`,
			"--namespace",
			input.namespace,
			"--timeout",
			input.waitTimeout ?? "5m",
		),
	];
	return {
		name: input.name,
		namespace: input.namespace,
		release: input.release,
		chart: input.chart,
		commands,
		readiness,
	};
}

/** Helm release status → infrastructure status. */
export function mapHelmStatus(output: string, error?: Error): string {
	if (error) return "stopped";
	const lower = output.toLowerCase();
	if (
		lower.includes("failed") ||
		lower.includes("pending-install") ||
		lower.includes("pending-upgrade")
	) {
		return "failed";
	}
	if (lower.includes("deployed")) return "running";
	return "stopped";
}

export function logsCommand(
	runner: Runner,
	release: string,
	namespace: string,
	selectors: readonly string[],
): Command {
	const selector =
		selectors.length > 0 && (selectors[0] ?? "").trim() !== ""
			? selectors[0]
			: `app.kubernetes.io/instance=${release}`;
	return runner.kubectl(
		"logs",
		"--namespace",
		namespace,
		"-l",
		selector,
		"--all-containers",
		"--tail",
		"200",
	);
}

export function portForwardCommand(
	runner: Runner,
	namespace: string,
	port: { resource: string; localPort: number; remotePort: number },
): Command {
	return runner.kubectl(
		"port-forward",
		"--namespace",
		namespace,
		port.resource,
		`${port.localPort}:${port.remotePort}`,
	);
}

// --- status watchers ------------------------------------------------------

export interface ClusterWatcherOptions {
	readonly service: KubernetesClusterService;
	readonly signal: AbortSignal;
	readonly onStatus: (status: ClusterStatus) => void;
	readonly intervalMs?: number;
	readonly logger?: (message: string) => void;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Polls cluster status for as long as the signal is live. One iteration is one
 * status collection, so a shutdown during a poll or during the interval stops
 * the loop and schedules no further collection.
 */
export function startClusterStatusWatcher(
	options: ClusterWatcherOptions,
): void {
	const sleep = options.sleep ?? sleepWithSignal;
	const interval = options.intervalMs ?? 30_000;
	void (async () => {
		for (;;) {
			if (options.signal.aborted) return;
			try {
				const status = await options.service.status(options.signal);
				if (options.signal.aborted) return;
				options.onStatus(status);
			} catch (error) {
				options.logger?.(`[Kubernetes] status watch failed: ${message(error)}`);
			}
			await sleep(interval, options.signal);
		}
	})();
}

// --- internal -------------------------------------------------------------

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function pick(raw: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		if (key in raw) {
			const value = raw[key];
			return typeof value === "string" ? value : String(value);
		}
	}
	return "";
}

function fields(text: string): string[] {
	return text.split(/\s+/).filter(Boolean);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
