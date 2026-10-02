// Filesystem layout for one workflow's durable agent host (durable-agent-host
// D2): storage, control socket, single-writer lock, and host log all live
// under the workflow's own private runtime directory, so a workflow never
// shares a host or storage file with another.
import path from "node:path";

export interface HostLayout {
	readonly root: string;
	readonly storagePath: string;
	readonly socketPath: string;
	readonly lockPath: string;
	readonly logPath: string;
	/** Per-run environment files the host reads to build each conversation's
	 * execution environment (durable-agent-host: per-run execution environment). */
	readonly runEnvDir: string;
}

/** `<workflow runtime dir>/agent-host/{...}` (design.md D2). `runtimeDir` is
 * the workflow's already-resolved private runtime directory (the same root
 * `.herdr-workflow` paths use), so every workflow gets its own host. */
export function hostLayout(runtimeDir: string): HostLayout {
	const root = path.join(runtimeDir, "agent-host");
	return {
		root,
		storagePath: path.join(root, "harness.sqlite"),
		socketPath: path.join(root, "host.sock"),
		lockPath: path.join(root, "host.lock"),
		logPath: path.join(root, "host.log"),
		runEnvDir: path.join(root, "run-env"),
	};
}
