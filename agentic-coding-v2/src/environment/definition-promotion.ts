import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import type { Draft } from "./definition-draft-data.ts";
import { within } from "./path-within.ts";

const limit = 65536,
	name = "environments.json",
	lockName = `.${name}.lock`;
/** Reads the live destination without following links; never creates or writes. */
export function inspectDestination(config: Config) {
	const destination = path.join(config.configDir, name);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { destination, state: "absent" as const, digest: null };
		throw new Error("Live destination is unavailable");
	}
	if (!stat.isFile() || stat.size > limit)
		throw new Error(
			"Live destination must be a regular environments.json of at most 64 KiB; symlinks are unsupported",
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
		return {
			destination,
			state: "regular" as const,
			digest: digest(buffer.subarray(0, length)),
		};
	} finally {
		fs.closeSync(fd);
	}
}
/** Recorded staging-time destination state must still hold immediately before
 * and after the write. This is a compare-and-swap, not an OS lock. */
function fence(draft: Draft, live: ReturnType<typeof inspectDestination>) {
	const base = draft.base;
	return (
		base !== null &&
		typeof base === "object" &&
		["absent", "regular"].includes(base.state) &&
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
		projects.length > 32 ||
		targets > 128 ||
		projects.some(
			(project) => fs.realpathSync(project.repository) !== project.repository,
		)
	)
		throw new Error(
			"Promotable content requires at most 32 projects / 128 targets and unchanged existing authorized repositories",
		);
	return { bytes: Buffer.from(content, "utf8"), projects, targets };
}
/** Atomic same-directory replace: exclusive temp file, fsync, rename, re-read. */
function replace(destination: string, bytes: Buffer, staged: string) {
	const directory = path.dirname(destination),
		temp = path.join(
			directory,
			`.${name}.${digest(`${destination}${staged}`).slice(0, 24)}.tmp`,
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
/** Writes the exact staged configuration document to the live destination once
 * the developer explicitly approves its digest and the recorded base still holds. */
export function promoteDefinition(
	config: Config,
	draft: Draft,
	approval: string,
) {
	if (approval !== draft.digest)
		throw new Error(
			"Promotion requires explicit approval of the exact current staged content digest",
		);
	const { bytes, projects, targets } = payload(config, draft),
		destination = writable(config);
	return locked(destination, () => {
		const live = inspectDestination(config);
		if (live.state === "regular" && live.digest === draft.digest)
			return {
				outcome: "unchanged" as const,
				previous: live.digest,
				projects: projects.length,
				targets,
				bytes: bytes.length,
			};
		if (!fence(draft, live))
			throw new Error(
				"Live destination changed since this draft's recorded base; start or reload a draft to stage against the current configuration",
			);
		replace(destination, bytes, draft.digest);
		const after = inspectDestination(config);
		if (after.state !== "regular" || after.digest !== draft.digest)
			throw new Error(
				"Promoted bytes did not verify against the staged digest; the live configuration state is unverified and further promotion needs a fresh draft",
			);
		return {
			outcome: "written" as const,
			previous: live.digest,
			projects: projects.length,
			targets,
			bytes: bytes.length,
		};
	});
}
