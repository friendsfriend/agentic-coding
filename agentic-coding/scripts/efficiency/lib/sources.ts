// Locating the snapshot's sources.
//
// The layout is the one MANIFEST.md describes. Discovery never throws: a
// missing source is reported as missing, because "this workflow has no
// telemetry file" is one of the findings the inventory has to make, not an
// error to hide.

import fs from "node:fs";
import path from "node:path";
import type { SourceFileRow, SourceId } from "./types.ts";

export interface DiscoveredFile {
	source: SourceId;
	path: string;
	/** Path relative to the evidence root, for the report. */
	relative: string;
	kind: "telemetry" | "harness" | "traces" | "herdr";
	/** Workflow id carried by the file's own name, when it has one. */
	workflowId?: string;
}

export interface EvidenceDiscovery {
	root: string;
	files: DiscoveredFile[];
	/** Expected-but-absent locations, e.g. `otel-tui/traces.sqlite`. */
	missing: string[];
	notes: string[];
}

function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return [];
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function stripJsonl(name: string): string {
	return name.replace(/\.jsonl$/, "");
}

/**
 * Walk the known evidence layout and return every readable file with the
 * source it belongs to.
 */
export function discoverEvidence(root: string): EvidenceDiscovery {
	const files: DiscoveredFile[] = [];
	const missing: string[] = [];
	const notes: string[] = [];
	const absolute = path.resolve(root);
	const add = (file: DiscoveredFile) => files.push(file);
	const rel = (p: string) => path.relative(absolute, p);
	const expect = (
		relative: string,
		source: SourceId,
		kind: DiscoveredFile["kind"],
	) => {
		const full = path.join(absolute, relative);
		if (isFile(full)) add({ source, path: full, relative, kind });
		else missing.push(relative);
	};

	expect("otel-tui/traces.sqlite", "traces.otel-tui", "traces");
	expect("orchestrator/harness.sqlite", "harness.orchestrator", "harness");
	expect("wiki-workflows/harness.sqlite", "harness.wiki", "harness");
	expect("backend/harness.sqlite", "harness.backend", "harness");
	expect("backend/herdr.db", "herdr.backend", "herdr");
	expect("main-store/herdr.db", "herdr.main-store", "herdr");

	const telemetryDirs: Array<[string, SourceId]> = [
		["main-store/telemetry", "telemetry.main-store"],
		["backend/telemetry", "telemetry.backend"],
	];
	for (const [relativeDir, source] of telemetryDirs) {
		const full = path.join(absolute, relativeDir);
		if (!fs.existsSync(full)) {
			missing.push(relativeDir);
			continue;
		}
		for (const name of listDir(full)) {
			if (!name.endsWith(".jsonl")) continue;
			const fullFile = path.join(full, name);
			if (!isFile(fullFile)) continue;
			add({
				source,
				path: fullFile,
				relative: rel(fullFile),
				kind: "telemetry",
				workflowId: stripJsonl(name),
			});
		}
	}

	// Remaining `harness*.sqlite` / `herdr*.db` files in the main store: the
	// stale harness and the Oct-14 backup, which are additional files of the
	// same sources rather than new sources of their own.
	for (const name of listDir(path.join(absolute, "main-store"))) {
		const full = path.join(absolute, "main-store", name);
		if (!isFile(full)) continue;
		if (name === "herdr.db" || name === "harness.sqlite") continue;
		if (name.startsWith("harness") && name.endsWith(".sqlite"))
			add({
				source: "harness.main-store",
				path: full,
				relative: rel(full),
				kind: "harness",
			});
		else if (name.startsWith("store-backup") && name.endsWith(".db"))
			add({
				source: "herdr.main-store",
				path: full,
				relative: rel(full),
				kind: "herdr",
			});
	}

	const worktreesDir = path.join(absolute, "worktrees");
	if (fs.existsSync(worktreesDir)) {
		for (const name of listDir(worktreesDir)) {
			const dir = path.join(worktreesDir, name);
			if (!fs.statSync(dir).isDirectory()) continue;
			const telemetry = path.join(dir, "telemetry.jsonl");
			if (isFile(telemetry))
				add({
					source: "telemetry.worktree",
					path: telemetry,
					relative: rel(telemetry),
					kind: "telemetry",
					workflowId: name,
				});
			else notes.push(`worktrees/${name}: no telemetry.jsonl`);
			const harness = path.join(dir, "harness.sqlite");
			if (isFile(harness))
				add({
					source: "harness.worktree",
					path: harness,
					relative: rel(harness),
					kind: "harness",
					workflowId: name,
				});
			const herdr = path.join(dir, "herdr.db");
			if (isFile(herdr))
				add({
					source: "herdr.main-store",
					path: herdr,
					relative: rel(herdr),
					kind: "herdr",
				});
		}
	} else {
		missing.push("worktrees");
	}

	return { root: absolute, files, missing, notes };
}

/** Does the evidence root look like the snapshot at all? */
export function assertEvidenceRoot(discovery: EvidenceDiscovery): void {
	if (discovery.files.length === 0)
		throw new Error(
			`no readable sources under ${discovery.root} — expected the layout MANIFEST.md describes`,
		);
}

export function emptySourceFiles(): SourceFileRow[] {
	return [];
}
