// Metadata only: native pi-durable remains the sole transcript store.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	currentPiDurableSessionName,
	piDurableSessionFile,
} from "./pi-durable-state.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
	trySecureFileLock,
} from "./workflow/secure-fs.ts";

export interface DurableSessionRecord {
	readonly id: string;
	readonly operationId: string;
	readonly owner: string;
	readonly name: string;
	readonly runId: string;
	readonly cwd: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly toolPolicy?: "default" | "collection";
	readonly gitlabHosts?: readonly string[];
	readonly gitlabToolHost?: string;
	readonly repositoryRoots?: readonly string[];
	readonly createdAt: number;
	readonly binding?: {
		readonly hostId: string;
		readonly conversationId: string;
	};
	readonly deletedAt?: number;
}
export interface DurableSessionRegistry {
	readonly version: 1;
	readonly activeId: string | null;
	readonly sessions: readonly DurableSessionRecord[];
}
export function durableSessionOwner(): string {
	if (typeof process.getuid !== "function")
		throw new Error("Durable session custody requires an OS user identity.");
	return `uid:${process.getuid()}`;
}
export function durableSessionRegistryFile(runtimeDir: string): string {
	return path.join(runtimeDir, "sessions.json");
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function decode(value: unknown): DurableSessionRegistry {
	if (!object(value) || value.version !== 1 || !Array.isArray(value.sessions))
		throw new Error(
			"Unsupported or corrupt durable session registry; no migration or replacement attempted.",
		);
	const ids = new Set<string>();
	const operations = new Set<string>();
	const runs = new Set<string>();
	const bindings = new Set<string>();
	for (const item of value.sessions) {
		if (
			!object(item) ||
			!text(item.id) ||
			!text(item.operationId) ||
			!text(item.owner) ||
			!text(item.name) ||
			!text(item.cwd) ||
			!path.isAbsolute(item.cwd) ||
			!text(item.runId) ||
			!/^pi-durable[\w-]*$/.test(item.runId) ||
			typeof item.createdAt !== "number" ||
			!Number.isFinite(item.createdAt) ||
			(item.deletedAt !== undefined &&
				(typeof item.deletedAt !== "number" ||
					!Number.isFinite(item.deletedAt))) ||
			(item.model !== undefined && !text(item.model)) ||
			(item.thinking !== undefined && !text(item.thinking)) ||
			(item.toolPolicy !== undefined &&
				item.toolPolicy !== "default" &&
				item.toolPolicy !== "collection") ||
			(item.repositoryRoots !== undefined &&
				(!Array.isArray(item.repositoryRoots) ||
					item.repositoryRoots.some(
						(root: unknown) =>
							!text(root) ||
							!path.isAbsolute(root) ||
							path.parse(root).root === path.resolve(root),
					))) ||
			(item.gitlabToolHost !== undefined &&
				(typeof item.gitlabToolHost !== "string" ||
					!/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/.test(
						item.gitlabToolHost,
					))) ||
			(item.gitlabHosts !== undefined &&
				(!Array.isArray(item.gitlabHosts) ||
					item.gitlabHosts.some(
						(host: unknown) =>
							!text(host) || !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(host),
					))) ||
			(item.binding !== undefined &&
				(!object(item.binding) ||
					!text(item.binding.hostId) ||
					!text(item.binding.conversationId))) ||
			ids.has(item.id) ||
			operations.has(item.operationId) ||
			runs.has(item.runId) ||
			(object(item.binding) &&
				bindings.has(
					JSON.stringify([item.binding.hostId, item.binding.conversationId]),
				))
		)
			throw new Error(
				"Corrupt durable session registry entry; no replacement attempted.",
			);
		ids.add(item.id);
		operations.add(item.operationId);
		runs.add(item.runId);
		if (object(item.binding))
			bindings.add(
				JSON.stringify([item.binding.hostId, item.binding.conversationId]),
			);
	}
	if (
		value.activeId !== null &&
		(!text(value.activeId) || !ids.has(value.activeId))
	)
		throw new Error("Invalid durable session selection.");
	return value as unknown as DurableSessionRegistry;
}
export function readDurableSessionRegistry(
	runtimeDir: string,
): DurableSessionRegistry | undefined {
	let directory: number | undefined;
	let descriptor: number | undefined;
	try {
		// Only an actual filesystem ENOENT here means a fresh installation;
		// secure-open errors (including symlinks/races) always fail closed.
		fs.lstatSync(durableSessionRegistryFile(runtimeDir));
		directory = openSecureDirectory(
			runtimeDir,
			path.dirname(runtimeDir),
			false,
		);
		descriptor = openSecureFile(
			directory,
			"sessions.json",
			fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
		);
		const stat = fs.fstatSync(descriptor);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > 2_000_000
		)
			throw new Error("Unsafe durable session registry metadata.");
		return decode(JSON.parse(fs.readFileSync(descriptor, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		if (directory !== undefined) closeSecureDirectory(directory);
	}
}
function write(runtimeDir: string, value: DurableSessionRegistry): void {
	decode(value);
	const content = JSON.stringify(value);
	if (Buffer.byteLength(content) > 2_000_000)
		throw new Error("Durable session registry exceeds metadata budget.");
	const file = durableSessionRegistryFile(runtimeDir);
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		const descriptor = fs.openSync(temporary, "wx", 0o600);
		try {
			fs.writeFileSync(descriptor, content);
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		fs.renameSync(temporary, file);
		const directory = fs.openSync(runtimeDir, "r");
		try {
			fs.fsyncSync(directory);
		} finally {
			fs.closeSync(directory);
		}
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// An orphan temporary file is not authoritative. Preserve any
			// original write/fsync failure rather than masking it with cleanup.
		}
	}
}
/** Synchronous metadata transactions never span host/network I/O. A competing
 * process fails visibly and can retry; it cannot overwrite another selection. */
export function updateDurableSessionRegistry<T>(
	runtimeDir: string,
	change: (value: DurableSessionRegistry | undefined) => {
		registry: DurableSessionRegistry;
		result: T;
	},
): T {
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const directory = openSecureDirectory(runtimeDir, path.dirname(runtimeDir));
	let descriptor: number | undefined;
	try {
		descriptor = trySecureFileLock(directory, "sessions.lock");
	} catch (error) {
		closeSecureDirectory(directory);
		throw error;
	}
	if (descriptor === undefined) {
		closeSecureDirectory(directory);
		throw new Error(
			"Durable session registry is locked; retry after the current metadata operation completes. Never retarget a locked session.",
		);
	}
	try {
		const next = change(readDurableSessionRegistry(runtimeDir));
		write(runtimeDir, next.registry);
		return next.result;
	} finally {
		fs.closeSync(descriptor);
		closeSecureDirectory(directory);
	}
}
export function requireDurableSession(
	registry: DurableSessionRegistry,
	id: string,
	owner: string,
): DurableSessionRecord {
	const record = registry.sessions.find((session) => session.id === id);
	if (!record || record.deletedAt !== undefined)
		throw new Error(
			"Durable session is deleted or unavailable; no replacement was created.",
		);
	if (record.owner !== owner)
		throw new Error("Durable session custody denied.");
	return record;
}
/** Adopts only metadata. Legacy session.json and every native document remain
 * untouched. The first host open binds the adopted name to its native id. */
export function initializeDurableSessions(
	runtimeDir: string,
	cwd: string,
	owner: string,
): DurableSessionRegistry {
	return updateDurableSessionRegistry(runtimeDir, (existing) => {
		if (existing) return { registry: existing, result: existing };
		const runId = currentPiDurableSessionName(runtimeDir);
		if (!runId)
			throw new Error("Cannot adopt unreadable legacy session metadata.");
		const legacy = fs.existsSync(piDurableSessionFile(runtimeDir));
		const id = randomUUID();
		const registry: DurableSessionRegistry = {
			version: 1,
			activeId: id,
			sessions: [
				{
					id,
					operationId: legacy ? "legacy-adoption" : "first-session",
					owner,
					name: "Pi Durable",
					runId,
					cwd: path.resolve(cwd),
					createdAt: Date.now(),
				},
			],
		};
		return { registry, result: registry };
	});
}
export function createDurableSession(
	runtimeDir: string,
	input: {
		operationId: string;
		owner: string;
		name: string;
		cwd: string;
		model?: string;
		thinking?: string;
		toolPolicy?: "default" | "collection";
		gitlabHosts?: readonly string[];
		gitlabToolHost?: string;
		repositoryRoots?: readonly string[];
	},
): DurableSessionRecord {
	if (
		!text(input.operationId) ||
		!text(input.name) ||
		input.name.length > 120 ||
		!text(input.owner)
	)
		throw new Error("Invalid durable session creation input.");
	return updateDurableSessionRegistry(runtimeDir, (registry) => {
		if (!registry)
			throw new Error(
				"Initialize durable session registry before creating sessions.",
			);
		const prior = registry.sessions.find(
			(record) => record.operationId === input.operationId,
		);
		if (prior) {
			requireDurableSession(registry, prior.id, input.owner);
			if (
				prior.name !== input.name ||
				prior.cwd !== path.resolve(input.cwd) ||
				prior.model !== input.model ||
				prior.thinking !== input.thinking ||
				prior.toolPolicy !== input.toolPolicy ||
				prior.gitlabToolHost !== input.gitlabToolHost ||
				JSON.stringify(prior.gitlabHosts) !==
					JSON.stringify(input.gitlabHosts) ||
				JSON.stringify(prior.repositoryRoots) !==
					JSON.stringify(input.repositoryRoots)
			)
				throw new Error(
					"Session creation identity was reused with different settings.",
				);
			return { registry, result: prior };
		}
		const record: DurableSessionRecord = {
			...input,
			id: randomUUID(),
			runId: `pi-durable-${randomUUID()}`,
			cwd: path.resolve(input.cwd),
			createdAt: Date.now(),
		};
		return {
			registry: { ...registry, sessions: [...registry.sessions, record] },
			result: record,
		};
	});
}
export function selectDurableSession(
	runtimeDir: string,
	id: string,
	owner: string,
): void {
	updateDurableSessionRegistry(runtimeDir, (registry) => {
		if (!registry) throw new Error("Durable session registry unavailable.");
		requireDurableSession(registry, id, owner);
		return { registry: { ...registry, activeId: id }, result: undefined };
	});
}
export function bindDurableSession(
	runtimeDir: string,
	id: string,
	owner: string,
	binding: NonNullable<DurableSessionRecord["binding"]>,
): void {
	updateDurableSessionRegistry(runtimeDir, (registry) => {
		if (!registry) throw new Error("Durable session registry unavailable.");
		const record = requireDurableSession(registry, id, owner);
		if (
			record.binding &&
			(record.binding.hostId !== binding.hostId ||
				record.binding.conversationId !== binding.conversationId)
		)
			throw new Error("Durable session binding changed; refusing replacement.");
		return {
			registry: {
				...registry,
				sessions: registry.sessions.map((session) =>
					session.id === id ? { ...session, binding } : session,
				),
			},
			result: undefined,
		};
	});
}
export function deleteDurableSession(
	runtimeDir: string,
	id: string,
	owner: string,
): void {
	updateDurableSessionRegistry(runtimeDir, (registry) => {
		if (!registry) throw new Error("Durable session registry unavailable.");
		requireDurableSession(registry, id, owner);
		return {
			registry: {
				...registry,
				activeId: registry.activeId === id ? null : registry.activeId,
				sessions: registry.sessions.map((session) =>
					session.id === id ? { ...session, deletedAt: Date.now() } : session,
				),
			},
			result: undefined,
		};
	});
}
