// Durable registry of workflow targets (custom-path workflow visibility).
//
// A workflow's rows live in <target>/.herdr-workflow/herdr.db, and the sidebar
// lists configured catalog projects plus the wiki/research targets — never the
// filesystem (a directory scan would make any repository on the machine appear
// automatically). A workflow started in a directory of the operator's own
// choosing therefore owns a store nothing remembers, which is what this
// registry fixes: the target is recorded when a workflow starts and read back
// when the sidebar builds its list, so the workflow stays visible across
// restarts.
//
// One marker file per target, named by the target's digest: recording is
// create-if-absent, so two concurrent starts cannot lose each other's entry and
// no read-modify-write of a shared file is needed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	NON_REPOSITORY_WORKFLOW_TARGETS,
	wikiWorkflowDataRoot,
} from "./targets.ts";

/** Markers live beside the shared store, in the workflow data root every
 * workflow already writes to. Exported so a test can assert the location the
 * registry resolves instead of restating it (test/config-isolation.test.ts). */
export function targetRegistryDirectory(): string {
	return path.join(wikiWorkflowDataRoot(), "targets");
}

/** Remember the target a workflow was started in. Best-effort by design: a
 * target that cannot be recorded must never fail the start it describes, and
 * the wiki/research targets are always listed anyway. */
export function recordWorkflowTarget(target: string): void {
	if (!target || NON_REPOSITORY_WORKFLOW_TARGETS.includes(target)) return;
	try {
		const directory = targetRegistryDirectory();
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const file = path.join(
			directory,
			`${createHash("sha256").update(target).digest("hex")}.json`,
		);
		if (fs.existsSync(file)) return;
		// Written under a temporary name and renamed, so a reader never sees a
		// half-written marker and two writers cannot interleave inside one file.
		const temporary = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify({ target })}\n`, {
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
	} catch {
		// Unrecorded: the sidebar keeps listing what it can read, and the next
		// start in that directory records it again.
	}
}

/** One marker's parsed target, kept under the marker file's own metadata. A
 * marker is immutable once written (create-if-absent, written under a temporary
 * name and renamed into place), so (mtime, size) is what tells a scan whether
 * it must re-read the file: reading and parsing the 4.2 k markers this machine
 * has accumulated cost 441 ms of synchronous main-thread work on every catalog
 * read, against 8 ms to stat them all. */
interface MarkerEntry {
	readonly mtime: number;
	readonly size: number;
	readonly target: string;
}

const markers = new Map<string, MarkerEntry>();
let markerReads = 0;

/** How many marker files the process has read (test/observability seam: a scan
 * over an unchanged registry must read none of them again). */
export function targetMarkerReads(): number {
	return markerReads;
}

/** Every recorded target, stable-sorted. A marker that cannot be read is
 * ignored rather than failing the whole listing, and a target whose store has
 * since been removed is dropped by the caller's own store check. */
export function workflowTargets(): string[] {
	const directory = targetRegistryDirectory();
	let names: string[];
	try {
		names = fs.readdirSync(directory);
	} catch {
		// No registry yet: the sidebar lists what the catalog knows.
		return [];
	}
	const targets = new Set<string>();
	const live = new Set<string>();
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(directory, name);
		live.add(file);
		let mtime: number;
		let size: number;
		try {
			const stat = fs.statSync(file);
			mtime = stat.mtimeMs;
			size = stat.size;
		} catch {
			markers.delete(file);
			continue;
		}
		const cached = markers.get(file);
		if (cached && cached.mtime === mtime && cached.size === size) {
			targets.add(cached.target);
			continue;
		}
		try {
			markerReads++;
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
				target?: unknown;
			};
			if (typeof parsed.target === "string" && parsed.target) {
				markers.set(file, { mtime, size, target: parsed.target });
				targets.add(parsed.target);
			} else markers.delete(file);
		} catch {
			markers.delete(file);
		}
	}
	// Keep the map bounded to what the registry holds: a marker written and then
	// removed (a swept test fixture, a cleaned-up target) must not be listed from
	// the cache forever. Only this directory's entries are pruned, so a process
	// that reads two registry roots keeps both.
	const prefix = `${directory}${path.sep}`;
	for (const file of markers.keys())
		if (file.startsWith(prefix) && !live.has(file)) markers.delete(file);
	return [...targets].sort();
}
