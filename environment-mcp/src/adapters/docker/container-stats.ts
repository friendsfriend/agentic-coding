import fs from "node:fs";
import { request } from "node:http";
import type {
	ContainerStats,
	ContainerStatsPort,
} from "../../domain/container-stats.ts";
import { resolveSocketPath } from "./container-inspection.ts";

const responseByteLimit = 256 * 1024;

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function numberOrUndefined(value: unknown) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function round(value: number) {
	return Math.round(value * 100) / 100;
}

function cpuPercent(raw: Record<string, unknown>) {
	const cpu = object(raw.cpu_stats);
	const previous = object(raw.precpu_stats);
	const usage = numberOrUndefined(object(cpu.cpu_usage).total_usage);
	const previousUsage = numberOrUndefined(
		object(previous.cpu_usage).total_usage,
	);
	const system = numberOrUndefined(cpu.system_cpu_usage);
	const previousSystem = numberOrUndefined(previous.system_cpu_usage);
	const perCpu = cpu.percpu_usage;
	const online =
		numberOrUndefined(cpu.online_cpus) ??
		(Array.isArray(perCpu) ? perCpu.length : undefined);
	if (
		usage === undefined ||
		previousUsage === undefined ||
		system === undefined ||
		previousSystem === undefined
	)
		return undefined;
	const cpuDelta = usage - previousUsage;
	const systemDelta = system - previousSystem;
	if (cpuDelta < 0 || systemDelta <= 0) return undefined;
	return round((cpuDelta / systemDelta) * (online || 1) * 100);
}

function memory(raw: Record<string, unknown>) {
	const stats = object(raw.memory_stats);
	const usage = numberOrUndefined(stats.usage);
	const limit = numberOrUndefined(stats.limit);
	if (usage === undefined) return {};
	const detail = object(stats.stats);
	const cache =
		numberOrUndefined(detail.cache) ??
		numberOrUndefined(detail.inactive_file) ??
		0;
	const effective = Math.max(0, usage - cache);
	return {
		memoryUsageBytes: effective,
		...(limit !== undefined && limit > 0
			? {
					memoryLimitBytes: limit,
					memoryPercent: round((effective / limit) * 100),
				}
			: {}),
	};
}

function network(raw: Record<string, unknown>) {
	const networks = object(raw.networks);
	let rx = 0;
	let tx = 0;
	let seen = false;
	for (const value of Object.values(networks)) {
		const entry = object(value);
		const entryRx = numberOrUndefined(entry.rx_bytes);
		const entryTx = numberOrUndefined(entry.tx_bytes);
		if (entryRx !== undefined) {
			rx += entryRx;
			seen = true;
		}
		if (entryTx !== undefined) {
			tx += entryTx;
			seen = true;
		}
	}
	return seen ? { networkRxBytes: rx, networkTxBytes: tx } : {};
}

export function readContainerStats(
	raw: Record<string, unknown>,
): ContainerStats {
	const cpu = cpuPercent(raw);
	const pids = numberOrUndefined(object(raw.pids_stats).current);
	return {
		...(cpu !== undefined ? { cpuPercent: cpu } : {}),
		...memory(raw),
		...network(raw),
		...(pids !== undefined ? { pids } : {}),
		...(typeof raw.read === "string" ? { readAt: raw.read } : {}),
	};
}

/** Read-only Docker/Podman Engine stats for one known container identity. */
export function createDockerStatsAdapter(): ContainerStatsPort {
	return {
		async stats(_provider, socketPath, container, signal) {
			if (!/^[a-f0-9]{12,64}$/.test(container))
				throw new Error("container-stats-unavailable");
			const socket = resolveSocketPath(socketPath);
			const identity = fs.statSync(socket);
			const result = await new Promise<ContainerStats>((resolve, reject) => {
				const client = request(
					{
						method: "GET",
						socketPath: socket,
						path: `/containers/${encodeURIComponent(container)}/stats?stream=false`,
						agent: false,
						maxHeaderSize: 8192,
						headers: { Accept: "application/json", Host: "docker" },
						signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
					},
					(response) => {
						if (
							response.statusCode !== 200 ||
							response.headers["content-type"]?.split(";")[0]?.trim() !==
								"application/json"
						) {
							reject(new Error("container-stats-unavailable"));
							response.destroy();
							return;
						}
						const chunks: Buffer[] = [];
						let length = 0;
						response.on("data", (value: Buffer) => {
							length += value.length;
							if (length > responseByteLimit) {
								client.destroy(new Error("container-stats-unavailable"));
								return;
							}
							chunks.push(value);
						});
						response.once("error", () =>
							reject(new Error("container-stats-unavailable")),
						);
						response.once("aborted", () =>
							reject(new Error("container-stats-unavailable")),
						);
						response.once("end", () => {
							try {
								resolve(
									readContainerStats(
										JSON.parse(
											Buffer.concat(chunks).toString("utf8"),
										) as Record<string, unknown>,
									),
								);
							} catch {
								reject(new Error("container-stats-unavailable"));
							}
						});
					},
				);
				client.once("error", () =>
					reject(new Error("container-stats-unavailable")),
				);
				client.end();
			});
			const after = fs.statSync(socket);
			if (
				resolveSocketPath(socketPath) !== socket ||
				after.dev !== identity.dev ||
				after.ino !== identity.ino
			)
				throw new Error("container-stats-unavailable");
			signal.throwIfAborted();
			return result;
		},
	};
}
