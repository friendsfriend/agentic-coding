// The standalone pi-durable coding session's runtime directory and persisted
// session name. One dedicated durable host (`<config root>/pi-durable/`) serves
// the session: the active conversation is "the" coding session until `/new`
// starts another, and the name is kept next to the host so a shell restart
// reopens the conversation the developer was working in.
//
// Root layer: it imports only the configuration-root resolver.
import fs from "node:fs";
import path from "node:path";
import { resolveConfigRoot } from "./config-root.ts";

/** The pi-durable session runtime directory under the configuration root. */
export function piDurableRuntimeDir(root = resolveConfigRoot()): string {
	return path.join(root, "pi-durable");
}

/** The file naming the active coding-session conversation. */
export function piDurableSessionFile(runtimeDir: string): string {
	return path.join(runtimeDir, "session.json");
}

/** The first session's name on a fresh install. */
export const DEFAULT_PI_DURABLE_SESSION_NAME = "pi-durable";

const sessionNameCache = new Map<
	string,
	{ mtimeMs: number; name: string | undefined }
>();

/**
 * The persisted active session name. `undefined` means the file exists but
 * cannot be read as a session name (a partial write, a malformed document): a
 * caller must then treat the active session as unknown rather than assume a
 * name, because assuming one would reopen the wrong conversation. A *missing*
 * file is a fresh install and reports the first session.
 */
export function currentPiDurableSessionName(
	runtimeDir: string,
): string | undefined {
	const file = piDurableSessionFile(runtimeDir);
	let mtimeMs = -1;
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
			sessionNameCache.delete(runtimeDir);
			return undefined;
		}
		mtimeMs = stat.mtimeMs;
	} catch (error) {
		sessionNameCache.delete(runtimeDir);
		// Only ENOENT is a fresh install. Permission/I/O failures must not
		// silently redirect the caller into the default conversation.
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? DEFAULT_PI_DURABLE_SESSION_NAME
			: undefined;
	}
	const cached = sessionNameCache.get(runtimeDir);
	if (cached && cached.mtimeMs === mtimeMs) return cached.name;
	let name: string | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			name?: unknown;
		};
		if (
			typeof parsed.name === "string" &&
			parsed.name.length <= 256 &&
			/^pi-durable[\w-]*$/.test(parsed.name)
		)
			name = parsed.name;
	} catch {
		name = undefined;
	}
	sessionNameCache.set(runtimeDir, { mtimeMs, name });
	return name;
}

/** Persist the active session name atomically, so the next shell run reopens
 * exactly this conversation. */
export function savePiDurableSessionName(
	runtimeDir: string,
	name: string,
): void {
	if (name.length > 256 || !/^pi-durable[\w-]*$/.test(name))
		throw new Error("Invalid pi-durable session name.");
	const file = piDurableSessionFile(runtimeDir);
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const descriptor = fs.openSync(temporary, "wx", 0o600);
	try {
		try {
			fs.writeFileSync(descriptor, JSON.stringify({ name }));
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	sessionNameCache.set(runtimeDir, { mtimeMs: -1, name });
}
