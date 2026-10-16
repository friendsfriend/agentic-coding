// The bounded extra reads a few catalog events need
// (add-orchestrator-event-subscriptions, task 1.4). Everything here is one
// workflow's own files, read only when the observation actually needs them; a
// missing or unreadable source returns nothing, so the derivation emits no
// event instead of failing.
import fs from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
	FindingCounts,
	WorkflowState,
	WorkflowView,
} from "../contracts/workflow.ts";
import { boundedSummary } from "../contracts/workflow-events.ts";
import { latestRunsByRole } from "../workflow/run-projections.ts";
import { viewToDashboardState } from "./operations/engine.ts";
import { verifierFindingCounts } from "./operations/observations.ts";
import type {
	WorkflowEventEnrichment,
	WorkflowEventProjection,
} from "./workflow-events.ts";

/** A read is bounded: a hostile or runaway artifact can never be streamed into
 * the derivation. */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** True when `target` stays inside `root` after normalization, so a store-derived
 * id (`workflowId`, `changeId`) can never escape the workflow's own tree with a
 * separator or `..`. */
function contained(root: string, target: string): boolean {
	const resolvedRoot = resolve(root);
	const resolved = resolve(target);
	return (
		resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${sep}`)
	);
}

/** The compaction entries already parsed for one telemetry file, keyed by its
 * `mtimeMs`+`size`, so an observation that changed nothing costs one stat
 * instead of a 1 MiB read and a `JSON.parse` per line. Bounded like the bus's
 * own per-workflow state, and released when the bus drops a repository or
 * stops. */
let maxSourceCacheEntries = 64;

/** How many artifact reads the caches keep, so a host that observes more
 * workflows than the default can raise it. */
export function setWorkflowEventSourcesCacheLimit(entries: number): void {
	if (Number.isFinite(entries) && entries > 0)
		maxSourceCacheEntries = Math.floor(entries);
}
/** The last OpenSpec progress read per tasks artifact, keyed by its
 * `mtimeMs`+`size` so an artifact that yields no task lines is not re-read and
 * re-scanned on every observation (a negative result is remembered too). */
const openspecCache = new Map<
	string,
	{
		readonly stamp: string;
		readonly progress: WorkflowEventEnrichment["openspec"];
	}
>();

/** Remember one bounded cache entry, evicting the oldest beyond the cap. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
	while (cache.size >= maxSourceCacheEntries) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	cache.set(key, value);
}
const compactionCache = new Map<
	string,
	{
		readonly stamp: string;
		readonly entries: WorkflowEventEnrichment["compaction"];
	}
>();

/** Forget the cached telemetry reads of one worktree (the bus calls this when
 * it evicts a repository). */
export function forgetWorkflowEventSources(worktree: string): void {
	const prefix = resolve(worktree);
	const matches = (key: string): boolean => {
		const resolved = resolve(key);
		return resolved === prefix || resolved.startsWith(`${prefix}${sep}`);
	};
	for (const key of [...compactionCache.keys()])
		if (matches(key)) compactionCache.delete(key);
	for (const key of [...openspecCache.keys()])
		if (matches(key)) openspecCache.delete(key);
}

/** Release every cached read (the bus calls this from `stop`). */
export function clearWorkflowEventSources(): void {
	compactionCache.clear();
	openspecCache.clear();
}

function readBounded(path: string, root?: string): string | undefined {
	// A store-derived id could otherwise walk out of the worktree (`../…`).
	if (root !== undefined && !contained(root, path)) return undefined;
	try {
		const stats = fs.statSync(path);
		if (!stats.isFile()) return undefined;
		const descriptor = fs.openSync(path, "r");
		try {
			const length = Math.min(stats.size, MAX_ARTIFACT_BYTES);
			const buffer = Buffer.alloc(length);
			fs.readSync(descriptor, buffer, 0, length, 0);
			return buffer.toString("utf8");
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		return undefined;
	}
}

/** The directory a workflow's own runtime files live in (its run telemetry). */
function workflowRoot(view: WorkflowView): string {
	return join(view.worktree, ".herdr-workflow", view.workflowId);
}

/** The `mtimeMs`+`size` stamp of one telemetry file, or a stable marker when it
 * is absent. */
function telemetryStamp(path: string): string {
	try {
		const stats = fs.statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

/** Committed finding counts per verifier role, for the completed verification
 * runs of this workflow. Read from the view's own run records, never a second
 * store read, and only when a verification run actually completed in this
 * observation (the per-role map is built once, not once per completed run). */
function verificationCounts(
	view: WorkflowView,
	previous: WorkflowEventProjection,
	next: WorkflowEventProjection,
): Record<string, FindingCounts> | undefined {
	const completed = next.runs.filter(
		(run) => run.stepId === "core.verification" && run.status === "completed",
	);
	if (completed.length === 0) return undefined;
	const before = new Map(previous.runs.map((run) => [run.id, run.status]));
	if (
		previous.runs.length > 0 &&
		completed.every((run) => before.get(run.id) === "completed")
	)
		return undefined;
	const state = viewToDashboardState(view) as WorkflowState;
	const counts: Record<string, FindingCounts> = {};
	for (const role of latestRunsByRole(
		state.runs.filter((run) => run.stepId === "core.verification"),
	).keys()) {
		const found = verifierFindingCounts(state, role);
		if (found) counts[role] = found;
	}
	return Object.keys(counts).length > 0 ? counts : undefined;
}

/** The completed compactions of this workflow's runs, from its own telemetry.
 * The file is re-read only when it actually changed. */
function compactionEntries(
	view: WorkflowView,
): WorkflowEventEnrichment["compaction"] | undefined {
	const path = join(workflowRoot(view), "telemetry.jsonl");
	const stamp = telemetryStamp(path);
	const cached = compactionCache.get(path);
	if (cached && cached.stamp === stamp) return cached.entries;
	const text = readBounded(path, view.worktree);
	const remember = (entries: WorkflowEventEnrichment["compaction"]): void => {
		// Bounded like the bus's own per-workflow state: the oldest entry is
		// evicted, so a long-lived process cannot grow the cache without limit.
		while (compactionCache.size >= maxSourceCacheEntries) {
			const oldest = compactionCache.keys().next().value;
			if (oldest === undefined) break;
			compactionCache.delete(oldest);
		}
		compactionCache.set(path, { stamp, entries });
	};
	if (text === undefined) {
		remember(undefined);
		return undefined;
	}
	const entries: Array<{
		role: string;
		reason?: string;
		tokensBefore?: number;
		tokensAfter?: number;
	}> = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.event !== "runtime.compaction") continue;
		// Both fields are read straight out of a file every run of the workflow can
		// write, so they are sanitized where they enter the process.
		const role = boundedSummary(
			typeof parsed.role === "string" ? parsed.role : "",
			64,
		);
		if (role === undefined) continue;
		entries.push({
			role,
			...(typeof parsed.reason === "string"
				? { reason: boundedSummary(parsed.reason, 128) }
				: {}),
			...(typeof parsed.tokensBefore === "number"
				? { tokensBefore: parsed.tokensBefore }
				: {}),
			...(typeof parsed.tokensAfter === "number"
				? { tokensAfter: parsed.tokensAfter }
				: {}),
		});
	}
	remember(entries.length > 0 ? entries : undefined);
	return entries.length > 0 ? entries : undefined;
}

/** The change's OpenSpec task progress. Read only when the step moved, an
 * artifact effect changed, or the artifact itself did: a miss (an artifact with
 * no task lines) is remembered by its stamp, so a quiet workflow costs one stat
 * per observation rather than a 1 MiB read. */
function openspecProgress(
	view: WorkflowView,
	previous: WorkflowEventProjection,
	next: WorkflowEventProjection,
): WorkflowEventEnrichment["openspec"] {
	const stepMoved = previous.stepId !== next.stepId;
	const artifactEffect =
		stepMoved ||
		previous.effects.some((before) => {
			const after = next.effects.find((effect) => effect.id === before.id);
			return after !== undefined && after.status !== before.status;
		});
	if (!stepMoved && !artifactEffect && previous.openspec !== null) return null;
	const changeId = view.changeId;
	if (!changeId) return null;
	const path = join(view.worktree, "openspec", "changes", changeId, "tasks.md");
	const stamp = telemetryStamp(path);
	const cached = openspecCache.get(path);
	if (cached && cached.stamp === stamp) return cached.progress;
	const text = readBounded(path, view.worktree);
	if (text === undefined) {
		remember(openspecCache, path, { stamp, progress: null });
		return null;
	}
	const items = [...text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)];
	if (items.length === 0) {
		remember(openspecCache, path, { stamp, progress: null });
		return null;
	}
	const progress = {
		changeId,
		done: items.filter((item) => item[1]?.toLowerCase() === "x").length,
		total: items.length,
	};
	remember(openspecCache, path, { stamp, progress });
	return progress;
}

/** The bounded enrichment of one observation, or undefined when no source had
 * anything to say. */
export function enrichWorkflowEvent(input: {
	view: WorkflowView;
	previous: WorkflowEventProjection;
	next: WorkflowEventProjection;
}): WorkflowEventEnrichment | undefined {
	const verification = verificationCounts(
		input.view,
		input.previous,
		input.next,
	);
	const compaction = compactionEntries(input.view);
	const openspec = openspecProgress(input.view, input.previous, input.next);
	if (!verification && !compaction && openspec === null) return undefined;
	return {
		...(verification ? { verification } : {}),
		...(compaction ? { compaction } : {}),
		...(openspec ? { openspec } : {}),
	};
}
