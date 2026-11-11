import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Config, object, text } from "../config.ts";
import { contained } from "../git.ts";
import { Refusal } from "../server/refusal.ts";
import {
	clusterBusy,
	clusterLifecycle,
	connectCluster,
	kindCommands,
	openClusterClient,
} from "./cluster.ts";
import type { Cluster, ProvisionedCluster } from "./cluster-types.ts";
import { EnvironmentCommands } from "./command.ts";
import type { Environments } from "./manager.ts";

export const clusterOperations = [
	"create",
	"delete",
	"recreate",
	"export-kubeconfig",
] as const;
export type ClusterOperation = (typeof clusterOperations)[number];
type Receipt = {
	id: string;
	cluster: string;
	operation: ClusterOperation;
	/** issued = in flight or interrupted (never presumed done or undone). */
	state: "issued" | "completed" | "failed";
	createdAt: number;
	finishedAt?: number;
	error?: string;
	output?: string;
};
/** Durable journal of direct TUI cluster lifecycle operations. An issued
 * receipt that this process no longer runs is uncertain, not completed. */
export const ClusterOperationState = defineDoc<{
	operations: Record<string, string>;
}>({
	kind: "v2.cluster-operations",
	version: 1,
	scope: "session",
	initial: () => ({ operations: {} }),
	checkpointWhen: () => true,
});

type NodeStats = {
	name: string;
	containerName: string;
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
};
const units: Record<string, number> = {
	b: 1,
	kb: 1e3,
	mb: 1e6,
	gb: 1e9,
	kib: 1024,
	mib: 1024 ** 2,
	gib: 1024 ** 3,
};
const bytes = (value: string) => {
	const match = /^([0-9.]+)\s*([a-z]*)$/i.exec(value.trim());
	const unit = units[(match?.[2] || "b").toLowerCase()];
	return match && unit ? Math.trunc(Number(match[1]) * unit) : 0;
};
const percent = (value: unknown) => {
	const parsed = Number.parseFloat(String(value ?? "").replace(/%$/, ""));
	return Number.isFinite(parsed) ? parsed : 0;
};
const json = (raw: string) => {
	try {
		return object(JSON.parse(raw));
	} catch {
		return {};
	}
};
const items = (raw: string) => {
	const list = json(raw).items;
	return Array.isArray(list) ? list.map((item) => object(item)) : [];
};
/** v1 cluster status (kind list, version, nodes, pods, releases, node stats),
 * read with the private kubeconfig. Unavailable observations are warnings and
 * never confirmed absence: status never creates or deletes a cluster. */
export async function clusterStatus(
	config: Config,
	request: ProvisionedCluster,
	signal?: AbortSignal,
) {
	const { provision, cluster } = request,
		status = {
			clusterName: provision.name,
			contextName: cluster.context,
			provider: provision.provider,
			exists: false,
			reachable: false,
			state: "missing" as "missing" | "running" | "degraded" | "unreachable",
			kubernetesVersion: undefined as string | undefined,
			nodes: [] as { name: string; ready: boolean; kubeletVersion: string }[],
			namespaces: [] as { name: string; pods: number }[],
			pods: {
				total: 0,
				running: 0,
				pending: 0,
				succeeded: 0,
				failed: 0,
				unknown: 0,
			},
			podList: [] as { name: string; namespace: string; status: string }[],
			releases: [] as Record<string, string>[],
			stats: undefined as
				| {
						cpuPercent: number;
						memoryUsageBytes: number;
						memoryLimitBytes: number;
						memoryPercent: number;
						nodes: NodeStats[];
						collectedAt: string;
				  }
				| undefined,
			warnings: [] as string[],
			collectedAt: new Date().toISOString(),
		};
	const search = cluster.environment.PATH ?? process.env.PATH ?? "";
	for (const tool of ["kind", provision.provider])
		if (!Bun.which(tool, { PATH: search })) {
			status.warnings.push(
				`Missing required Kubernetes tool ${JSON.stringify(tool)}; install it to create the ${provision.name} cluster`,
			);
			return status;
		}
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-kind-status-")),
		closers: (() => void)[] = [];
	try {
		const kind = kindCommands(config, request, scratch);
		let listed: string;
		try {
			listed = await kind.checked(["get", "clusters"], {
				signal,
				timeoutMs: 30000,
				machine: true,
			});
		} catch {
			status.state = "unreachable";
			status.warnings.push(
				"kind get clusters failed; existence is unknown, not absent",
			);
			return status;
		}
		status.exists = listed
			.split(/\s+/)
			.some((line) => line.trim() === provision.name);
		if (!status.exists) return status;
		status.state = "unreachable";
		if (clusterBusy(cluster.id)) {
			status.warnings.push("A kind lifecycle operation is running");
			return status;
		}
		let client: ReturnType<typeof openClusterClient>;
		try {
			// Same validated private connection a run uses (loopback HTTPS,
			// config-contained credential files); importing never creates.
			client = openClusterClient(
				config,
				await connectCluster(config, request, false, signal),
			);
		} catch {
			status.warnings.push(
				"The private cluster connection could not be established",
			);
			return status;
		}
		closers.push(() => client.close());
		const kubectl = client.commands,
			read = async (args: string[]) => {
				try {
					return await kubectl.checked(args, {
						signal,
						timeoutMs: 10000,
						machine: true,
					});
				} catch {
					status.warnings.push(`kubectl ${args.slice(0, 2).join(" ")} failed`);
					return null;
				}
			};
		const version = await read(["version", "-o", "json"]);
		if (version === null) return status;
		status.reachable = true;
		status.state = "running";
		const server = object(json(version).serverVersion);
		status.kubernetesVersion =
			typeof server.gitVersion === "string" ? server.gitVersion : "";
		const nodes = await read(["get", "nodes", "-o", "json"]);
		if (nodes === null) status.state = "degraded";
		else
			status.nodes = items(nodes).map((item) => {
				const metadata = object(item.metadata),
					state = object(item.status),
					info = object(state.nodeInfo),
					conditions = Array.isArray(state.conditions) ? state.conditions : [];
				return {
					name: String(metadata.name ?? ""),
					ready: conditions.some(
						(entry) =>
							object(entry).type === "Ready" && object(entry).status === "True",
					),
					kubeletVersion: String(info.kubeletVersion ?? ""),
				};
			});
		const pods = await read(["get", "pods", "--all-namespaces", "-o", "json"]);
		if (pods === null) status.state = "degraded";
		else {
			const counts = new Map<string, number>();
			for (const item of items(pods)) {
				const metadata = object(item.metadata),
					namespace = String(metadata.namespace ?? ""),
					phase = String(object(item.status).phase ?? "") || "Unknown";
				status.pods.total++;
				counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
				const key = phase.toLowerCase() as keyof typeof status.pods;
				if (key in status.pods && key !== "total") status.pods[key]++;
				else status.pods.unknown++;
				status.podList.push({
					name: String(metadata.name ?? ""),
					namespace,
					status: phase,
				});
			}
			status.namespaces = [...counts]
				.map(([name, count]) => ({ name, pods: count }))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		const helm = client.helm;
		try {
			const raw = await helm.checked(
				["list", "--all-namespaces", "-o", "json"],
				{ signal, timeoutMs: 10000, machine: true },
			);
			const parsed: unknown = JSON.parse(raw);
			status.releases = (Array.isArray(parsed) ? parsed : []).map((entry) => {
				const item = object(entry);
				return Object.fromEntries(
					["name", "namespace", "status", "chart", "revision"].map((key) => [
						key,
						String(item[key] ?? ""),
					]),
				);
			});
		} catch {
			status.warnings.push("helm list failed");
		}
		const engine = new EnvironmentCommands(
			{
				id: cluster.id,
				app: cluster.id,
				action: "run",
				runtime: "shell",
				command: "",
				workspace: request.workspace,
				cwd: request.workspace,
				timeoutMs: 10000,
				readyText: null,
				environment: { ...cluster.environment },
				secretRefs: {},
			},
			config.configDir,
			provision.provider,
			[],
		);
		const nodeStats: NodeStats[] = [];
		try {
			const names = (
				await engine.checked(["ps", "--format", "{{.Names}}"], {
					signal,
					timeoutMs: 10000,
					machine: true,
				})
			)
				.split(/\s+/)
				.filter((name) => name.startsWith(`${provision.name}-`));
			for (const name of names) {
				const line = json(
					await engine.checked(
						["stats", "--no-stream", "--format", "{{json .}}", name],
						{ signal, timeoutMs: 10000, machine: true },
					),
				);
				const [used = "", limit = ""] = String(
					line.MemUsage ?? line.mem_usage ?? "",
				).split("/");
				nodeStats.push({
					name: name.replace(`${provision.name}-`, ""),
					containerName: name,
					cpuPercent: percent(line.CPUPerc ?? line.cpu_percent),
					memoryUsageBytes: bytes(used),
					memoryLimitBytes: bytes(limit),
					memoryPercent: percent(line.MemPerc ?? line.mem_percent),
				});
			}
		} catch {
			status.warnings.push("Node container statistics are unavailable");
		}
		if (nodeStats.length) {
			const usage = nodeStats.reduce((sum, n) => sum + n.memoryUsageBytes, 0),
				limit = nodeStats.reduce((sum, n) => sum + n.memoryLimitBytes, 0);
			status.stats = {
				cpuPercent: nodeStats.reduce((sum, n) => sum + n.cpuPercent, 0),
				memoryUsageBytes: usage,
				memoryLimitBytes: limit,
				memoryPercent: limit ? (usage / limit) * 100 : 0,
				nodes: nodeStats,
				collectedAt: new Date().toISOString(),
			};
		}
		return status;
	} finally {
		for (const close of closers) close();
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** Direct developer cluster lifecycle (v1 `s`/`S`/`R`/`e` on the Kubernetes
 * tab). The key press is the approval; agents and HTTP never reach this.
 * Delete/recreate refuse while any native run still holds that cluster or a
 * kind lifecycle effect is live. Operations are journaled before any effect
 * and never retried; an interrupted operation stays visibly uncertain. */
export class ClusterOperator {
	private running = new Map<string, Promise<void>>();
	constructor(
		private config: Config,
		private environments: Environments,
		private store: () => Harness,
	) {}
	private cluster(id: unknown): Cluster & {
		provision: NonNullable<Cluster["provision"]>;
	} {
		const name = text(id ?? "devenv", "cluster", 64),
			cluster = this.environments.clusters.find((item) => item.id === name);
		if (!cluster?.provision)
			throw new Refusal(
				"Only a provisioned kind cluster supports lifecycle controls",
			);
		return { ...cluster, provision: cluster.provision };
	}
	private request(
		cluster: Cluster & { provision: NonNullable<Cluster["provision"]> },
	) {
		return {
			cluster,
			provision: cluster.provision,
			workspace: this.config.repositories[0] ?? this.config.configDir,
		} satisfies ProvisionedCluster;
	}
	async status(id?: unknown) {
		const cluster = this.cluster(id);
		return {
			...(await clusterStatus(this.config, this.request(cluster))),
			operations: await this.receipts(cluster.id),
		};
	}
	async receipts(cluster?: string) {
		const doc = await this.store().snapshot(ClusterOperationState, background);
		return Object.values(doc?.operations ?? {})
			.map((raw) => JSON.parse(raw) as Receipt)
			.filter((receipt) => !cluster || receipt.cluster === cluster)
			.map((receipt) =>
				receipt.state === "issued" && !this.running.has(receipt.id)
					? {
							...receipt,
							error:
								"Interrupted before an outcome was observed; inspect the cluster before retrying",
						}
					: receipt,
			)
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(-20);
	}
	private async held(cluster: string) {
		const snapshot = await this.environments.snapshot();
		return snapshot.runs.some(
			(run) =>
				run.state !== "exited" &&
				run.plan.runtime === "kubernetes" &&
				(run.plan as { kubernetes?: { cluster?: string } }).kubernetes
					?.cluster === cluster,
		);
	}
	/** Admits one operation and returns its receipt id immediately; the effect
	 * continues in this process (kind create may take minutes). */
	async start(operation: ClusterOperation, id?: unknown, requestId?: unknown) {
		if (!clusterOperations.includes(operation))
			throw new Refusal("Unsupported cluster operation");
		const cluster = this.cluster(id),
			key = text(requestId, "request identity", 128);
		const existing = (await this.receipts()).find((item) => item.id === key);
		if (existing) return existing;
		if (clusterBusy(cluster.id) || this.running.size)
			throw new Refusal(
				"Another cluster lifecycle operation is still running; wait for it to finish",
			);
		if (
			(operation === "delete" || operation === "recreate") &&
			(await this.held(cluster.id))
		)
			throw new Refusal(
				"Stop every native Kubernetes run on this cluster before deleting it",
			);
		const receipt: Receipt = {
			id: key,
			cluster: cluster.id,
			operation,
			state: "issued",
			createdAt: Date.now(),
		};
		await this.save(receipt);
		const effect = this.perform(operation, cluster)
			.then(
				(output) =>
					this.save({
						...receipt,
						state: "completed",
						finishedAt: Date.now(),
						output,
					}),
				(error: unknown) =>
					this.save({
						...receipt,
						state: "failed",
						finishedAt: Date.now(),
						// Native messages are fixed texts; still redacted and one line.
						error: new Refusal(
							error instanceof Error
								? error.message
								: "Cluster operation failed",
						).message,
					}),
			)
			.catch(() => {})
			.finally(() => this.running.delete(key));
		this.running.set(key, effect);
		return receipt;
	}
	/** Waits for live operations (tests and shutdown). */
	async settle() {
		await Promise.all(this.running.values());
	}
	private async perform(
		operation: ClusterOperation,
		cluster: Cluster & { provision: NonNullable<Cluster["provision"]> },
	) {
		const request = this.request(cluster),
			name = cluster.provision.name,
			search = cluster.environment.PATH ?? process.env.PATH ?? "";
		for (const tool of ["kind", cluster.provision.provider])
			if (!Bun.which(tool, { PATH: search }))
				throw new Refusal(
					`Missing required Kubernetes tool ${JSON.stringify(tool)}`,
				);
		const root = fs.realpathSync(this.config.configDir),
			directory = contained(root, path.join("clusters", cluster.id));
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const kind = kindCommands(this.config, request, directory),
			exists = async () =>
				(
					await kind.checked(["get", "clusters"], {
						timeoutMs: 30000,
						machine: true,
					})
				)
					.split(/\s+/)
					.includes(name);
		// v1 create: create when missing, then import its connection. This is
		// the same serialized path a run's first start uses.
		const create = async () => {
			await connectCluster(this.config, request, true);
			return `Cluster ${cluster.context} is ready`;
		};
		const remove = (required: boolean) =>
			clusterLifecycle(cluster.id, async () => {
				// Re-checked under the lifecycle lock: a run admitted meanwhile wins.
				if (await this.held(cluster.id))
					throw new Refusal(
						"Stop every native Kubernetes run on this cluster before deleting it",
					);
				if (!(await exists())) {
					if (required) throw new Refusal(`The ${name} cluster does not exist`);
					return;
				}
				await kind.checked(["delete", "cluster", "--name", name], {
					timeoutMs: 300000,
					effect: true,
				});
				// The private connection belonged to the deleted cluster only.
				for (const file of [
					"kubeconfig.json",
					"ca.crt",
					"client.crt",
					"client.key",
				])
					fs.rmSync(path.join(directory, file), { force: true });
			});
		switch (operation) {
			case "create":
				return create();
			case "delete":
				await remove(true);
				return `Cluster ${cluster.context} deleted`;
			case "recreate":
				await remove(false);
				return create();
			case "export-kubeconfig":
				return clusterLifecycle(cluster.id, async () => {
					if (!(await exists()))
						throw new Refusal(`The ${name} cluster does not exist`);
					// v1 `kind export kubeconfig`: the developer's own kubeconfig
					// (KUBECONFIG or ~/.kube/config) gains the kind- context.
					const target =
						process.env.KUBECONFIG?.split(path.delimiter)[0] ||
						path.join(os.homedir(), ".kube", "config");
					await kindCommands(this.config, request, directory, target).checked(
						["export", "kubeconfig", "--name", name],
						{ timeoutMs: 30000, effect: true },
					);
					return `Kubeconfig exported for ${cluster.context}`;
				});
		}
	}
	private save(receipt: Receipt) {
		return this.store().commit(async (tx) => {
			const doc = await tx.doc(ClusterOperationState);
			doc.operations[receipt.id] = JSON.stringify(receipt);
			const keys = Object.keys(doc.operations);
			for (const old of keys.slice(0, Math.max(0, keys.length - 50)))
				delete doc.operations[old];
		}, background);
	}
}
