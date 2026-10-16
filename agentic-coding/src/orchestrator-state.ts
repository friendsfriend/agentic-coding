// The orchestrator session's runtime directory (add-orchestrator-event-
// subscriptions, D8). One path helper both sides of the process boundary need:
// the TUI starts the durable orchestrator host and writes `session.json`, and
// the server reads the same file to learn which session is active (it may not
// import `src/tui`). Root layer: it imports only the configuration-root
// resolver.
import fs from "node:fs";
import path from "node:path";
import { resolveConfigRoot } from "./config-root.ts";
/** The orchestrator runtime directory under the configuration root. */
export function orchestratorRuntimeDir(root = resolveConfigRoot()): string {
	return path.join(root, "orchestrator");
}

/** The file naming the active orchestrator session. */
export function orchestratorSessionFile(runtimeDir: string): string {
	return path.join(runtimeDir, "session.json");
}

/** The durable event-subscription store, next to the conversation state. */
export function workflowEventSubscriptionsFile(runtimeDir: string): string {
	return path.join(runtimeDir, "event-subscriptions.json");
}

/** The persisted active session name. `undefined` means the file exists but
 * cannot be read as a session name (a partial write, a malformed document): a
 * caller must then treat the active session as unknown rather than assume a
 * name, because assuming one would make another session's records look foreign.
 * A *missing* file is a fresh install and reports the first session. The read is
 * memoized against the file's `mtimeMs`, so a delivery pass that asks on every
 * event costs one stat rather than a read and a parse. */
const sessionNameCache = new Map<
	string,
	{ mtimeMs: number; name: string | undefined }
>();

export function currentSessionName(runtimeDir: string): string | undefined {
	const file = orchestratorSessionFile(runtimeDir);
	let mtimeMs = -1;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		sessionNameCache.delete(runtimeDir);
		return "orchestrator";
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
			/^orchestrator[\w-]*$/.test(parsed.name)
		)
			name = parsed.name;
	} catch {
		name = undefined;
	}
	sessionNameCache.set(runtimeDir, { mtimeMs, name });
	return name;
}

export function saveOrchestratorSessionName(
	runtimeDir: string,
	name: string,
): void {
	// Atomic: the server reads this file from another process, and a reader that
	// catches a truncated document would otherwise see no session at all.
	const file = orchestratorSessionFile(runtimeDir);
	const temporary = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(temporary, JSON.stringify({ name }), { mode: 0o600 });
	fs.renameSync(temporary, file);
	sessionNameCache.set(runtimeDir, { mtimeMs: -1, name });
}
