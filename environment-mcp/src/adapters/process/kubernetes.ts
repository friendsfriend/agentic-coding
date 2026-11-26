import { loadKubernetesClusters } from "../../configuration/kubernetes-cluster.ts";
import type {
	KubernetesClusterInfo,
	KubernetesEvent,
	KubernetesPort,
	KubernetesResource,
} from "../../domain/kubernetes.ts";
import { OperationRefusal } from "../../domain/operation.ts";

const inherited = ["PATH", "HOME", "LANG", "TMPDIR", "TERM", "TZ"] as const;
const outputLimit = 128 * 1024;
const jsonLimit = 512 * 1024;
const timeoutMs = 15_000;
const logTimeoutMs = 20_000;
const clusterPattern = /^[a-z][a-z0-9-]{0,63}$/;
const namespacePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const resourceNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const containerPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const describeKinds = new Set([
	"deployment",
	"statefulset",
	"pod",
	"service",
	"daemonset",
	"replicaset",
	"job",
	"cronjob",
]);

function environment(extra: Record<string, string>) {
	return {
		...Object.fromEntries(
			inherited.flatMap((key) =>
				process.env[key] ? [[key, process.env[key] as string]] : [],
			),
		),
		...extra,
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function count(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: undefined;
}

function list(value: unknown) {
	return Array.isArray(value) ? value : [];
}

function age(createdAt: string | undefined) {
	if (!createdAt) return undefined;
	const timestamp = Date.parse(createdAt);
	if (!Number.isFinite(timestamp)) return undefined;
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function mapResource(
	raw: Record<string, unknown>,
): KubernetesResource | undefined {
	const metadata = record(raw.metadata);
	const name = text(metadata.name);
	if (!name) return undefined;
	const kind = text(raw.kind) ?? "Resource";
	const createdAt = text(metadata.creationTimestamp);
	const status = record(raw.status);
	const spec = record(raw.spec);
	const base = {
		kind,
		name,
		...(createdAt ? { createdAt } : {}),
		...(age(createdAt) ? { age: age(createdAt) } : {}),
	};
	if (kind === "Pod") {
		const statuses = list(status.containerStatuses).map(record);
		const ready = statuses.filter((entry) => entry.ready === true).length;
		const restarts = statuses.reduce(
			(total, entry) => total + (count(entry.restartCount) ?? 0),
			0,
		);
		const containers = [
			...new Set(
				[
					...statuses.map((entry) => text(entry.name)),
					...list(spec.containers).map((entry) => text(record(entry).name)),
				].filter((name): name is string => Boolean(name)),
			),
		];
		const phase = text(status.phase) ?? "Unknown";
		const reason = text(status.reason);
		return {
			...base,
			status: reason ? `${phase} (${reason})` : phase,
			...(statuses.length ? { ready: `${ready}/${statuses.length}` } : {}),
			restarts,
			...(containers.length ? { containers } : {}),
		};
	}
	if (kind === "Service") {
		const serviceType = text(spec.type) ?? "Service";
		const clusterIp = text(spec.clusterIP);
		return {
			...base,
			status: serviceType,
			...(clusterIp ? { ready: clusterIp } : {}),
		};
	}
	if (
		kind === "Deployment" ||
		kind === "StatefulSet" ||
		kind === "DaemonSet" ||
		kind === "ReplicaSet"
	) {
		const desired = count(spec.replicas) ?? 0;
		const ready = count(status.readyReplicas) ?? 0;
		return {
			...base,
			status: ready >= desired ? "Ready" : "Progressing",
			ready: `${ready}/${desired}`,
		};
	}
	if (kind === "Job" || kind === "CronJob") {
		const succeeded = count(status.succeeded) ?? 0;
		const failed = count(status.failed) ?? 0;
		return {
			...base,
			status:
				failed > 0
					? `Failed (${failed})`
					: succeeded > 0
						? "Completed"
						: "Pending",
		};
	}
	return { ...base, status: text(status.phase) ?? "Unknown" };
}

function resourceTable(items: readonly KubernetesResource[]) {
	const header = "KIND\tNAME\tREADY\tSTATUS\tRESTARTS\tAGE";
	return [
		header,
		...items.map((item) =>
			[
				item.kind,
				item.name,
				item.ready ?? "-",
				item.status,
				item.restarts ?? "-",
				item.age ?? "-",
			].join("\t"),
		),
	].join("\n");
}

function mapEvent(raw: Record<string, unknown>): KubernetesEvent | undefined {
	const reason = text(raw.reason);
	if (!reason) return undefined;
	const involved = record(raw.involvedObject);
	const kind = text(involved.kind);
	const name = text(involved.name);
	const object = [kind, name].filter(Boolean).join("/") || "unknown";
	const lastTimestamp =
		text(raw.lastTimestamp) ?? text(raw.eventTime) ?? text(raw.firstTimestamp);
	return {
		type: text(raw.type) ?? "Normal",
		reason,
		object,
		message: text(raw.message) ?? "",
		...(count(raw.count) ? { count: count(raw.count) } : {}),
		...(lastTimestamp ? { lastTimestamp } : {}),
	};
}

function eventTable(events: readonly KubernetesEvent[]) {
	return [
		"TYPE\tREASON\tOBJECT\tMESSAGE",
		...events.map((event) =>
			[event.type, event.reason, event.object, event.message].join("\t"),
		),
	].join("\n");
}

/** Read-only kubectl inspection for explicitly configured clusters. Only fixed
 * read commands run; no command, namespace wildcard or kubeconfig path is
 * exposed to callers. */
export function createKubernetesAdapter(
	configDir: string,
	serverRepositories: readonly string[],
	options: { kubectl?: string } = {},
): KubernetesPort {
	const kubectl = options.kubectl ?? Bun.which("kubectl");
	const authorized = (
		repositories: readonly string[],
		cluster: {
			repositories: readonly string[];
		},
	) =>
		cluster.repositories.some((repository) =>
			repositories.includes(repository),
		);
	const clusterFor = (repositories: readonly string[], clusterId: string) => {
		if (!clusterPattern.test(clusterId))
			throw new OperationRefusal("kubernetes-cluster-unavailable");
		const clusters = loadKubernetesClusters(configDir, serverRepositories);
		const cluster = clusters.get(clusterId);
		if (!cluster || !authorized(repositories, cluster))
			throw new OperationRefusal("kubernetes-cluster-unavailable");
		if (!kubectl) throw new OperationRefusal("kubernetes-cluster-unavailable");
		return cluster;
	};
	const safeNamespace = (namespace: string) => {
		if (!namespacePattern.test(namespace) || namespace.startsWith("kube-"))
			throw new OperationRefusal("kubernetes-cluster-unavailable");
		return namespace;
	};
	const run = async (
		cluster: {
			context: string;
			kubeconfig?: string;
			environment: Record<string, string>;
		},
		args: readonly string[],
		signal: AbortSignal,
		limit = outputLimit,
		timeout = timeoutMs,
	) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		timer.unref?.();
		const combined = AbortSignal.any([signal, controller.signal]);
		let child: ReturnType<typeof Bun.spawn> | undefined;
		let stop: (() => void) | undefined;
		try {
			child = Bun.spawn(
				[
					kubectl as string,
					...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
					"--context",
					cluster.context,
					"--request-timeout=10s",
					...args,
				],
				{
					env: environment(cluster.environment),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			stop = () => child?.kill("SIGKILL");
			combined.addEventListener("abort", stop, { once: true });
			const collect = async (stream: ReadableStream<Uint8Array>) => {
				const decoder = new TextDecoder();
				let output = "";
				let truncated = false;
				for await (const chunk of stream) {
					const decoded = decoder.decode(chunk, { stream: true });
					const remaining = limit - output.length;
					if (remaining <= 0) {
						truncated = true;
						continue;
					}
					output += decoded.slice(0, remaining);
					if (decoded.length > remaining) truncated = true;
				}
				output += decoder.decode();
				return { output, truncated };
			};
			const stdoutStream = child.stdout;
			const stderrStream = child.stderr;
			if (
				!stdoutStream ||
				!stderrStream ||
				typeof stdoutStream === "number" ||
				typeof stderrStream === "number"
			)
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			const [stdout, stderr, exitCode] = await Promise.all([
				collect(stdoutStream),
				collect(stderrStream),
				child.exited,
			]);
			if (exitCode !== 0 || controller.signal.aborted)
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			signal.throwIfAborted();
			return {
				stdout: stdout.output,
				output: [stdout.output, stderr.output]
					.filter(Boolean)
					.join("\n")
					.slice(0, limit),
				truncated: stdout.truncated || stderr.truncated,
			};
		} catch (error) {
			if (error instanceof OperationRefusal) throw error;
			throw new OperationRefusal("kubernetes-cluster-unavailable");
		} finally {
			if (stop) combined.removeEventListener("abort", stop);
			clearTimeout(timer);
			if (child && child.exitCode === null) child.kill("SIGKILL");
		}
	};
	return {
		list(repositories) {
			const clusters = loadKubernetesClusters(configDir, serverRepositories);
			return [...clusters.values()]
				.filter((cluster) => authorized(repositories, cluster))
				.map(
					(cluster): KubernetesClusterInfo => ({
						id: cluster.id,
						context: cluster.context,
						repositories: cluster.repositories,
					}),
				)
				.sort((left, right) => left.id.localeCompare(right.id));
		},
		async resources(repositories, clusterId, namespace, signal) {
			safeNamespace(namespace);
			const cluster = clusterFor(repositories, clusterId);
			const result = await run(
				cluster,
				[
					"get",
					"deployments,statefulsets,pods,services",
					"--namespace",
					namespace,
					"--output",
					"json",
				],
				signal,
				jsonLimit,
			);
			let items: KubernetesResource[] = [];
			let truncated = result.truncated;
			try {
				const parsed = record(JSON.parse(result.stdout));
				const rawItems = list(parsed.items);
				if (rawItems.length > 200) truncated = true;
				items = rawItems
					.slice(0, 200)
					.map((item) => mapResource(record(item)))
					.filter((item): item is KubernetesResource => Boolean(item));
			} catch {
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			}
			return {
				cluster: cluster.id,
				namespace,
				output: resourceTable(items).slice(0, outputLimit),
				truncated,
				items,
			};
		},
		async events(repositories, clusterId, namespace, signal) {
			safeNamespace(namespace);
			const cluster = clusterFor(repositories, clusterId);
			const result = await run(
				cluster,
				[
					"get",
					"events",
					"--namespace",
					namespace,
					"--sort-by=.lastTimestamp",
					"--output",
					"json",
				],
				signal,
				jsonLimit,
			);
			let events: KubernetesEvent[] = [];
			let truncated = result.truncated;
			try {
				const parsed = record(JSON.parse(result.stdout));
				const rawItems = list(parsed.items);
				if (rawItems.length > 100) truncated = true;
				events = rawItems
					.slice(0, 100)
					.map((item) => mapEvent(record(item)))
					.filter((event): event is KubernetesEvent => Boolean(event));
			} catch {
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			}
			return {
				cluster: cluster.id,
				namespace,
				output: eventTable(events).slice(0, outputLimit),
				truncated,
				events,
			};
		},
		async describe(repositories, clusterId, namespace, kind, name, signal) {
			safeNamespace(namespace);
			const cluster = clusterFor(repositories, clusterId);
			if (
				!describeKinds.has(kind) ||
				name.length > 253 ||
				!resourceNamePattern.test(name)
			)
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			const result = await run(
				cluster,
				["describe", kind, name, "--namespace", namespace],
				signal,
			);
			return {
				cluster: cluster.id,
				namespace,
				kind,
				name,
				output: result.output,
				truncated: result.truncated,
			};
		},
		async podLogs(
			repositories,
			clusterId,
			namespace,
			pod,
			container,
			tail,
			signal,
		) {
			safeNamespace(namespace);
			const cluster = clusterFor(repositories, clusterId);
			if (
				pod.length > 253 ||
				!resourceNamePattern.test(pod) ||
				!Number.isSafeInteger(tail) ||
				tail < 1 ||
				tail > 1000 ||
				(container !== undefined &&
					(container.length > 63 || !containerPattern.test(container)))
			)
				throw new OperationRefusal("kubernetes-cluster-unavailable");
			const result = await run(
				cluster,
				[
					"logs",
					pod,
					"--namespace",
					namespace,
					"--tail",
					String(tail),
					...(container ? ["--container", container] : []),
				],
				signal,
				outputLimit,
				logTimeoutMs,
			);
			return {
				cluster: cluster.id,
				namespace,
				pod,
				...(container ? { container } : {}),
				output: result.output,
				truncated: result.truncated,
			};
		},
	};
}
