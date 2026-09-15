// Bun-owned Docker/Podman runtime (`port-environment-runtimes-to-bun`, section 2).
//
// Ported from `server/pkg/docker/{client,runtime,health,stats}.go`.
//
// The Docker Engine HTTP API is spoken directly over the runtime's socket
// (unix socket for Docker/Podman, `tcp://` when the host says so) instead of
// shelling out to `docker`: inspection, listing, lifecycle and streams keep the
// exact structured semantics Go had through the SDK, and `docker`/`podman` argv
// is used only where Go used argv too (kind node stats, `system prune`).
//
// Deliberate differences from the Go implementation, all asserted by a test:
//
//   - **API version negotiation is dropped.** Every request uses the
//     unversioned path (`/containers/json`), which dockerd and the Podman
//     compat API both map to their own latest version; Go negotiated
//     `/vX.Y/...` with an extra round trip that no ported behaviour depended on.
//   - **The multiplexed log frame decoder is lenient.** Go's `stdcopy.StdCopy`
//     fails on a TTY stream; the port detects a framed stream by its 8-byte
//     header and otherwise treats the body as raw output, so a TTY container
//     streams instead of erroring.
//   - **Cache refresh is a promise, not a lock.** Go guarded the container
//     cache with a mutex; the port keeps the last snapshot and refreshes it
//     with one in-flight request that concurrent callers await, so a burst of
//     status reads still triggers a single list.
import { spawn } from "node:child_process";
import fs from "node:fs";

// --- model ----------------------------------------------------------------

/** Docker information for one app or infrastructure service. The wire keys are
 * capitalised because Go marshals `docker.Info` without json tags. */
export interface DockerInfo {
	Status: string;
	ContainerID: string;
	Ports: string;
}

export const INFO_NOT_FOUND: DockerInfo = {
	Status: "not found",
	ContainerID: "",
	Ports: "",
};

/** One entry of the Docker API's container list. */
export interface ContainerSummary {
	Id: string;
	Names: string[];
	State: string;
	Ports: { PrivatePort: number; PublicPort?: number; Type: string }[];
}

export interface ContainerEvent {
	containerId: string;
	containerName: string;
	action: string;
	time: Date;
}

export interface ContainerStatsEntry {
	cpuPercent: number;
	memoryUsage: number;
	memoryLimit: number;
	memoryPercent: number;
	timestamp: string;
}

const CONTAINER_CACHE_TTL_MS = 30_000;

/** Container names that a status read may match. */
export interface RuntimeTarget {
	readonly ident: string;
	readonly containerBaseName: string;
}

// --- runtime selection ----------------------------------------------------

/** A configured Docker-compatible runtime and the endpoint it answers on. */
export interface DockerRuntime {
	readonly name: string;
	readonly command: string;
	/** `unix://<path>`, `tcp://host:port`, `npipe://...` or empty for env default. */
	readonly host: string;
}

/**
 * The runtime candidates the configured name resolves to, in probe order.
 * Mirrors Go's `runtimeCandidates`, including its preference order for Podman:
 * explicit `DEVENV_PODMAN_HOST`, then `DOCKER_HOST`, then the user and system
 * sockets.
 */
export function runtimeCandidates(
	name: string,
	env: Record<string, string | undefined> = process.env,
	uid = defaultUid(),
	home = defaultHome(),
): DockerRuntime[] {
	if (name === "docker") {
		return [{ name: "docker", command: "docker", host: env.DOCKER_HOST ?? "" }];
	}
	if (name === "podman") {
		const podmanHost = env.DEVENV_PODMAN_HOST;
		if (podmanHost) {
			return [{ name: "podman", command: "podman", host: podmanHost }];
		}
		if (env.DOCKER_HOST) {
			return [{ name: "podman", command: "podman", host: env.DOCKER_HOST }];
		}
		if (process.platform === "win32") {
			return [{ name: "podman", command: "podman", host: "" }];
		}
		return [
			{
				name: "podman",
				command: "podman",
				host: `unix:///run/user/${uid}/podman/podman.sock`,
			},
			{
				name: "podman",
				command: "podman",
				host: "unix:///run/podman/podman.sock",
			},
			{
				name: "podman",
				command: "podman",
				host: `unix://${home}/.local/share/containers/podman/machine/podman.sock`,
			},
		];
	}
	return [];
}

function defaultUid(): number {
	return typeof process.getuid === "function" ? process.getuid() : 0;
}

function defaultHome(): string {
	return process.env.HOME ?? "";
}

export function composeCommandForRuntime(name: string): string {
	return name === "podman" ? "podman-compose" : "docker-compose";
}

export function runtimeCommandForRuntime(name: string): string {
	return name === "podman" ? "podman" : "docker";
}

/**
 * Parses `DOCKER_HOST`-style endpoints into a Bun `fetch` target. `DOCKER_TLS_VERIFY`
 * and `DOCKER_CERT_PATH` are honoured the way Go's `client.FromEnv` honoured
 * them, so a daemon behind TLS is reached with the same credentials.
 */
export function parseDockerHost(
	host: string,
	env: Record<string, string | undefined> = process.env,
): {
	unix?: string;
	url: string;
	tls?: { ca?: string; cert?: string; key?: string };
} {
	const tls = dockerTlsOptions(env);
	if (host.startsWith("unix://")) {
		const socket = host.slice("unix://".length);
		return { unix: socket, url: "http://docker" };
	}
	if (host.startsWith("tcp://")) {
		const authority = host.slice("tcp://".length);
		const scheme = tls ? "https" : "http";
		return { url: `${scheme}://${authority}`, ...(tls ? { tls } : {}) };
	}
	if (host.startsWith("https://")) {
		return { url: host, ...(tls ? { tls } : {}) };
	}
	if (host.startsWith("http://")) {
		return { url: host };
	}
	// Empty host: Docker's default socket for the current platform.
	if (process.platform === "win32") {
		return { unix: "//./pipe/docker_engine", url: "http://docker" };
	}
	return { unix: "/var/run/docker.sock", url: "http://docker" };
}

/** The TLS material a Docker daemon behind TLS requires, when configured. */
export function dockerTlsOptions(
	env: Record<string, string | undefined>,
	readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
): { ca?: string; cert?: string; key?: string } | undefined {
	if (!env.DOCKER_TLS_VERIFY || env.DOCKER_TLS_VERIFY === "") return undefined;
	const certPath = env.DOCKER_CERT_PATH;
	if (!certPath || certPath === "") return { ca: undefined };
	const read = (name: string): string | undefined => {
		try {
			return readFile(`${certPath}/${name}`);
		} catch {
			// A missing file is not fatal: the daemon may only need the CA.
			return undefined;
		}
	};
	return { ca: read("ca.pem"), cert: read("cert.pem"), key: read("key.pem") };
}

export interface DockerRuntimeSelection {
	readonly runtime: DockerRuntime;
	readonly client: DockerClient;
	readonly fallbacks: DockerClient[];
}

/**
 * Probes the configured runtime's candidates and returns a client for the first
 * one that answers. `undefined` means no runtime is available — the caller then
 * serves the not-found/error envelope Go's noop client served instead of
 * refusing to start.
 */
export async function selectRuntime(
	configured: string,
	options: DockerClientOptions & {
		env?: Record<string, string | undefined>;
	} = {},
): Promise<DockerRuntimeSelection | undefined> {
	const name = (configured ?? "").trim().toLowerCase() || "docker";
	if (name !== "docker" && name !== "podman") {
		throw new Error(
			`unsupported DEVENV_CONTAINER_RUNTIME ${JSON.stringify(configured)} (expected docker or podman)`,
		);
	}
	const candidates = runtimeCandidates(name, options.env);
	for (const candidate of candidates) {
		const client = new DockerClient(candidate, options);
		if (await client.ping()) {
			const fallbacks: DockerClient[] = [];
			for (const other of ["docker", "podman"]) {
				if (other === name) continue;
				for (const candidate of runtimeCandidates(other, options.env)) {
					const fallback = new DockerClient(candidate, options);
					if (await fallback.ping()) {
						fallbacks.push(fallback);
						break;
					}
				}
			}
			return { runtime: candidate, client, fallbacks };
		}
	}
	return undefined;
}

// --- client ---------------------------------------------------------------

export interface DockerClientOptions {
	/** Bounded request timeout; a hung daemon must not hang a status read. */
	readonly timeoutMs?: number;
	/** Environment the host/TLS resolution reads; defaults to `process.env`. */
	readonly env?: Record<string, string | undefined>;
	/** Injectable for tests; defaults to global fetch. */
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	/** Injectable for tests. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export class DockerRequestError extends Error {
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.name = "DockerRequestError";
		this.status = status;
	}
}

export class DockerClient {
	readonly runtime: DockerRuntime;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly env: Record<string, string | undefined>;
	private readonly now: () => number;
	private cache?: { containers: ContainerSummary[]; at: number };
	private refresh?: Promise<ContainerSummary[]>;
	private readonly fallbacks: DockerClient[] = [];

	constructor(runtime: DockerRuntime, options: DockerClientOptions = {}) {
		this.runtime = runtime;
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
	}

	// --- transport ---

	private async request(
		path: string,
		init: RequestInit & { params?: Record<string, string> } = {},
		signal?: AbortSignal,
	): Promise<Response> {
		const target = parseDockerHost(this.runtime.host, this.env);
		const params = init.params;
		delete init.params;
		let query = "";
		if (params) {
			const search = new URLSearchParams();
			for (const [key, value] of Object.entries(params)) {
				search.set(key, value);
			}
			query = `?${search.toString()}`;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this.fetchImpl(`${target.url}${path}${query}`, {
				...init,
				signal: controller.signal,
				...(target.unix ? ({ unix: target.unix } as RequestInit) : {}),
				...(target.tls ? ({ tls: target.tls } as RequestInit) : {}),
			} as RequestInit);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Whether the daemon answers its ping. Never throws. */
	async ping(): Promise<boolean> {
		try {
			const response = await this.request("/_ping");
			await response.text();
			return response.ok;
		} catch {
			return false;
		}
	}

	private async requestOk(
		path: string,
		init: RequestInit & { params?: Record<string, string> } = {},
		signal?: AbortSignal,
	): Promise<Response> {
		let response: Response;
		try {
			response = await this.request(path, init, signal);
		} catch (error) {
			throw new DockerRequestError(message(error));
		}
		if (!response.ok) {
			const body = await safeText(response);
			throw new DockerRequestError(
				body.trim() === ""
					? `${init.method ?? "GET"} ${path}: ${response.status}`
					: body.trim(),
				response.status,
			);
		}
		return response;
	}

	// --- listing ---

	private async listContainers(): Promise<ContainerSummary[]> {
		const response = await this.requestOk("/containers/json", {
			params: { all: "true" },
		});
		return decodeContainerList(await response.json());
	}

	private async cachedContainers(): Promise<ContainerSummary[]> {
		if (this.cache && this.now() - this.cache.at < CONTAINER_CACHE_TTL_MS) {
			return this.cache.containers;
		}
		return this.refreshContainerCache();
	}

	private async refreshContainerCache(): Promise<ContainerSummary[]> {
		this.refresh ??= (async () => {
			const containers = await this.listContainers();
			this.cache = { containers, at: this.now() };
			return containers;
		})().finally(() => {
			this.refresh = undefined;
		});
		return this.refresh;
	}

	/** Cached list plus every attached fallback runtime's. */
	async allContainers(): Promise<ContainerSummary[]> {
		const containers = await this.cachedContainers();
		let all = containers;
		for (const fallback of this.fallbacks) {
			try {
				all = all.concat(await fallback.cachedContainers());
			} catch {
				/* a fallback that fails contributes nothing, as in Go */
			}
		}
		return all;
	}

	private async refreshAllContainers(): Promise<ContainerSummary[]> {
		const containers = await this.refreshContainerCache();
		let all = containers;
		for (const fallback of this.fallbacks) {
			try {
				all = all.concat(await fallback.refreshContainerCache());
			} catch {
				/* ignored, as in Go */
			}
		}
		return all;
	}

	attachFallback(client: DockerClient): void {
		this.fallbacks.push(client);
	}

	async refreshCache(): Promise<void> {
		await this.refreshAllContainers();
	}

	invalidateCache(): void {
		this.cache = undefined;
		for (const fallback of this.fallbacks) fallback.invalidateCache();
	}

	// --- status ---

	async getInfo(target: RuntimeTarget): Promise<DockerInfo> {
		return this.infoFor(target);
	}

	async getInfoForInfra(target: RuntimeTarget): Promise<DockerInfo> {
		return this.infoFor(target);
	}

	/** Highest-ranking matching container, or `error` when the list failed. */
	private async infoFor(target: RuntimeTarget): Promise<DockerInfo> {
		let containers: ContainerSummary[];
		try {
			containers = await this.allContainers();
		} catch {
			return { Status: "error", ContainerID: "", Ports: "" };
		}
		let best: DockerInfo = { ...INFO_NOT_FOUND };
		for (const container of containers) {
			for (const name of container.Names) {
				if (
					!containerNameMatches(name, target.ident, target.containerBaseName)
				) {
					continue;
				}
				best = preferredContainerInfo(best, {
					Status: container.State,
					ContainerID: container.Id,
					Ports: formatPorts(container),
				});
			}
		}
		return best;
	}

	/**
	 * Batch status for many targets in one pass. An unavailable daemon yields
	 * `error` for every requested target rather than an exception, so a status
	 * read still renders partial data.
	 */
	async batchGetInfo(
		apps: readonly RuntimeTarget[],
		infraServices: readonly RuntimeTarget[],
	): Promise<Map<string, DockerInfo>> {
		const results = new Map<string, DockerInfo>();
		const failedInfo: DockerInfo = {
			Status: "error",
			ContainerID: "",
			Ports: "",
		};
		const emptyInfo: DockerInfo = { ...INFO_NOT_FOUND };
		for (const target of [...apps, ...infraServices]) {
			results.set(target.ident, emptyInfo);
		}
		let containers: ContainerSummary[];
		try {
			containers = await this.allContainers();
		} catch {
			for (const target of [...apps, ...infraServices]) {
				results.set(target.ident, failedInfo);
			}
			return results;
		}
		for (const container of containers) {
			for (const name of container.Names) {
				for (const target of [...apps, ...infraServices]) {
					if (
						!containerNameMatches(name, target.ident, target.containerBaseName)
					) {
						continue;
					}
					const current = results.get(target.ident) ?? emptyInfo;
					results.set(
						target.ident,
						preferredContainerInfo(current, {
							Status: container.State,
							ContainerID: container.Id,
							Ports: formatPorts(container),
						}),
					);
				}
			}
		}
		return results;
	}

	/**
	 * Running container ids for an app, read from a fresh list: action
	 * readiness must observe containers a command just created, not the status
	 * cache from before it ran.
	 */
	async allContainerIdsForApp(target: RuntimeTarget): Promise<string[]> {
		let containers: ContainerSummary[];
		try {
			containers = await this.refreshAllContainers();
		} catch {
			return [];
		}
		const ids: string[] = [];
		for (const container of containers) {
			if (container.State !== "running") continue;
			for (const name of container.Names) {
				if (
					containerNameMatches(name, target.ident, target.containerBaseName)
				) {
					ids.push(container.Id);
				}
			}
		}
		return ids;
	}

	async getContainerInfo(containerId: string): Promise<DockerInfo> {
		let containers: ContainerSummary[];
		try {
			containers = await this.allContainers();
		} catch {
			return { Status: "error", ContainerID: "", Ports: "" };
		}
		for (const container of containers) {
			if (container.Id === containerId) {
				return {
					Status: container.State,
					ContainerID: container.Id,
					Ports: formatPorts(container),
				};
			}
		}
		return { ...INFO_NOT_FOUND };
	}

	/** Resolves a container name reported in an event. */
	async nameFromEvent(
		containerId: string,
		attributes: Record<string, string>,
	): Promise<string> {
		for (const key of [
			"name",
			"containerName",
			"io.kubernetes.container.name",
		]) {
			const value = attributes[key];
			if (value) return value;
		}
		if (containerId === "") return "";
		let containers: ContainerSummary[];
		try {
			containers = await this.cachedContainers();
		} catch {
			return containerId;
		}
		for (const container of containers) {
			if (
				container.Id === containerId ||
				container.Id.startsWith(containerId)
			) {
				for (const name of container.Names) {
					if (name) return name.replace(/^\//, "");
				}
			}
		}
		return containerId;
	}

	// --- lifecycle ---

	async getContainerLogs(containerId: string): Promise<string> {
		let response: Response;
		try {
			response = await this.requestOk(
				`/containers/${encodeURIComponent(containerId)}/logs`,
				{
					params: {
						stdout: "1",
						stderr: "1",
						timestamps: "false",
						tail: "1000",
					},
				},
			);
		} catch (error) {
			throw new Error(`failed to get container logs: ${message(error)}`);
		}
		const body = new Uint8Array(await response.arrayBuffer());
		return decodeLogFrames(body);
	}

	async startContainer(containerId: string): Promise<void> {
		await this.lifecycle(containerId, "start", () =>
			this.requestOk(`/containers/${encodeURIComponent(containerId)}/start`, {
				method: "POST",
			}),
		);
	}

	async stopContainer(containerId: string): Promise<void> {
		// Stop with a 10 second timeout for a graceful shutdown, as Go did.
		await this.lifecycle(containerId, "stop", () =>
			this.requestOk(`/containers/${encodeURIComponent(containerId)}/stop`, {
				method: "POST",
				params: { t: "10" },
			}),
		);
	}

	async restartContainer(containerId: string): Promise<void> {
		await this.lifecycle(containerId, "restart", () =>
			this.requestOk(`/containers/${encodeURIComponent(containerId)}/restart`, {
				method: "POST",
				params: { t: "10" },
			}),
		);
	}

	private async lifecycle(
		containerId: string,
		verb: string,
		run: () => Promise<Response>,
	): Promise<void> {
		try {
			await run();
		} catch (error) {
			throw new Error(
				`failed to ${verb} container ${containerId}: ${message(error)}`,
			);
		}
		this.invalidateCache();
	}

	async killAndRemoveContainer(containerId: string): Promise<void> {
		try {
			await this.requestOk(
				`/containers/${encodeURIComponent(containerId)}/kill`,
				{
					method: "POST",
					params: { signal: "SIGKILL" },
				},
			);
		} catch (error) {
			throw new Error(
				`failed to kill container ${containerId}: ${message(error)}`,
			);
		}
		try {
			await this.requestOk(`/containers/${encodeURIComponent(containerId)}`, {
				method: "DELETE",
				params: { force: "true" },
			});
		} catch (error) {
			throw new Error(
				`failed to remove container ${containerId}: ${message(error)}`,
			);
		}
		this.invalidateCache();
	}

	async killAndRemoveAllContainersForApp(target: RuntimeTarget): Promise<void> {
		const ids = await this.allContainerIdsForApp(target);
		if (ids.length === 0) {
			throw new Error(`no containers found for app ${target.ident}`);
		}
		const errors: string[] = [];
		for (const id of ids) {
			try {
				await this.killAndRemoveContainer(id);
			} catch (error) {
				errors.push(message(error));
			}
		}
		if (errors.length > 0) {
			throw new Error(`failed to remove some containers: ${errors.join("; ")}`);
		}
	}

	async killAllRunningContainers(
		apps: readonly RuntimeTarget[],
		infraServices: readonly RuntimeTarget[],
	): Promise<void> {
		const running: string[] = [];
		for (const app of apps) {
			for (const id of await this.allContainerIdsForApp(app)) {
				const info = await this.getContainerInfo(id);
				if (info.Status === "running") running.push(id);
			}
		}
		for (const infra of infraServices) {
			const info = await this.getInfoForInfra(infra);
			if (info.Status === "running" && info.ContainerID !== "") {
				running.push(info.ContainerID);
			}
		}
		if (running.length === 0) return;
		const errors: string[] = [];
		let success = 0;
		for (const id of running) {
			try {
				await this.killAndRemoveContainer(id);
				success++;
			} catch (error) {
				errors.push(`${id}: ${message(error)}`);
			}
		}
		if (errors.length > 0) {
			throw new Error(
				`failed to kill/remove some containers (${success}/${running.length} successful): ${errors.join("; ")}`,
			);
		}
	}

	// --- observation ---

	/** Inspects a container's state; used by the health readiness gate. */
	async inspect(containerName: string): Promise<{
		state: {
			running?: boolean;
			health?: { status?: string };
		};
	}> {
		const response = await this.requestOk(
			`/containers/${encodeURIComponent(containerName)}/json`,
		);
		const raw = (await response.json()) as { State?: Record<string, unknown> };
		const state = raw.State ?? {};
		const health = state.Health as { Status?: string } | undefined;
		return {
			state: {
				running: state.Running === true,
				...(health ? { health: { status: health.Status ?? "" } } : {}),
			},
		};
	}

	/**
	 * Waits until a container is healthy (or running without a healthcheck).
	 * Returns the reason it is not ready instead of a boolean, so a caller can
	 * report *why* a startup failed.
	 */
	async waitForHealthy(
		containerName: string,
		timeoutMs = 60_000,
		signal?: AbortSignal,
		update?: (status: string) => void,
		pollMs = 2000,
	): Promise<void> {
		const effective = timeoutMs > 0 ? timeoutMs : 60_000;
		const deadline = this.now() + effective;
		let last = "";
		const report = (status: string): void => {
			if (update && status !== last) {
				update(status);
				last = status;
			}
		};
		for (;;) {
			let inspected: {
				state: { running?: boolean; health?: { status?: string } };
			};
			try {
				inspected = await this.inspect(containerName);
			} catch (error) {
				report(`inspect error: ${message(error)}`);
				throw error;
			}
			const state = inspected.state;
			let ready = false;
			if (!state.health) {
				if (state.running) {
					report("running (no healthcheck)");
					ready = true;
				} else {
					report("waiting for running");
				}
			} else {
				const status = state.health.status ?? "";
				report(`health: ${status}`);
				if (status === "healthy") ready = true;
				if (status === "unhealthy") {
					throw new Error(
						`container ${JSON.stringify(containerName)} is unhealthy`,
					);
				}
			}
			if (ready) return;
			if (this.now() >= deadline) {
				throw new Error(
					`container ${JSON.stringify(containerName)} readiness timeout after ${effective}ms`,
				);
			}
			await sleepWithSignal(Math.min(pollMs, deadline - this.now()), signal);
		}
	}

	/**
	 * Opens the container's event stream. One attempt: the caller owns the
	 * reconnect/backoff loop so a shutdown during backoff schedules nothing.
	 */
	async *events(containerId?: string): AsyncGenerator<ContainerEvent> {
		const filters: Record<string, string[]> = {
			type: ["container"],
			event: [
				"start",
				"stop",
				"die",
				"kill",
				"restart",
				"pause",
				"unpause",
				"oom",
			],
		};
		if (containerId) filters.container = [containerId];
		const response = await this.requestOk("/events", {
			params: { filters: JSON.stringify(filters) },
		});
		const body = response.body;
		if (!body) throw new DockerRequestError("event stream has no body");
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of body) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line === "") continue;
				const event = decodeEvent(line);
				if (!event) continue;
				const actor = decodeEventActor(line);
				// Container state changed: the next status read must be fresh.
				this.invalidateCache();
				yield {
					...event,
					containerName: await this.nameFromEvent(
						actor.containerId,
						actor.attributes,
					),
				};
			}
		}
	}

	/** One stats stream attempt; the caller cancels by aborting. */
	async *stats(
		containerId: string,
		signal?: AbortSignal,
	): AsyncGenerator<ContainerStatsEntry> {
		const response = await this.requestOk(
			`/containers/${encodeURIComponent(containerId)}/stats`,
			{ params: { stream: "1" } },
			signal,
		);
		const body = response.body;
		if (!body) throw new DockerRequestError("stats stream has no body");
		let buffer = "";
		let first = true;
		const decoder = new TextDecoder();
		for await (const chunk of body) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line === "") continue;
				const frame = JSON.parse(line) as StatsFrame;
				// The first frame has zeroed precpu_stats, so its CPU% is garbage.
				if (first) {
					first = false;
					continue;
				}
				const { usage, limit, percent } = calculateMemoryUsage(frame);
				yield {
					cpuPercent: calculateCPUPercent(frame),
					memoryUsage: usage,
					memoryLimit: limit,
					memoryPercent: percent,
					timestamp: new Date(this.now()).toISOString(),
				};
			}
		}
	}

	/** One log stream attempt: follow mode, line delimited, TTY tolerant. */
	async *logLines(
		containerId: string,
		tail = "100",
		signal?: AbortSignal,
	): AsyncGenerator<string> {
		const response = await this.requestOk(
			`/containers/${encodeURIComponent(containerId)}/logs`,
			{
				params: {
					stdout: "1",
					stderr: "1",
					timestamps: "false",
					follow: "1",
					tail: tail === "" ? "100" : tail,
				},
			},
			signal,
		);
		const body = response.body;
		if (!body) throw new DockerRequestError("log stream has no body");
		const frames = demuxFrames(body);
		let pending = "";
		for await (const text of frames) {
			pending += text;
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				yield pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
		if (pending !== "") yield pending.replace(/\r$/, "");
	}
}

// --- event listener -------------------------------------------------------

export interface EventListenerOptions {
	readonly client: DockerClient;
	readonly onEvent: (event: ContainerEvent) => void;
	readonly logger?: (message: string) => void;
	readonly signal: AbortSignal;
	readonly backoffMs?: number;
	readonly maxBackoffMs?: number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** How many reconnect attempts an event listener made, for tests/observability. */
export interface EventListenerHandle {
	readonly reconnects: () => number;
}

/**
 * Subscribes to the runtime's event stream for as long as `signal` is live,
 * reconnecting with doubling backoff. A shutdown during backoff or during an
 * active stream stops the loop and schedules no further reconnect.
 */
export function startEventListener(
	options: EventListenerOptions,
): EventListenerHandle {
	let reconnects = 0;
	const sleep = options.sleep ?? sleepUntilAborted;
	let backoff = options.backoffMs ?? 1000;
	const maxBackoff = options.maxBackoffMs ?? 30_000;
	const controller = new AbortController();
	options.signal.addEventListener("abort", () => controller.abort(), {
		once: true,
	});
	void (async () => {
		while (!options.signal.aborted) {
			try {
				for await (const event of options.client.events()) {
					if (options.signal.aborted) return;
					options.onEvent(event);
				}
			} catch (error) {
				if (options.signal.aborted) return;
				options.logger?.(
					`[Docker] Event stream error: ${message(error)} – reconnecting in ${backoff}ms`,
				);
			}
			if (options.signal.aborted) return;
			reconnects++;
			backoff = options.backoffMs ?? 1000;
			for (let i = 1; i < reconnects; i++) {
				backoff = Math.min(backoff * 2, maxBackoff);
			}
			await sleep(backoff, options.signal);
			if (options.signal.aborted) return;
		}
	})();
	return { reconnects: () => reconnects };
}

// --- prune ----------------------------------------------------------------

/** `system prune` arguments: stopped containers, unused networks, dangling
 * images and build cache older than a day. Never `--all`: tagged application
 * images loaded into kind have no container and survive. */
export function containerPruneArgs(): string[] {
	return ["system", "prune", "--force", "--filter", "until=24h"];
}

export interface PruneOptions {
	/** Runs one argv; injectable so a test observes the commands. */
	readonly runCommand: (
		command: string,
		args: string[],
	) => Promise<{ error?: Error; output: string }>;
	readonly logger?: (message: string) => void;
}

/** Prunes every installed container runtime. A runtime that is not installed is
 * skipped; its failure never aborts the other runtime. */
export async function runSystemPrune(options: PruneOptions): Promise<void> {
	options.logger?.("[Prune] Pruning container artifacts for all runtimes...");
	for (const runtime of ["docker", "podman"]) {
		const version = await options.runCommand(runtime, ["version"]);
		if (version.error) continue;
		options.logger?.(`[Prune] Pruning ${runtime}...`);
		const pruned = await options.runCommand(runtime, containerPruneArgs());
		if (pruned.error) {
			options.logger?.(
				`[Prune] ${runtime} system prune failed: ${pruned.error.message}`,
			);
		}
	}
}

/** The CLI prune poller: once after the startup delay, then every interval. */
export function startPrunePoller(options: {
	readonly signal: AbortSignal;
	readonly runCommand: PruneOptions["runCommand"];
	readonly logger?: (message: string) => void;
	readonly startupDelayMs?: number;
	readonly intervalMs?: number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): void {
	const sleep = options.sleep ?? sleepUntilAborted;
	const interval = options.intervalMs ?? 24 * 60 * 60 * 1000;
	const startupDelay = options.startupDelayMs ?? 5000;
	void (async () => {
		await sleep(startupDelay, options.signal);
		if (options.signal.aborted) return;
		await runSystemPrune(options);
		for (;;) {
			await sleep(interval, options.signal);
			if (options.signal.aborted) return;
			await runSystemPrune(options);
		}
	})();
}

/** Default CLI runner for prune and kind node stats. */
export function spawnCommandRunner(): (
	command: string,
	args: string[],
) => Promise<{ error?: Error; output: string }> {
	return (command, args) =>
		new Promise((resolve) => {
			const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.on("error", (error) => resolve({ error, output }));
			child.on("close", (code) => {
				if (code === 0) return resolve({ output: output.trim() });
				resolve({
					error: new Error(
						`${command} ${args.join(" ")}: exit ${code ?? "null"}`,
					),
					output,
				});
			});
		});
}

// --- pure helpers ---------------------------------------------------------

/** Whether a container name belongs to a target. */
export function containerNameMatches(
	name: string,
	ident: string,
	containerBaseName: string,
): boolean {
	const cleanName = name.replace(/^\//, "");
	const baseName = cleanName.replace(/[-_]\d+$/, "");
	const matches = [
		containerBaseName,
		ident,
		`devenv-${ident}`,
		`devenv_${ident}`,
	];
	for (const match of matches) {
		if (match === "") continue;
		const normalizedMatch = normalizeContainerName(match);
		const normalizedName = normalizeContainerName(cleanName);
		const normalizedBase = normalizeContainerName(baseName);
		if (
			cleanName === match ||
			baseName === match ||
			normalizedName === normalizedMatch ||
			normalizedBase === normalizedMatch ||
			normalizedBase.endsWith(`-${normalizedMatch}`)
		) {
			return true;
		}
	}
	return false;
}

export function normalizeContainerName(name: string): string {
	return name.replace(/_/g, "-");
}

export function preferredContainerInfo(
	current: DockerInfo,
	candidate: DockerInfo,
): DockerInfo {
	return containerStatusRank(candidate.Status) >
		containerStatusRank(current.Status)
		? candidate
		: current;
}

export function containerStatusRank(status: string): number {
	switch (status.toLowerCase()) {
		case "running":
			return 100;
		case "restarting":
			return 90;
		case "paused":
			return 80;
		case "created":
			return 70;
		case "exited":
		case "dead":
		case "removing":
			return 10;
		case "not found":
		case "":
			return 0;
		case "error":
			return -1;
		default:
			return 50;
	}
}

/** `8080->80/tcp, 5432/tcp`, first occurrence of each pair only. */
export function formatPorts(container: ContainerSummary): string {
	if (container.Ports.length === 0) return "";
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const port of container.Ports) {
		const text =
			port.PublicPort && port.PublicPort !== 0
				? `${port.PublicPort}->${port.PrivatePort}/${port.Type}`
				: `${port.PrivatePort}/${port.Type}`;
		if (seen.has(text)) continue;
		seen.add(text);
		parts.push(text);
	}
	return parts.join(", ");
}

/** CPU percentage, skipping the first frame whose `precpu_stats` is zeroed. */
export function calculateCPUPercent(frame: StatsFrame): number {
	const previousCpu = frame.precpu_stats?.cpu_usage?.total_usage ?? 0;
	const previousSystem = frame.precpu_stats?.system_cpu_usage ?? 0;
	if (previousCpu === 0 && previousSystem === 0) return 0;
	const cpuDelta = (frame.cpu_stats?.cpu_usage?.total_usage ?? 0) - previousCpu;
	const systemDelta = (frame.cpu_stats?.system_cpu_usage ?? 0) - previousSystem;
	if (systemDelta <= 0 || cpuDelta < 0) return 0;
	let cpus = frame.cpu_stats?.online_cpus ?? 0;
	if (cpus === 0) {
		cpus = frame.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 0;
	}
	if (cpus === 0) cpus = 1;
	return Math.min((cpuDelta / systemDelta) * 100, 100);
}

/** Memory usage with cgroup v2 `inactive_file`, then v1 `cache`, then raw. */
export function calculateMemoryUsage(frame: StatsFrame): {
	usage: number;
	limit: number;
	percent: number;
} {
	const limit = frame.memory_stats?.limit ?? 0;
	const raw = frame.memory_stats?.usage ?? 0;
	const stats = frame.memory_stats?.stats ?? {};
	const inactiveFile = stats.inactive_file ?? 0;
	const cache = stats.cache ?? 0;
	let usage = raw;
	if (inactiveFile > 0) {
		usage = raw > inactiveFile ? raw - inactiveFile : raw;
	} else if (cache > 0) {
		usage = raw > cache ? raw - cache : raw;
	}
	const percent = limit > 0 ? (usage / limit) * 100 : 0;
	return { usage, limit, percent };
}

export interface StatsFrame {
	precpu_stats?: StatsSection;
	cpu_stats?: StatsSection;
	memory_stats?: {
		limit?: number;
		usage?: number;
		stats?: Record<string, number>;
	};
}

interface StatsSection {
	system_cpu_usage?: number;
	online_cpus?: number;
	cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
}

/** Decodes a Docker event JSON line. */
export function decodeEvent(line: string): ContainerEvent | undefined {
	let raw: {
		Action?: string;
		time?: number;
		timeNano?: number;
		Actor?: { ID?: string; Attributes?: Record<string, string> };
	};
	try {
		raw = JSON.parse(line) as typeof raw;
	} catch {
		return undefined;
	}
	const action = raw.Action ?? "";
	if (action === "") return undefined;
	const seconds = raw.time ?? 0;
	return {
		containerId: raw.Actor?.ID ?? "",
		containerName: "",
		action,
		time: new Date(seconds * 1000),
	};
}

/** Exposes the actor attributes a caller needs to resolve a container name. */
export function decodeEventActor(line: string): {
	containerId: string;
	attributes: Record<string, string>;
} {
	try {
		const raw = JSON.parse(line) as {
			Actor?: { ID?: string; Attributes?: Record<string, string> };
		};
		return {
			containerId: raw.Actor?.ID ?? "",
			attributes: raw.Actor?.Attributes ?? {},
		};
	} catch {
		return { containerId: "", attributes: {} };
	}
}

export function decodeContainerList(value: unknown): ContainerSummary[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		const raw = entry as {
			Id?: string;
			Names?: string[];
			State?: string;
			Ports?: { PrivatePort?: number; PublicPort?: number; Type?: string }[];
		};
		return {
			Id: raw.Id ?? "",
			Names: raw.Names ?? [],
			State: raw.State ?? "",
			Ports: (raw.Ports ?? []).map((port) => ({
				PrivatePort: port.PrivatePort ?? 0,
				...(port.PublicPort === undefined
					? {}
					: { PublicPort: port.PublicPort }),
				Type: port.Type ?? "",
			})),
		};
	});
}

/**
 * Demultiplexes Docker's 8-byte-framed log stream. A TTY container streams raw
 * bytes, which have no valid header, so the body is passed through unchanged.
 */
export function decodeLogFrames(body: Uint8Array): string {
	const decoder = new TextDecoder();
	let offset = 0;
	let framed = false;
	if (body.length >= 8 && (body[0] === 0 || body[0] === 1 || body[0] === 2)) {
		const size = (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7];
		framed = size >= 0 && size <= body.length - 8;
	}
	if (!framed) return decoder.decode(body);
	let out = "";
	while (offset + 8 <= body.length) {
		const size =
			(body[offset + 4] << 24) |
			(body[offset + 5] << 16) |
			(body[offset + 6] << 8) |
			body[offset + 7];
		if (offset + 8 + size > body.length) {
			out += decoder.decode(body.slice(offset + 8));
			return out;
		}
		out += decoder.decode(body.slice(offset + 8, offset + 8 + size));
		offset += 8 + size;
	}
	return out;
}

/** Streams a framed-or-raw log body as text chunks. */
export async function* demuxFrames(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const pending: number[] = [];
	let framed: boolean | undefined;
	for await (const chunk of body) {
		pending.push(...chunk);
		if (framed === undefined && pending.length >= 8) {
			framed =
				(pending[0] === 0 || pending[0] === 1 || pending[0] === 2) &&
				pending[1] === 0 &&
				pending[2] === 0 &&
				pending[3] === 0;
		}
		if (framed === undefined) continue;
		if (!framed) {
			yield decoder.decode(new Uint8Array(pending.splice(0)));
			continue;
		}
		for (;;) {
			if (pending.length < 8) break;
			const size =
				(pending[4] << 24) |
				(pending[5] << 16) |
				(pending[6] << 8) |
				pending[7];
			if (pending.length < 8 + size) break;
			const frame = new Uint8Array(pending.splice(0, 8 + size).slice(8));
			yield decoder.decode(frame);
		}
	}
	if (framed === false && pending.length > 0) {
		yield decoder.decode(new Uint8Array(pending));
	} else if (framed === true && pending.length > 8) {
		yield decoder.decode(new Uint8Array(pending.slice(8)));
	}
}

// --- internal -------------------------------------------------------------

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/** Sleeps, resolving (never rejecting) when the signal aborts: a poller or
 * reconnect loop must observe the abort and return, not fail with it. */
export function sleepUntilAborted(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
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

export function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	return reason instanceof Error ? reason : new Error("aborted");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
