import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import {
	auxiliaryPath,
	type Draft,
	type SourceDraft,
} from "./definition-draft-data.ts";
import {
	definitionByteLimit,
	definitionProjectLimit,
	definitionTargetLimit,
} from "./definition-limits.ts";
import { within } from "./path-within.ts";

const limit = definitionByteLimit,
	name = "environments.json",
	lockName = `.${name}.lock`;
function directoryIdentity(config: Config) {
	const directory = fs.realpathSync(config.configDir),
		stat = fs.lstatSync(directory);
	if (!stat.isDirectory())
		throw new Error("Live configuration directory is unavailable");
	return {
		directory,
		directoryDigest: digest(
			JSON.stringify({ directory, dev: stat.dev, ino: stat.ino }),
		),
	};
}
function sameDirectory(config: Config, expected: string) {
	if (directoryIdentity(config).directoryDigest !== expected)
		throw new Error("Live configuration directory identity changed");
}
/** Reads the live destination without following links; never creates or writes. */
export function inspectDestination(config: Config) {
	const { directory, directoryDigest } = directoryIdentity(config),
		destination = path.join(directory, name);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			sameDirectory(config, directoryDigest);
			return {
				destination,
				directoryDigest,
				state: "absent" as const,
				digest: null,
			};
		}
		throw new Error("Live destination is unavailable");
	}
	if (!stat.isFile() || stat.size > limit)
		throw new Error(
			"Live destination must be a regular environments.json of at most 256 KiB; symlinks are unsupported",
		);
	const fd = fs.openSync(
		destination,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd),
			buffer = Buffer.alloc(limit + 1);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			opened.size > limit
		)
			throw new Error("Live destination changed");
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(
				fd,
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (!read) break;
			length += read;
		}
		const after = fs.fstatSync(fd),
			current = fs.lstatSync(destination);
		if (
			length > limit ||
			!current.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			opened.size !== after.size ||
			opened.mtimeMs !== after.mtimeMs ||
			opened.ctimeMs !== after.ctimeMs
		)
			throw new Error("Live destination changed");
		sameDirectory(config, directoryDigest);
		return {
			destination,
			directoryDigest,
			state: "regular" as const,
			digest: digest(buffer.subarray(0, length)),
		};
	} finally {
		fs.closeSync(fd);
	}
}
/** Recorded staging-time content and directory identity must still match.
 * These path-based observations are not an OS compare-and-swap primitive. */
function fence(draft: Draft, live: ReturnType<typeof inspectDestination>) {
	const base = draft.base;
	return (
		base !== null &&
		typeof base === "object" &&
		["absent", "regular"].includes(base.state) &&
		base.directoryDigest === live.directoryDigest &&
		base.state === live.state &&
		(base.digest ?? null) === live.digest
	);
}
function writable(config: Config) {
	const directory = fs.realpathSync(config.configDir);
	if (!fs.statSync(directory).isDirectory())
		throw new Error("Live configuration directory is unavailable");
	const destination = path.join(directory, name);
	if (config.repositories.some((repository) => within(repository, destination)))
		throw new Error(
			"Promotion refuses a live destination inside an authorized repository; use the repository's own review workflow",
		);
	return destination;
}
function acquire(lock: string) {
	try {
		fs.mkdirSync(lock, { mode: 0o700 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw new Error("Promotion lock is unavailable");
	}
}
/** Cooperative exclusion only. Never infer abandonment from age: a paused
 * writer may still own the directory. Crash recovery requires operator action. */
function locked<T>(destination: string, action: () => T) {
	const lock = path.join(path.dirname(destination), lockName);
	if (!acquire(lock))
		throw new Error(
			"Promotion lock already exists; wait for its owner or verify abandonment before explicit operator removal",
		);
	try {
		return action();
	} finally {
		try {
			fs.rmdirSync(lock);
		} catch {
			/* Fail closed on the next attempt; never reclaim by elapsed time. */
		}
	}
}

function parsed(content: string) {
	try {
		return JSON.parse(content) as unknown;
	} catch {
		throw new Error(
			"Staged content is not valid JSON; values and parser errors are withheld",
		);
	}
}
function payload(config: Config, draft: Draft) {
	const content = draft.content;
	if (
		Buffer.byteLength(content) > limit ||
		Buffer.from(content).toString("utf8") !== content ||
		digest(content) !== draft.digest
	)
		throw new Error("Staged content integrity check failed");
	const projects = validateProjects(config, parsed(content)),
		targets = projects.reduce(
			(count, project) => count + project.targets.length,
			0,
		);
	if (
		projects.length > definitionProjectLimit ||
		targets > definitionTargetLimit ||
		projects.some(
			(project) => fs.realpathSync(project.repository) !== project.repository,
		)
	)
		throw new Error(
			"Promotable content requires at most 64 projects / 256 targets and unchanged existing authorized repositories",
		);
	return { bytes: Buffer.from(content, "utf8"), projects, targets };
}
/** Atomic same-directory replace: exclusive temp file, fsync, rename. */
function replace(
	destination: string,
	tag: string,
	bytes: Buffer,
	staged: string,
	onWrite: () => void,
	called: { value: boolean },
) {
	const directory = path.dirname(destination),
		temp = path.join(
			directory,
			`.${tag}.${digest(`${destination}${staged}`).slice(0, 24)}.tmp`,
		);
	const fd = fs.openSync(
		temp,
		fs.constants.O_WRONLY |
			fs.constants.O_CREAT |
			fs.constants.O_EXCL |
			fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		let offset = 0;
		while (offset < bytes.length)
			offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
		fs.fsyncSync(fd);
	} catch (error) {
		fs.closeSync(fd);
		fs.rmSync(temp, { force: true });
		throw error;
	}
	fs.closeSync(fd);
	try {
		if (!called.value) {
			called.value = true;
			onWrite();
		}
		fs.renameSync(temp, destination);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
	try {
		const handle = fs.openSync(directory, "r");
		try {
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
	} catch {
		/* Directory fsync is best effort; the rename itself already happened. */
	}
}
/** Auxiliary staged sources only: bounded relative public paths shaped for the
 * live configuration directory. Repository-bound sources are never published;
 * the repository's own review workflow owns those bytes. */
function auxiliaries(draft: Draft): SourceDraft[] {
	return draft.sources?.filter((source) => source.auxiliary === true) ?? [];
}
function auxiliariesApproval(list: SourceDraft[]): string {
	return digest(
		JSON.stringify(
			list.map((source) => ({ file: source.file, digest: source.digest })),
		),
	);
}
function auxiliaryBytes(source: SourceDraft): Buffer {
	if (
		Buffer.byteLength(source.content) > 65536 ||
		Buffer.from(source.content).toString("utf8") !== source.content ||
		digest(source.content) !== source.digest
	)
		throw new Error("Staged auxiliary content integrity check failed");
	return Buffer.from(source.content, "utf8");
}
/** Resolves and pre-verifies an auxiliary destination without writing. */
function auxiliaryDestination(directory: string, source: SourceDraft) {
	const file = auxiliaryPath(source.file),
		destination = path.join(directory, file);
	if (!within(directory, destination))
		throw new Error(
			"Auxiliary promotion refuses a destination outside the live configuration directory",
		);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { destination, previous: null as string | null };
		throw new Error("Auxiliary destination is unavailable");
	}
	if (!stat.isFile())
		throw new Error(
			"Auxiliary promotion refuses a non-regular destination; symlinks and directories are never adopted or converted",
		);
	return { destination, previous: readDigest(destination) };
}
function readDigest(destination: string): string {
	const fd = fs.openSync(
		destination,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const stat = fs.fstatSync(fd),
			buffer = Buffer.alloc(65537);
		if (!stat.isFile())
			throw new Error("Auxiliary destination changed under promotion");
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(
				fd,
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (!read) break;
			length += read;
		}
		if (length > 65536) throw new Error("Auxiliary destination is oversized");
		return digest(buffer.subarray(0, length));
	} finally {
		fs.closeSync(fd);
	}
}
/** Writes the exact staged configuration document to the live destination once
 * the developer explicitly approves its digest and the recorded base still holds. */
export function promoteDefinition(
	config: Config,
	draft: Draft,
	approval: string,
	sourcesApproval: string | undefined,
	onWrite: () => void,
) {
	if (approval !== draft.digest)
		throw new Error(
			"Promotion requires explicit approval of the exact current staged content digest",
		);
	const staged = auxiliaries(draft);
	if (staged.length === 0 && sourcesApproval !== undefined)
		throw new Error(
			"Promotion refuses an auxiliary approval when the draft stages no auxiliary sources",
		);
	if (staged.length > 0 && sourcesApproval !== auxiliariesApproval(staged))
		throw new Error(
			"Promotion requires explicit approval of the exact staged auxiliary file digests",
		);
	const { bytes, projects, targets } = payload(config, draft),
		destination = writable(config),
		pinned = directoryIdentity(config),
		canonical = { ...config, configDir: pinned.directory };
	if (destination !== path.join(pinned.directory, name))
		throw new Error("Live configuration directory identity changed");
	return locked(destination, () => {
		sameDirectory(config, pinned.directoryDigest);
		if (draft.base.directoryDigest !== pinned.directoryDigest)
			throw new Error(
				"Draft lacks the current configuration-directory identity; create a fresh draft",
			);
		const prepared = staged.map((source) => ({
				source,
				bytes: auxiliaryBytes(source),
				...auxiliaryDestination(pinned.directory, source),
			})),
			live = inspectDestination(canonical),
			configUnchanged =
				live.state === "regular" && live.digest === draft.digest,
			auxiliariesUnchanged = prepared.every(
				({ previous, source }) => previous === source.digest,
			);
		if (configUnchanged && auxiliariesUnchanged)
			return {
				outcome: "unchanged" as const,
				previous: live.digest,
				projects: projects.length,
				targets,
				bytes: bytes.length,
				auxiliaryFiles: prepared.map(({ source, previous }) => ({
					file: source.file,
					digest: source.digest,
					bytes: Buffer.byteLength(source.content),
					previous,
				})),
			};
		if (!fence(draft, live))
			throw new Error(
				"Live destination changed since this draft's recorded base; start or reload a draft to stage against the current configuration",
			);
		sameDirectory(config, pinned.directoryDigest);
		const called = { value: false };
		if (!configUnchanged)
			replace(destination, name, bytes, draft.digest, onWrite, called);
		for (const entry of prepared)
			if (
				entry.previous === null ||
				readDigest(entry.destination) !== entry.source.digest
			) {
				fs.mkdirSync(path.dirname(entry.destination), {
					mode: 0o700,
					recursive: true,
				});
				sameDirectory(config, pinned.directoryDigest);
				replace(
					entry.destination,
					path.basename(entry.destination),
					entry.bytes,
					entry.source.digest,
					onWrite,
					called,
				);
			}
		const after = inspectDestination(canonical);
		sameDirectory(config, pinned.directoryDigest);
		if (after.state !== "regular" || after.digest !== draft.digest)
			throw new Error(
				"Promoted bytes did not verify against the staged digest; the live configuration state is unverified and further promotion needs a fresh draft",
			);
		const auxiliaryFiles = prepared.map(
			({ destination: auxiliary, source, previous }) => {
				const verified = readDigest(auxiliary);
				if (verified !== source.digest)
					throw new Error(
						"Promoted auxiliary bytes did not verify against the staged digest; the live configuration state is unverified and further promotion needs a fresh draft",
					);
				return {
					file: source.file,
					digest: source.digest,
					bytes: auxiliaryBytes(source).length,
					previous,
				};
			},
		);
		return {
			outcome: "written" as const,
			previous: live.digest,
			projects: projects.length,
			targets,
			bytes: bytes.length,
			auxiliaryFiles,
		};
	});
}
