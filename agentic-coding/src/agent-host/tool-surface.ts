// The inspection split and the batching rule (efficiency backlog item 14), in
// the one wording every surface repeats: the assignment's `## Tool surface`
// section and the `read`/`grep`/`bash`/`codemode` descriptions. They live here
// so the assignment and the tool descriptions cannot drift apart, and so a test
// can assert the exact text of each.
//
// The split is true for every durable run, read-only runs included, so it names
// only `read`, `grep`, `bash` and `codemode` — never `edit`/`write`, which a
// read-only run does not have. `codemode` is conditional everywhere because it
// is registered only when the run's global pi settings enable it.
export const INSPECTION_SPLIT =
	"`read` (with `offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect code; `bash` is for builds, tests and `openspec`";

/** The pipeline `codemode` exists for: one script instead of a turn per step. */
export const CODEMODE_PIPELINE =
	"`codemode` chains a search → filter → summarise pipeline into one turn";

/** Why one call per turn is expensive, stated where the tools are chosen. */
export const BATCHING_RULE =
	"Emit every independent call a step needs in one message rather than one call per turn: every turn re-sends the whole conversation";

export interface ToolSurfaceOptions {
	/** Whether this run's tool set contains `codemode`. Resolved by the host
	 * from the run's global agent settings; a description never names a tool the
	 * run does not have. */
	readonly codemodeRegistered?: boolean;
}

/** One sentence per contract, joined for a tool description or the
 * assignment's `## Tool surface` section. */
export function toolSurfaceNote(options: ToolSurfaceOptions = {}): string {
	return `${[
		INSPECTION_SPLIT,
		...(options.codemodeRegistered ? [CODEMODE_PIPELINE] : []),
		BATCHING_RULE,
	].join(". ")}.`;
}
