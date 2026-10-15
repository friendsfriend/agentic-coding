// Guard against a test process writing into the developer's real application
// configuration directory.
//
// The leak this guards against was never a test that *chose* the real root. It
// was production code deriving a path from a hard-coded home directory, so a
// test that handed its own configuration root to everything it knew about still
// wrote outside it — one workflow-target marker per started workflow, thousands
// of them, each naming a temporary directory that no longer belonged to a live
// workflow. Counting the real registry before and after a test process turns
// that silent leak into a failing run.
//
// Only the workflow target registry is counted, and only by name: it is the
// file-level artifact the leak produced, it is what the dashboard reads, and
// counting it needs neither a read of the developer's configuration nor a write
// of any kind.
import fs from "node:fs";
import path from "node:path";
import { defaultConfigRoot } from "../../src/config-root.ts";

/** The configuration root a home directory resolves to with no override. */
export function realConfigRoot(home: string): string {
	return defaultConfigRoot(home);
}

/**
 * The workflow target registry inside a configuration root.
 *
 * Spelled out rather than imported from `src/workflow/runtime/target-registry.ts`:
 * that module resolves the registry through `wikiRoot()`, which is exactly the
 * resolution this guard exists to check. Keeping the layout here means the guard
 * cannot be broken by the same code it is watching.
 */
export function targetRegistryDirectory(configRoot: string): string {
	return path.join(configRoot, ".agentic-coding-workflow", "targets");
}

export interface RealConfigSnapshot {
	readonly configRoot: string;
	/** Marker files in the registry, or `null` when it does not exist. */
	readonly targetMarkers: number | null;
}

/** Count a configuration root's target markers. Never creates or writes. */
export function snapshotRealConfig(configRoot: string): RealConfigSnapshot {
	let names: string[];
	try {
		names = fs.readdirSync(targetRegistryDirectory(configRoot));
	} catch {
		// No registry: nothing to protect, and the guard stays silent.
		return { configRoot, targetMarkers: null };
	}
	return {
		configRoot,
		targetMarkers: names.filter((name) => name.endsWith(".json")).length,
	};
}

/**
 * Fail loudly when a test run grew the real registry.
 *
 * Only growth is a failure. A registry that shrank, or that the developer
 * removed while the suite ran, is their own cleanup and must not fail a run that
 * did nothing wrong.
 */
export function assertRealConfigUntouched(
	before: RealConfigSnapshot,
	after: RealConfigSnapshot,
): void {
	if (before.targetMarkers === null || after.targetMarkers === null) return;
	if (after.targetMarkers <= before.targetMarkers) return;
	throw new Error(
		`test isolation failed: ${after.targetMarkers - before.targetMarkers} workflow target marker(s) were written into the real configuration root ${after.configRoot} during this test run (${before.targetMarkers} -> ${after.targetMarkers}). A test resolved a workflow location outside its isolated configuration root (see docs/test-isolation.md).`,
	);
}
