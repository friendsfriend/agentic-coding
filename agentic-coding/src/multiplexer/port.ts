// Runtime-neutral multiplexer port (add-multiplexer-adapters).
//
// One intent-level, Effect-native boundary over workspace, tab, pane, agent,
// notification, and runtime-event behavior. Worktrees are not a multiplexer
// concern: they belong to the worktree port (`src/worktree/`), and a caller
// opens a workspace at the path that port resolved. Callers name workflow concepts and
// never construct vendor CLI arguments or parse vendor envelopes; the Herdr and
// Luvus adapters own transport mechanics behind this interface.
//
// Design rules encoded here:
//   - Every operation is required (no optional methods, no capability flags).
//   - There is no raw-command escape hatch.
//   - Failures let a caller distinguish confirmed absence from transport
//     unavailability.
//   - `agentStart` owns env injection, readiness, and launch-prompt
//     confirmation so a runtime with an atomic start can implement it itself.
//   - `eventsSubscribe` is scope-owned: releasing the scope releases the
//     subscription, and reconnect/resume stays inside the adapter.
import type { Effect, Scope } from "effect";

export type MultiplexerId = "herdr" | "luvus";

/**
 * Why a port operation failed. `absent` is confirmed absence (the caller may
 * treat it as "already gone"), `unavailable`/`denied` are infrastructure
 * conditions that the effect runner maps onto its existing transient class,
 * `invalid-response` is bounded response-shape drift, and `ownership-lost`
 * preserves the workflow engine's ownership classification.
 */
export type MultiplexerFailureKind =
	| "absent"
	| "unavailable"
	| "denied"
	| "invalid-response"
	| "ownership-lost";

/** One classified multiplexer failure. `kind` is the only axis callers need;
 * the vendor message stays for bounded diagnostics. */
export class MultiplexerError extends Error {
	readonly _tag = "MultiplexerError";
	readonly runtime: MultiplexerId;
	readonly kind: MultiplexerFailureKind;
	constructor(
		kind: MultiplexerFailureKind,
		runtime: MultiplexerId,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "MultiplexerError";
		this.kind = kind;
		this.runtime = runtime;
	}
}
/** Deprecated alias kept so assignment-era imports type-check. */
export type MultiplexerFailure = MultiplexerError;

export type Direction = "left" | "right" | "up" | "down";

export interface WorkspaceInfo {
	readonly workspaceId: string;
	readonly label?: string;
	readonly name?: string;
	readonly status?: string;
	readonly closedAt?: string;
}

export interface TabInfo {
	readonly tabId: string;
	readonly label?: string;
}

export interface PaneInfo {
	readonly paneId: string;
	readonly tabId?: string;
	readonly workspaceId?: string;
	readonly agent?: string;
	readonly agentStatus?: string;
	readonly title?: string;
}

export interface LayoutPaneInfo {
	readonly paneId: string;
	readonly y: number;
	/** Full rect so focus traversal keeps the shared geometry primitive; only
	 * `y` is used by bottom-pane reuse, the rest by directional focus. */
	readonly x?: number;
	readonly width?: number;
	readonly height?: number;
	readonly focused?: boolean;
}

export interface PaneLayout {
	readonly focusedPaneId?: string;
	readonly panes: readonly LayoutPaneInfo[];
}

export interface ProcessIdentity {
	readonly name: string;
	readonly pid?: number;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
	readonly name: string;
	readonly paneId: string;
	readonly tabId?: string;
	readonly sessionId?: string;
	readonly status: AgentStatus;
	readonly kind?: string;
}

/** Port-normalized view of one agent observation; kept separate from
 * `AgentInfo` because observation does not require a canonical name. */
export interface AgentObservation {
	readonly status: AgentStatus;
	readonly paneId: string;
	readonly sessionId?: string;
}

export interface AgentStartInput {
	readonly kind: "pi" | "opencode";
	readonly name: string;
	readonly paneId: string;
	readonly cwd: string;
	readonly runId: string;
	readonly runDirectory?: string;
	readonly runtimeArgs: readonly string[];
	readonly environment: Record<string, string>;
	readonly prompt: string;
	readonly signal?: AbortSignal;
}

/** The launch/observe/stop subset the workflow agent adapters need. The Herdr
 * lifecycle implements it directly; a Luvus facade delegates to the port. */
export interface AgentLifecycleOps {
	start(input: AgentStartInput): Effect.Effect<AgentInfo, Error>;
	prompt(
		target: string,
		message: string,
		signal?: AbortSignal,
	): Effect.Effect<void, Error>;
	observe(
		target: string,
		signal?: AbortSignal,
	): Effect.Effect<AgentObservation, Error>;
	stop(target: string, signal?: AbortSignal): Effect.Effect<void, Error>;
}

/** One normalized runtime event. `event` is the small application vocabulary
 * the dashboard reacts to; `data` stays an opaque record the consumer narrows. */
export interface MultiplexerEvent {
	readonly event: string;
	readonly data: Record<string, unknown>;
}

/** The bounded notification outcome vocabulary shared by both runtimes. Every
 * value counts as "raised"; the notifier never retries a refused delivery. */
export type NotificationOutcome =
	| "shown"
	| "disabled"
	| "rate_limited"
	| "busy"
	| "no_foreground_client"
	| "refused"
	| "unknown";

export interface MultiplexerEnvironment {
	/** Environment marker variable that identifies a managed runtime pane. */
	readonly envMarker: string;
	readonly socketPath?: string;
	readonly binPath?: string;
	readonly paneId?: string;
}

export interface MultiplexerPort {
	readonly id: MultiplexerId;

	workspaceCreate(i: {
		cwd: string;
		label: string;
	}): Effect.Effect<WorkspaceInfo, MultiplexerError>;
	workspaceGet(
		idOrLabel: string,
	): Effect.Effect<WorkspaceInfo | undefined, MultiplexerError>;
	workspaceList(): Effect.Effect<WorkspaceInfo[], MultiplexerError>;
	workspaceFocus(id: string): Effect.Effect<void, MultiplexerError>;
	workspaceClose(id: string): Effect.Effect<void, MultiplexerError>;

	tabList(workspaceId: string): Effect.Effect<TabInfo[], MultiplexerError>;
	tabCreate(i: {
		workspaceId: string;
		cwd?: string;
		label?: string;
		focus?: boolean;
	}): Effect.Effect<{ tabId: string; rootPaneId: string }, MultiplexerError>;
	tabRename(
		tabId: string,
		label: string,
	): Effect.Effect<void, MultiplexerError>;
	tabFocus(tabId: string): Effect.Effect<void, MultiplexerError>;
	tabClose(tabId: string): Effect.Effect<void, MultiplexerError>;

	paneList(i?: {
		workspaceId?: string;
	}): Effect.Effect<PaneInfo[], MultiplexerError>;
	paneGet(
		paneId: string,
	): Effect.Effect<PaneInfo | undefined, MultiplexerError>;
	paneLayout(anchor: string): Effect.Effect<PaneLayout, MultiplexerError>;
	paneSplit(i: {
		target: string;
		direction: "right" | "down";
		ratio?: number;
	}): Effect.Effect<{ paneId: string; tabId?: string }, MultiplexerError>;
	/** Run one command line in the pane. Both runtimes execute the string
	 * through a shell, so callers MUST quote untrusted data. */
	paneRun(
		paneId: string,
		command: string,
	): Effect.Effect<void, MultiplexerError>;
	paneFocus(i: {
		paneId: string;
		workspaceId?: string;
	}): Effect.Effect<void, MultiplexerError>;
	waitForShell(paneId: string): Effect.Effect<void, MultiplexerError>;
	paneForegroundProcesses(
		paneId: string,
	): Effect.Effect<ProcessIdentity[], MultiplexerError>;
	paneClose(paneId: string): Effect.Effect<void, MultiplexerError>;

	agentList(): Effect.Effect<AgentInfo[], MultiplexerError>;
	agentGet(
		target: string,
	): Effect.Effect<AgentInfo | undefined, MultiplexerError>;
	agentStart(
		input: AgentStartInput,
	): Effect.Effect<AgentInfo, MultiplexerError>;
	agentPrompt(
		target: string,
		text: string,
		signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError>;

	notify(i: {
		title: string;
		body: string;
		/** Needs-attention presentation intent: Herdr raises the desktop-request
		 * sound while Luvus maps it to its warning level. It is an intent flag, not
		 * a vendor notification-options surface. */
		needsAttention?: boolean;
	}): Effect.Effect<NotificationOutcome, MultiplexerError>;

	/** Scope-owned runtime subscription. The release finalizer disconnects the
	 * transport; reconnect and sequence resume stay inside the adapter. */
	eventsSubscribe(
		handler: (event: MultiplexerEvent) => void,
	): Effect.Effect<unknown, MultiplexerError, Scope.Scope>;

	environment(): MultiplexerEnvironment;
}

/** The supported runtime identifiers, shared by configuration validation and
 * the factory so validation diagnostics cannot drift. */
export const MULTIPLEXER_IDS: readonly MultiplexerId[] = ["herdr", "luvus"];

/**
 * Classify one raw adapter error into a port kind. Transport/spawn failures
 * are checked first so a missing executable can never be mistaken for a
 * confirmed-absence result, and absence matching is narrowed to
 * entity-scoped diagnostics (the structured runtime code is preferred when
 * the adapter can attach one). Shared by both adapters so "confirmed
 * absence" does not drift between runtimes.
 */
export function classifyMessage(
	message: string,
	code?: string,
): {
	kind: MultiplexerFailureKind;
	absent: boolean;
} {
	if (
		/effect ownership was lost|ownership was lost|stale-ownership/i.test(
			message,
		)
	)
		return { kind: "ownership-lost", absent: false };
	// The runtime's structured entity codes are authoritative for absence.
	if (code && /^(?:(?:workspace|pane|agent|tab)_)?not_found$/.test(code))
		return { kind: "absent", absent: true };
	// Transport/spawn conditions are unavailability, never absence.
	if (
		code === "ENOENT" ||
		code === "EACCES" ||
		code === "EPIPE" ||
		code === "ECONNREFUSED" ||
		code === "ETIMEDOUT" ||
		/\bENOENT\b|\bEACCES\b|\bEPIPE\b|\bECONNREFUSED\b|\bETIMEDOUT\b|executable not found|posix_spawn|connection refused|socket (?:closed|not found)|server not running|not running|timed out/i.test(
			message,
		)
	)
		return { kind: "unavailable", absent: false };
	if (
		/(?:unknown (?:workspace|pane|agent|tab))|(?:(?:workspace|pane|agent|tab)[^\n]{0,80}not found)|(?:no such (?:workspace|pane|agent|tab))/i.test(
			message,
		)
	)
		return { kind: "absent", absent: true };
	return { kind: "unavailable", absent: false };
}
