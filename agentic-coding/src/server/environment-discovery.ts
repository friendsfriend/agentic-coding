// The running unified server's discovery handoff (fix-env-tools-for-all-runs):
// the file the server publishes under the configuration root so a process that
// is **not** the server can find it and derive the same owner-scoped agent
// environment capability for the runs it launches.
//
// `environmentRunEnv` (agent-host/environment-capability.ts) used to depend on
// an in-process publication, which only the unified server's composition root
// makes. Every other process that builds a run environment — the CLI's
// `workflow start`/`workflow drain`, the per-repository `agent host` that drains
// a workflow whose store lives in another repository, a workflow of a repository
// other than the one the shell was started for — therefore handed its runs no
// `AGENTIC_ENV_URL`/`AGENTIC_ENV_TOKEN`, so the `env_*`, `browser_*` and debug
// tools of those runs had no capability at all.
//
// The file carries the instance token, so it is written mode 0600, replaced
// atomically, removed on shutdown, and never trusted blindly: a reader refuses a
// record whose URL is not loopback, whose file is readable by anyone but its
// owner, whose process is gone, or whose server does not answer `/api/health`
// with the recorded instance. It is a handoff mechanism like
// `instanceTokenFile` (`auth.ts`) — not an authorization bypass: the run itself
// still receives only the capability derived for its own owner.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceTokenFileForUrl } from "./auth.ts";

/** Name of the discovery file inside the configuration root. */
export const ENVIRONMENT_DISCOVERY_FILE = "environment-server.json";
/** Format version of the record; a version this build does not know is ignored. */
export const ENVIRONMENT_DISCOVERY_VERSION = 1;
/** How long one liveness probe may take before the record is treated as stale. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export interface EnvironmentDiscoveryRecord {
	readonly version: number;
	readonly url: string;
	readonly token: string;
	readonly instance: string;
	readonly pid: number;
}

/** The discovery file of one configuration root. */
export function environmentDiscoveryFile(configDir: string): string {
	return path.join(configDir, ENVIRONMENT_DISCOVERY_FILE);
}

/**
 * Publish the running server under `configDir`, atomically and mode 0600.
 * Returns the path, or undefined when the file could not be written — a server
 * that cannot publish its endpoint still serves; only runs launched by another
 * process lose the capability.
 */
export function publishEnvironmentDiscovery(
	configDir: string,
	server: Omit<EnvironmentDiscoveryRecord, "version">,
): string | undefined {
	const file = environmentDiscoveryFile(configDir);
	const record: EnvironmentDiscoveryRecord = {
		version: ENVIRONMENT_DISCOVERY_VERSION,
		url: server.url,
		token: server.token,
		instance: server.instance,
		pid: server.pid,
	};
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
		return file;
	} catch {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		return undefined;
	}
}

/**
 * Remove the discovery file on shutdown, but only while it still names this
 * server: a second server that published after this one keeps its record.
 */
export function removeEnvironmentDiscovery(
	configDir: string,
	token: string,
): void {
	const file = environmentDiscoveryFile(configDir);
	const record = readEnvironmentDiscoveryRecord(file);
	if (!record || record.token !== token) return;
	try {
		fs.unlinkSync(file);
	} catch {}
}

/** Parse one record without trusting any field: a malformed, oversized, or
 * non-loopback record is no record. */
function readEnvironmentDiscoveryRecord(
	file: string,
): EnvironmentDiscoveryRecord | undefined {
	let stat: fs.Stats;
	try {
		// `lstat`, not `stat`: a symbolic link is never the server's own file, and
		// the mode check below is about the file a reader would open.
		stat = fs.lstatSync(file);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
	// The file carries the instance token: a record any other user can read (or
	// write) is refused rather than trusted.
	if ((stat.mode & 0o077) !== 0) return undefined;
	if (stat.size > 8192) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const url = record.url;
	const token = record.token;
	const instance = record.instance;
	const pid = record.pid;
	if (record.version !== ENVIRONMENT_DISCOVERY_VERSION) return undefined;
	if (typeof url !== "string" || typeof token !== "string") return undefined;
	if (typeof instance !== "string" || instance.trim() === "") return undefined;
	if (!token.trim()) return undefined;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
		return undefined;
	// Loopback only: an endpoint anywhere else is not this machine's server, and
	// the capability derived from it would be sent off the machine.
	if (instanceTokenFileForUrl(url) === undefined) return undefined;
	return { version: ENVIRONMENT_DISCOVERY_VERSION, url, token, instance, pid };
}

/** Whether the process that published the record still exists. A recycled pid
 * cannot produce a matching instance on the liveness probe below, so this is a
 * cheap pre-filter rather than the whole validation. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "EPERM"
		);
	}
}

export interface DiscoverEnvironmentServerOptions {
	readonly configDir: string;
	readonly timeoutMs?: number;
	/** Test seam: the transport the probe uses. */
	readonly fetch?: typeof fetch;
}

/**
 * Discover the server a reader may act through: the published record, validated
 * by process liveness and by its own health route. Returns undefined when there
 * is no record, when the record is stale (a dead process or a server that does
 * not answer), or when the answering server is not the one the record names.
 */
export async function discoverEnvironmentServer(
	options: DiscoverEnvironmentServerOptions,
): Promise<{ readonly url: string; readonly token: string } | undefined> {
	const record = readEnvironmentDiscoveryRecord(
		environmentDiscoveryFile(options.configDir),
	);
	if (!record) return undefined;
	if (!processAlive(record.pid)) return undefined;
	const send = options.fetch ?? fetch;
	let response: Response;
	try {
		response = await send(`${record.url}/api/health`, {
			method: "GET",
			signal: AbortSignal.timeout(
				options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
			),
		});
	} catch {
		return undefined;
	}
	if (!response.ok) return undefined;
	const health = (await response.json().catch(() => undefined)) as
		| { instance?: unknown; pid?: unknown }
		| undefined;
	// The instance id is what distinguishes this server process on a shared
	// loopback port; the pid is the same identity from the other side.
	if (health?.instance !== record.instance) return undefined;
	if (typeof health.pid === "number" && health.pid !== record.pid)
		return undefined;
	return { url: record.url, token: record.token };
}
