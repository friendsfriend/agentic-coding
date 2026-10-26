import fs from "node:fs";
import path from "node:path";

/** Bun can fail realpath(socket) with EOPNOTSUPP on macOS. Resolve the
 * directory ancestors, then lstat the final entry without following a symlink.
 * Keep exact canonical-path checks; never fall back to trusting a failed read. */
export function canonicalWorkflowSocket(socket: string): string {
	const directory = path.dirname(socket);
	if (
		fs.realpathSync(directory) !== directory ||
		fs.lstatSync(socket).isSymbolicLink()
	)
		throw new Error("workflow agent socket path contains a symlink");
	return socket;
}
