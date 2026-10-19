// A repository's `openspec/changes` directory is one fact with two readers: the
// orchestrator's `list_changes` listing and the start boundary's task-reference
// resolver. They may not drift — a change the listing publishes must be a
// change `start_workflow` resolves, and the reverse — so both read it here.
//
// Both also read a change's artifacts through the same check: a repository's
// own content may never aim a read outside its change. A symlink, FIFO, socket
// or device in place of `proposal.md` is refused rather than followed, because
// following it either reads an arbitrary file of the host or blocks the server
// until a writer opens the pipe.
import fs from "node:fs";
import path from "node:path";

/** The `openspec/changes` directory of one repository. */
export function changesRoot(repo: string): string {
	return path.join(repo, "openspec", "changes");
}

/** The active change ids of a repository: the directories under
 * `openspec/changes`, without `archive` and without anything that is not a real
 * directory (so a symlinked entry is never a resolvable change). */
export function discoverChangeIds(repo: string): string[] {
	try {
		return fs
			.readdirSync(changesRoot(repo), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== "archive")
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** What reading one change artifact answered: its bounded text, an absent file
 * (a change may not carry that artifact yet, which is less information, not a
 * failure), or a refusal because the entry is not a regular file inside the
 * change. */
export type ChangeArtifact =
	| { kind: "text"; text: string }
	| { kind: "missing" }
	| { kind: "refused" };

/** Read at most `bytes` from one artifact of a change directory. The entry must
 * be a regular file whose real path stays inside the change: a link that
 * resolves elsewhere is `refused`, and so is anything that is not a file at
 * all. */
export function readChangeArtifact(
	root: string,
	name: string,
	bytes: number,
): ChangeArtifact {
	let realRoot: string;
	let real: string;
	try {
		realRoot = fs.realpathSync(root);
		real = fs.realpathSync(path.join(root, name));
	} catch {
		return { kind: "missing" };
	}
	if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`))
		return { kind: "refused" };
	let fd: number | undefined;
	try {
		const stat = fs.lstatSync(real);
		if (!stat.isFile()) return { kind: "refused" };
		const size = Math.min(stat.size, bytes);
		if (size === 0) return { kind: "text", text: "" };
		fd = fs.openSync(real, "r");
		const buffer = Buffer.allocUnsafe(size);
		const read = fs.readSync(fd, buffer, 0, size, 0);
		return { kind: "text", text: buffer.subarray(0, read).toString("utf8") };
	} catch {
		return { kind: "missing" };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
