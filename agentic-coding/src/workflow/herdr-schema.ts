// Schema decoders for the shared Herdr CLI `.result` envelope
// (migrate-workflow-execution-to-effect, task 2.2). The single envelope
// parser lives in `herdr-client.ts` (`parseHerdrResult`); this module maps
// those parsed results to typed shapes at the workflow-facing lifecycle
// boundary so handlers and adapters never cast untrusted CLI JSON directly.
//
// Every field below is optional: a Herdr release may add or omit optional
// keys without breaking the workflow boundary, while unexpected *shapes*
// (a string where an object is expected) still fail loudly with a bounded
// diagnostic instead of silently producing `undefined`-driven behavior.
import { Schema } from "effect";

export const workspaceRef = Schema.Struct({
	workspace_id: Schema.optionalWith(Schema.String, { exact: true }),
	label: Schema.optionalWith(Schema.String, { exact: true }),
	name: Schema.optionalWith(Schema.String, { exact: true }),
	status: Schema.optionalWith(Schema.String, { exact: true }),
	agent_status: Schema.optionalWith(Schema.String, { exact: true }),
	closed_at: Schema.optionalWith(Schema.String, { exact: true }),
});

export const workspaceCreateResult = Schema.Struct({
	workspace: Schema.optionalWith(workspaceRef, { exact: true }),
});

export const workspaceGetResult = Schema.Struct({
	workspace: Schema.optionalWith(workspaceRef, { exact: true }),
});

export const workspaceListResult = Schema.Struct({
	workspaces: Schema.optionalWith(Schema.Array(workspaceRef), { exact: true }),
});

export const worktreeCreateResult = Schema.Struct({
	workspace: Schema.optionalWith(workspaceRef, { exact: true }),
	worktree: Schema.optionalWith(
		Schema.Struct({
			path: Schema.optionalWith(Schema.String, { exact: true }),
		}),
		{ exact: true },
	),
});

export const tabRef = Schema.Struct({
	tab_id: Schema.optionalWith(Schema.String, { exact: true }),
	label: Schema.optionalWith(Schema.String, { exact: true }),
});

export const paneRef = Schema.Struct({
	pane_id: Schema.optionalWith(Schema.String, { exact: true }),
	tab_id: Schema.optionalWith(Schema.String, { exact: true }),
	workspace_id: Schema.optionalWith(Schema.String, { exact: true }),
	/** Display-only live fields read by the sidebar projection. */
	agent: Schema.optionalWith(Schema.String, { exact: true }),
	agent_status: Schema.optionalWith(Schema.String, { exact: true }),
	terminal_title_stripped: Schema.optionalWith(Schema.String, { exact: true }),
	tab_label: Schema.optionalWith(Schema.String, { exact: true }),
});

export const agentRef = Schema.Struct({
	pane_id: Schema.optionalWith(Schema.String, { exact: true }),
	tab_id: Schema.optionalWith(Schema.String, { exact: true }),
	workspace_id: Schema.optionalWith(Schema.String, { exact: true }),
	agent: Schema.optionalWith(Schema.String, { exact: true }),
	agent_status: Schema.optionalWith(Schema.String, { exact: true }),
});

export const agentListResult = Schema.Struct({
	agents: Schema.optionalWith(Schema.Array(agentRef), { exact: true }),
});

export const tabListResult = Schema.Struct({
	tabs: Schema.optionalWith(Schema.Array(tabRef), { exact: true }),
});

export const paneListResult = Schema.Struct({
	panes: Schema.optionalWith(Schema.Array(paneRef), { exact: true }),
});

export const tabCreateResult = Schema.Struct({
	root_pane: Schema.optionalWith(
		Schema.Struct({
			pane_id: Schema.optionalWith(Schema.String, { exact: true }),
		}),
		{ exact: true },
	),
});

export const processInfoResult = Schema.Struct({
	process_info: Schema.optionalWith(
		Schema.Struct({
			shell_pid: Schema.optionalWith(Schema.Number, { exact: true }),
			foreground_process_group_id: Schema.optionalWith(Schema.Number, {
				exact: true,
			}),
			foreground_processes: Schema.optionalWith(
				Schema.Array(
					Schema.Struct({
						name: Schema.optionalWith(Schema.String, { exact: true }),
						argv: Schema.optionalWith(Schema.Array(Schema.String), {
							exact: true,
						}),
						pid: Schema.optionalWith(Schema.Number, { exact: true }),
					}),
				),
				{ exact: true },
			),
		}),
		{ exact: true },
	),
});

export const agentInfo = Schema.Struct({
	pane_id: Schema.optionalWith(Schema.String, { exact: true }),
	tab_id: Schema.optionalWith(Schema.String, { exact: true }),
	session_id: Schema.optionalWith(Schema.String, { exact: true }),
	agent_status: Schema.optionalWith(Schema.String, { exact: true }),
});

export const agentGetResult = Schema.Struct({
	agent: Schema.optionalWith(agentInfo, { exact: true }),
});

export const agentStartResult = Schema.Struct({
	agent: Schema.optionalWith(agentInfo, { exact: true }),
});

export const emptyResult = Schema.Struct({});
