// The inspection split and the batching rule (efficiency backlog item 14), in
// the one wording every surface repeats: the `read`/`grep`/`bash`/`codemode`
// descriptions and the assignment's `## Tool surface` section. Both take their
// sentences from here, so a wording change lands in one place, and a test can
// assert the exact text of each.
//
// The split is true for every writable and read-only run, so it names only
// `read`, `grep`, `bash` and `codemode` — never `edit`/`write`, which a
// read-only run does not have. `codemode` and `grep` are each conditional
// because a run's tool set is: `codemode` only when the run's global pi settings
// register it, `grep` only where the search extension is installed (never in
// orchestrator mode). A description never names a tool the run does not have.
import { globalPiTools, piSettingsPath } from "../workflow/pi-tools.ts";

/** The split for a run whose tool set contains the search tool (every workflow
 * run). "Focused" is what keeps the shell clause consistent with the adjacent
 * `env_build`/`env_test` guidance, and git/handoff are named because every role
 * runs them through `bash`. */
export const INSPECTION_SPLIT =
	"`read` (with `offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect code; `bash` is for focused builds, tests, `openspec` and the repository's git and handoff commands";

/** The same split for a run without the search extension (the orchestrator
 * host): the missing tool is stated by naming only the tools the run has. */
export const INSPECTION_SPLIT_WITHOUT_SEARCH =
	"`read` (with `offset`/`limit`) is the default way to inspect code; `bash` is for focused builds, tests, `openspec` and the repository's git and handoff commands";

/** The pipeline `codemode` exists for: one script instead of a turn per step. */
export const CODEMODE_PIPELINE =
	"`codemode` chains a search → filter → summarise pipeline into one turn";

/** The same clause as the assignment states it: the workflow renderer cannot see
 * a run's global pi settings, so it names `codemode` only conditionally. The
 * pipeline wording is shared with {@link CODEMODE_PIPELINE}. */
export const CODEMODE_ASSIGNMENT_CLAUSE =
	"`codemode`, when this run offers it, chains a search → filter → summarise pipeline into one turn";

/** Why one call per turn is expensive, stated where the tools are chosen. */
export const BATCHING_RULE =
	"Emit every independent call a step needs in one message rather than one call per turn: every turn re-sends the whole conversation";

export interface ToolSurfaceOptions {
	/** Whether this run's tool set contains `codemode`. Resolved by the host from
	 * the run's global agent settings; a description never names a tool the run
	 * does not have. */
	readonly codemodeRegistered?: boolean;
	/** Whether this run's tool set contains `grep`. Only orchestrator mode lacks
	 * it, so the default (undefined) states the split as a workflow run reads it. */
	readonly searchRegistered?: boolean;
}

/** One sentence per contract, joined for a tool description. */
export function toolSurfaceNote(options: ToolSurfaceOptions = {}): string {
	const split =
		options.searchRegistered === false
			? INSPECTION_SPLIT_WITHOUT_SEARCH
			: INSPECTION_SPLIT;
	return `${[
		split,
		...(options.codemodeRegistered ? [CODEMODE_PIPELINE] : []),
		BATCHING_RULE,
	].join(". ")}.`;
}

/** The assignment's `## Tool surface` section: the same split and the same
 * batching rule, with `codemode` conditioned on the run instead of asserted. A
 * durable workflow run installs `grep`, so only the description carries the
 * search-conditional variant. */
export const ASSIGNMENT_TOOL_SURFACE = [
	"## Tool surface",
	"",
	`${[INSPECTION_SPLIT, CODEMODE_ASSIGNMENT_CLAUSE, BATCHING_RULE].join(". ")}.`,
].join("\n");

/** Whether this host's runs have `codemode`: never the orchestrator (its tool
 * surface is exactly its own), otherwise only when the run's global pi settings
 * register it. Resolved once, before any tool is installed, so the registration
 * and every description agree. */
export function resolveCodemodeRegistered(
	globalAgentDir: string | undefined,
	orchestrator: boolean,
): boolean {
	if (orchestrator) return false;
	return globalPiTools(piSettingsPath(globalAgentDir)).some(
		(tool) => tool.tool === "codemode",
	);
}

/** Whether this host's runs have `grep`: the search extension is installed for
 * every workflow run and never in orchestrator mode. */
export function resolveSearchRegistered(orchestrator: boolean): boolean {
	return !orchestrator;
}
