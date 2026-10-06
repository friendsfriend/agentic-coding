// Server-enforced orchestrator launch ceiling (cap-orchestrator-launches):
// the bounded read behind the pure refusal decision in
// `src/server/orchestrator-policy.ts`.
//
// Workflow stores are per target, and the target registry remembers every
// directory a workflow was started in (plus the repository-independent wiki and
// research targets, which the registry deliberately skips because they are
// always read). That is exactly the set the sidebar reads, so the count sees
// every workflow the orchestrator could have started without scanning the
// filesystem.
//
// The read is observational and bounded: each physical store file is opened at
// most once (the wiki and research targets resolve to one file), the rows are
// filtered in SQL to orchestrator-started work that is either active or inside
// the trailing-24 h window, and no snapshot is decoded in JS. An absent store
// contributes nothing, and a store that needs migration (or cannot be opened) is
// counted as zero and reported as skipped, so a refusal can say that the count
// was incomplete instead of pretending it was exact.
import fs from "node:fs";
import { effectiveManifestPolicy } from "../definitions/manifest-policy.ts";
import { openReadStore } from "./store.ts";
import { workflowTargets } from "./target-registry.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	wikiWorkflowTarget,
} from "./targets.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One orchestrator-started workflow the ceiling counted. */
export interface OrchestratorLaunch {
	readonly workflowId: string;
	/** The store that owns the row: the repository, or the wiki/research target. */
	readonly repository: string;
	readonly createdAt: string;
}

/** The counts the pure decision consumes. `active` holds workflows that are
 * neither `completed` nor `closed`; `recent` holds every orchestrator start
 * created inside the trailing 24 hours. `skipped` names the targets whose store
 * could not be read, so the refusal can say the count was incomplete. */
export interface OrchestratorLaunchCounts {
	readonly active: readonly OrchestratorLaunch[];
	readonly recent: readonly OrchestratorLaunch[];
	readonly skipped: readonly string[];
}

/** Every target an orchestrator-started workflow can live in: the recorded
 * registry plus the two repository-independent targets it never records. */
export function orchestratorLaunchTargets(): string[] {
	return [
		...new Set([
			...workflowTargets(),
			wikiWorkflowTarget(),
			researchWorkflowTarget(),
		]),
	].sort();
}

/** One physical store file and the target that reads it. The wiki and research
 * targets resolve to one file, so keying on the canonical store path is what
 * keeps a shared row from being counted once per alias. */
interface LaunchStore {
	readonly target: string;
	readonly store: string;
}

/** Unique store files to read, in the target list's order. A target whose store
 * path cannot be resolved is dropped here and reported by the caller. */
function launchStores(): { stores: LaunchStore[]; unresolved: string[] } {
	const stores: LaunchStore[] = [];
	const unresolved: string[] = [];
	const seen = new Set<string>();
	for (const target of orchestratorLaunchTargets()) {
		let store: string;
		try {
			store = canonicalStorePath(target);
		} catch {
			unresolved.push(target);
			continue;
		}
		if (seen.has(store)) continue;
		seen.add(store);
		stores.push({ target, store });
	}
	return { stores, unresolved };
}

/** The target a row belongs to, from its definition's manifest policy: the
 * shared store holds both wiki and research rows, and their `repository`
 * metadata is empty, so the reading target cannot label them. */
function rowTarget(target: string, definitionId: string): string {
	try {
		switch (effectiveManifestPolicy({ id: definitionId }).targetKind) {
			case "wiki":
				return wikiWorkflowTarget();
			case "research":
				return researchWorkflowTarget();
			default:
				return target;
		}
	} catch {
		// A removed or unavailable definition has no policy; the reading target is
		// the only label left.
		return target;
	}
}

/** Count orchestrator-started workflows across every target. Reads only: no
 * store is initialized or migrated, and a target that cannot be read is skipped
 * rather than failing the count. */
export function countOrchestratorLaunches(
	now: Date = new Date(),
): OrchestratorLaunchCounts {
	const active: OrchestratorLaunch[] = [];
	const recent: OrchestratorLaunch[] = [];
	const skipped: string[] = [];
	const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
	const { stores, unresolved } = launchStores();
	skipped.push(...unresolved);
	for (const { target, store } of stores) {
		// No store file: nothing was ever started there, so nothing to count.
		if (!fs.existsSync(store)) continue;
		let db: ReturnType<typeof openReadStore>;
		try {
			db = openReadStore(target);
		} catch {
			// Absent, migration-required, unsupported or unreadable: counted as
			// zero and named, never initialized by this read.
			skipped.push(target);
			continue;
		}
		try {
			// Filter in SQL: only orchestrator-started rows that are either active
			// or inside the window can contribute, so terminal-and-old rows are
			// never decoded. `json_valid`/CASE guard the malformed-snapshot row
			// `listWorkflowViews` also tolerates.
			const rows = db
				.query(
					`SELECT id, created_at, status, definition_id,
						CASE WHEN json_valid(snapshot_json)
							THEN json_extract(snapshot_json, '$.metadata.startedBy')
						END AS started_by
					FROM workflow_instances
					WHERE CASE WHEN json_valid(snapshot_json)
							THEN json_extract(snapshot_json, '$.metadata.startedBy')
						END = 'orchestrator'
						AND (status NOT IN ('completed','closed') OR created_at >= ?)`,
				)
				.iterate(cutoff) as IterableIterator<{
				id: string;
				created_at: string;
				status: string;
				definition_id: string;
				started_by: string | null;
			}>;
			for (const row of rows) {
				if (row.started_by !== "orchestrator") continue;
				const launch: OrchestratorLaunch = {
					workflowId: row.id,
					repository: rowTarget(target, row.definition_id),
					createdAt: row.created_at,
				};
				if (row.status !== "completed" && row.status !== "closed")
					active.push(launch);
				if (row.created_at >= cutoff) recent.push(launch);
			}
		} catch {
			skipped.push(target);
		} finally {
			db.close();
		}
	}
	return { active, recent, skipped };
}
