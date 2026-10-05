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
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	wikiWorkflowDataRoot,
} from "./targets.ts";

/** Markers live beside the shared store, in the workflow data root every
 * workflow already writes to. */
function registryDirectory(): string {
	return path.join(wikiWorkflowDataRoot(), "targets");
}

/** Remember the target a workflow was started in. Best-effort by design: a
 * target that cannot be recorded must never fail the start it describes, and
 * the wiki/research targets are always listed anyway. */
export function recordWorkflowTarget(target: string): void {
	if (
		!target ||
		isWikiWorkflowTarget(target) ||
		isResearchWorkflowTarget(target)
	)
		return;
	try {
		const directory = registryDirectory();
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

/** Every recorded target, stable-sorted. A marker that cannot be read is
 * ignored rather than failing the whole listing, and a target whose store has
 * since been removed is dropped by the caller's own store check. */
export function workflowTargets(): string[] {
	try {
		const targets = new Set<string>();
		for (const entry of fs.readdirSync(registryDirectory())) {
			if (!entry.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(
					fs.readFileSync(path.join(registryDirectory(), entry), "utf8"),
				) as { target?: unknown };
				if (typeof parsed.target === "string" && parsed.target)
					targets.add(parsed.target);
			} catch {}
		}
		return [...targets].sort();
	} catch {
		return [];
	}
}
