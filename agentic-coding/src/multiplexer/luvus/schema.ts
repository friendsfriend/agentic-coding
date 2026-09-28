// Luvus-shaped response decoders (add-multiplexer-adapters, task 5.1).
//
// Every shape below is written from the installed `luvus 0.14.2` UHP output
// (live probes against `session.snapshot` / `workspace.list` / `agent.list`),
// never from the Herdr schemas. Unexpected shapes fail loudly as bounded
// `invalid-response` port failures instead of silently defaulting.
import { Schema } from "effect";

const optionalString = Schema.optionalWith(Schema.String, { exact: true });
const optionalNumber = Schema.optionalWith(Schema.Number, { exact: true });
const optionalBoolean = Schema.optionalWith(Schema.Boolean, { exact: true });
const nullableString = Schema.NullOr(Schema.String);

export const workspaceRow = Schema.Struct({
	workspace: optionalString,
	workspace_id: optionalString,
	name: Schema.optionalWith(nullableString, { exact: true }),
	cwd: optionalString,
	terminal_cwd: optionalString,
	display_position: optionalString,
	active: optionalBoolean,
	pinned: optionalBoolean,
	tabs: optionalNumber,
	branch: Schema.optionalWith(nullableString, { exact: true }),
});

export const workspaceListResult = Schema.Struct({
	type: optionalString,
	revision: optionalNumber,
	workspaces: Schema.optionalWith(Schema.Array(workspaceRow), { exact: true }),
});

const hasValue = (value: unknown): boolean =>
	value !== undefined && value !== null && value !== "";

/** Single-entity results must carry their identity; an empty `{}` reply is
 * shape drift (`invalid-response`), never a fabricated success or absence. */
export const workspaceResult = workspaceRow.pipe(
	Schema.filter(
		(row) => hasValue(row.workspace_id) || hasValue(row.workspace),
		{
			identifier: "LuvusWorkspaceIdentity",
			message: () => "Luvus workspace reply has no workspace identity",
		},
	),
);

export const tabRow = Schema.Struct({
	tab: optionalString,
	tab_id: optionalString,
	name: Schema.optionalWith(nullableString, { exact: true }),
	active: optionalBoolean,
	kind: optionalString,
	workspace: optionalString,
	workspace_id: optionalString,
	focus: optionalString,
	panes: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});

export const tabListResult = Schema.Struct({
	type: optionalString,
	revision: optionalNumber,
	tabs: Schema.optionalWith(Schema.Array(tabRow), { exact: true }),
});

export const tabResult = tabRow.pipe(
	Schema.filter((row) => hasValue(row.tab_id) || hasValue(row.tab), {
		identifier: "LuvusTabIdentity",
		message: () => "Luvus tab reply has no tab identity",
	}),
);

export const paneRow = Schema.Struct({
	pane: optionalString,
	pane_id: optionalString,
	tab: optionalString,
	tab_id: optionalString,
	workspace: optionalString,
	workspace_id: optionalString,
	terminal_id: Schema.optionalWith(nullableString, { exact: true }),
	agent: Schema.optionalWith(nullableString, { exact: true }),
	name: Schema.optionalWith(nullableString, { exact: true }),
	cwd: optionalString,
	focused: optionalBoolean,
	status: optionalString,
});

export const paneListResult = Schema.Struct({
	type: optionalString,
	revision: optionalNumber,
	panes: Schema.optionalWith(Schema.Array(paneRow), { exact: true }),
});

export const paneResult = paneRow.pipe(
	Schema.filter((row) => hasValue(row.pane) || hasValue(row.pane_id), {
		identifier: "LuvusPaneIdentity",
		message: () => "Luvus pane reply has no pane identity",
	}),
);

const rect = Schema.Struct({
	x: optionalNumber,
	y: optionalNumber,
	width: optionalNumber,
	height: optionalNumber,
});

export const paneLayoutResult = Schema.Struct({
	type: optionalString,
	pane: optionalString,
	tab: optionalString,
	workspace: optionalString,
	rect: Schema.optionalWith(rect, { exact: true }),
});

export const paneSplitResult = Schema.Struct({
	type: optionalString,
	pane: optionalString,
	tab: optionalString,
	workspace: optionalString,
});

const rootProcess = Schema.Struct({
	pid: optionalNumber,
	start_marker: optionalString,
});

/** Luvus publishes executable identities without argument vectors; an entry
 * may be a bare name or a `{name, pid}` row depending on the scan. */
export const executableRow = Schema.Union(
	Schema.String,
	Schema.Struct({
		name: optionalString,
		pid: optionalNumber,
	}),
);

export const paneProcessesResult = Schema.Struct({
	type: optionalString,
	pane: optionalString,
	terminal_id: Schema.optionalWith(nullableString, { exact: true }),
	root_process: Schema.optionalWith(rootProcess, { exact: true }),
	executables: Schema.optionalWith(Schema.Array(executableRow), {
		exact: true,
	}),
	scan: optionalString,
});

const agentRowStruct = Schema.Struct({
	type: optionalString,
	agent: optionalString,
	name: optionalString,
	pane: optionalString,
	tab: optionalString,
	status: optionalString,
	session: Schema.optionalWith(nullableString, { exact: true }),
	terminal_id: optionalString,
	workspace: optionalString,
	workspace_id: optionalString,
	workspace_name: optionalString,
	cwd: optionalString,
});

/** One agent row; every live row carries its pane identity. */
export const agentRow = agentRowStruct.pipe(
	Schema.filter((row) => hasValue(row.pane), {
		identifier: "LuvusAgentIdentity",
		message: () => "Luvus agent reply has no pane identity",
	}),
);

export const agentListResult = Schema.Struct({
	type: optionalString,
	revision: optionalNumber,
	agents: Schema.optionalWith(Schema.Array(agentRow), { exact: true }),
});

export const agentStartResult = Schema.Struct({
	type: optionalString,
	name: optionalString,
	kind: optionalString,
	pane: optionalString,
	ready: optionalBoolean,
	status: optionalString,
}).pipe(
	Schema.filter((row) => hasValue(row.pane) && hasValue(row.name), {
		identifier: "LuvusAgentStartIdentity",
		message: () => "Luvus agent.start reply has no agent identity",
	}),
);

export const agentPromptResult = Schema.Struct({
	type: optionalString,
	pane: optionalString,
	status: optionalString,
	submitted: optionalBoolean,
	matched: optionalBoolean,
	evidence: optionalString,
});

// Named row types for adapter locals; the schemas above remain the single
// source of truth.
export type WorkspaceRow = Schema.Schema.Type<typeof workspaceRow>;
export type TabRow = Schema.Schema.Type<typeof tabRow>;
export type PaneRow = Schema.Schema.Type<typeof paneRow>;
export type AgentRow = Schema.Schema.Type<typeof agentRow>;
export type PaneLayoutRow = Schema.Schema.Type<typeof paneLayoutResult>;
