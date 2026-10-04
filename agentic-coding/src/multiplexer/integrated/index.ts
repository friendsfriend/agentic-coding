// Integrated multiplexer (integrated-multiplexer sidebar).
//
// `multiplexer: "integrated"` is the selection that says "no external
// multiplexer": the application's own OpenTUI shell is the workspace surface
// (the workspace sidebar lists the durable workflows) and managed agents run
// through the pane-less `pi-durable` host. This adapter keeps the
// `MultiplexerPort` seam honest without faking a terminal server:
//
//   - workspace identity is virtual. A workflow's workspace id is its workflow
//     id, so setup/close bookkeeping still round-trips, while `workspaceList`
//     reports nothing to an external observer and `workspaceFocus` is a no-op
//     (the sidebar owns navigation in this process).
//   - tabs, panes and pane-hosted agents do not exist. A workflow that pins a
//     pane-based runtime (`pi`, `opencode`, …) fails loudly in the engine's
//     launch path instead of silently launching nothing, and pane allocation is
//     never requested: `drainEffects` registers only the `pi-durable` adapter
//     for this selection.
//   - notifications have no desktop notifier to reach, so they report
//     `disabled`; the shell shows workflow state in its own surfaces.
//
// The virtual workspace state that matters (status, phase, runs, dialogue) is
// the workflow store's, which is SQLite-backed and survives restarts, so this
// adapter itself is stateless.
import { Effect, type Scope } from "effect";
import {
	type AgentInfo,
	type AgentStartInput,
	type MultiplexerEnvironment,
	MultiplexerError,
	type MultiplexerEvent,
	type MultiplexerPort,
	type NotificationOutcome,
} from "../port.ts";

/** Runtime id as it appears in configuration and diagnostics. */
export const INTEGRATED_MULTIPLEXER_ID = "integrated";

/**
 * The virtual workspace id of one workflow. Workspaces have no independent
 * lifecycle in this mode, so identity is the workflow identity and every
 * process derives the same value.
 */
export function integratedWorkspaceId(workflowId: string): string {
	return `integrated:${workflowId}`;
}

/** Whether a port call names a virtual integrated workspace. */
export function isIntegratedWorkspaceId(value: string): boolean {
	return value.startsWith("integrated:");
}

function unavailable(operation: string): MultiplexerError {
	return new MultiplexerError(
		"unavailable",
		INTEGRATED_MULTIPLEXER_ID,
		`integrated multiplexer: ${operation} needs an external multiplexer; configure 'herdr' or pin the 'pi-durable' runtime`,
	);
}

/**
 * A `MultiplexerPort` for the integrated selection. Operations the pane-less
 * managed-agent route never performs succeed as bounded no-ops; an operation
 * that would require a real terminal server fails with one classified error
 * naming the selection, never a fabricated success.
 */
export class IntegratedMultiplexer implements MultiplexerPort {
	readonly id = INTEGRATED_MULTIPLEXER_ID;

	// ---- Workspace: virtual, identity is the workflow id ----------------

	workspaceCreate(i: {
		cwd: string;
		label: string;
	}): Effect.Effect<{ workspaceId: string }, MultiplexerError> {
		return Effect.succeed({ workspaceId: integratedWorkspaceId(i.label) });
	}

	workspaceGet(
		idOrLabel: string,
	): Effect.Effect<
		{ workspaceId: string; status: string } | undefined,
		MultiplexerError
	> {
		// A virtual workspace is never externally closed: the workflow's own
		// durable status is the only lifecycle it has.
		return Effect.succeed({
			workspaceId: isIntegratedWorkspaceId(idOrLabel)
				? idOrLabel
				: integratedWorkspaceId(idOrLabel),
			status: "open",
		});
	}

	workspaceList(): Effect.Effect<[], MultiplexerError> {
		// No external workspace is ever "open" from a multiplexer's point of
		// view; the workspace sidebar lists durable workflows instead.
		return Effect.succeed([]);
	}

	workspaceFocus(_id: string): Effect.Effect<void, MultiplexerError> {
		// The in-process sidebar owns navigation; a focus request is already
		// satisfied by the workflow being listed.
		return Effect.void;
	}

	workspaceClose(_id: string): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	// ---- Tabs and panes: never allocated in this mode -------------------

	tabList(_workspaceId: string): Effect.Effect<[], MultiplexerError> {
		return Effect.succeed([]);
	}

	tabCreate(_i: {
		workspaceId: string;
		cwd?: string;
		label?: string;
		focus?: boolean;
	}): Effect.Effect<never, MultiplexerError> {
		return Effect.fail(unavailable("tab creation"));
	}

	tabRename(
		_tabId: string,
		_label: string,
	): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	tabFocus(_tabId: string): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	tabClose(_tabId: string): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	paneList(_i?: { workspaceId?: string }): Effect.Effect<[], MultiplexerError> {
		return Effect.succeed([]);
	}

	paneGet(_paneId: string): Effect.Effect<undefined, MultiplexerError> {
		return Effect.succeed(undefined);
	}

	paneLayout(_anchor: string): Effect.Effect<{ panes: [] }, MultiplexerError> {
		return Effect.succeed({ panes: [] as [] });
	}

	paneSplit(_i: {
		target: string;
		direction: "right" | "down";
		ratio?: number;
	}): Effect.Effect<never, MultiplexerError> {
		return Effect.fail(unavailable("pane split"));
	}

	paneRun(
		_paneId: string,
		_command: string,
	): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	paneFocus(_i: {
		paneId: string;
		workspaceId?: string;
	}): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	waitForShell(_paneId: string): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	paneForegroundProcesses(
		_paneId: string,
	): Effect.Effect<[], MultiplexerError> {
		return Effect.succeed([]);
	}

	paneClose(_paneId: string): Effect.Effect<void, MultiplexerError> {
		return Effect.void;
	}

	// ---- Agents: only the pane-less durable host runs here --------------

	agentList(): Effect.Effect<AgentInfo[], MultiplexerError> {
		return Effect.succeed([]);
	}

	agentGet(_target: string): Effect.Effect<undefined, MultiplexerError> {
		return Effect.succeed(undefined);
	}

	agentStart(_input: AgentStartInput): Effect.Effect<never, MultiplexerError> {
		// Reached only when a workflow pins a pane-based runtime while the
		// integrated selection is configured; the engine reports this failure as
		// the run's launch error.
		return Effect.fail(unavailable("agent launch"));
	}

	agentPrompt(
		_target: string,
		_text: string,
		_signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError> {
		return Effect.fail(unavailable("agent prompt"));
	}

	notify(_i: {
		title: string;
		body: string;
		needsAttention?: boolean;
	}): Effect.Effect<NotificationOutcome, MultiplexerError> {
		// No desktop notifier is attached to this process.
		return Effect.succeed("disabled");
	}

	eventsSubscribe(
		_handler: (event: MultiplexerEvent) => void,
	): Effect.Effect<unknown, MultiplexerError, Scope.Scope> {
		// There is no external runtime to subscribe to; the shell observes the
		// durable workflow store directly.
		return Effect.succeed(undefined);
	}

	environment(): MultiplexerEnvironment {
		return { envMarker: "AGENTIC_INTEGRATED" };
	}
}
