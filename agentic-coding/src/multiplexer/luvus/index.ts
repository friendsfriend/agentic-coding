// Luvus multiplexer adapter (add-multiplexer-adapters, task 5).
//
// Implements the runtime-neutral `MultiplexerPort` over Luvus UHP 1.0:
// workspace/tab/pane/agent/worktree operations, atomic agent start and prompt,
// notification delivery through the semantic CLI, and a scoped event
// subscription with sequence resume. The named session and socket always come
// from the environment; this module never hardcodes a path.
import fs from "node:fs";
import { Effect, Either, type Schema, type Scope } from "effect";
import { agentRunEnvMarker, writeAgentRunEnv } from "../agent-env.ts";
import {
	type AgentInfo,
	type AgentStartInput,
	classifyMessage,
	MultiplexerError,
	type MultiplexerPort,
	type NotificationOutcome,
	type PaneInfo,
	type PaneLayout,
	type ProcessIdentity,
	type TabInfo,
	type WorkspaceInfo,
} from "../port.ts";
import { type LuvusCliOptions, runLuvus } from "./cli.ts";
import * as L from "./schema.ts";
import {
	decodeLuvusResult,
	luvusEventsSubscribe,
	resolveLuvusSocketPath,
	UhpError,
	uhpCall,
} from "./uhp.ts";

export type UhpRequester = (
	method: string,
	params: Record<string, unknown>,
) => Promise<unknown>;

export interface LuvusAdapterOptions {
	socketPath?: string;
	binPath?: string;
	session?: string;
	/** Test seam: replaces the socket transport while keeping method/params. */
	request?: UhpRequester;
	runCli?: (args: string[], options?: LuvusCliOptions) => unknown;
	sleep?: (ms: number) => Effect.Effect<void>;
	/** Bounded reconnect base delay for the event subscription. */
	reconnectDelayMs?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toAgentStatus(value: unknown): AgentInfo["status"] {
	const observed = String(value ?? "unknown");
	return ["idle", "working", "blocked", "done"].includes(observed)
		? (observed as AgentInfo["status"])
		: "unknown";
}

function workspaceInfo(row: L.WorkspaceRow): WorkspaceInfo | undefined {
	const id = row.workspace_id ?? row.workspace;
	if (!id) return undefined;
	return {
		workspaceId: id,
		...(row.name ? { label: row.name, name: row.name } : {}),
	};
}

function paneInfo(row: L.PaneRow): PaneInfo | undefined {
	const id = row.pane ?? row.pane_id;
	if (!id) return undefined;
	return {
		paneId: id,
		...(row.tab_id ? { tabId: row.tab_id } : {}),
		...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
		...(row.agent ? { agent: row.agent } : {}),
		...(row.status ? { agentStatus: row.status } : {}),
		...(row.name ? { title: row.name } : {}),
	};
}

function agentInfo(
	row: L.AgentRow,
	fallbackTarget: string,
): AgentInfo | undefined {
	const paneId = row.pane;
	if (!paneId) return undefined;
	return {
		name: row.name ?? fallbackTarget,
		paneId,
		status: toAgentStatus(row.status),
		...(row.tab ? { tabId: row.tab } : {}),
		...(row.session ? { sessionId: row.session } : {}),
		...(row.agent ? { kind: row.agent } : {}),
	};
}

export class LuvusMultiplexer implements MultiplexerPort {
	readonly id = "luvus" as const;
	readonly socketPath?: string;
	private readonly requestImpl: UhpRequester | undefined;
	private readonly cliOptions: LuvusCliOptions;
	private readonly runCli: (
		args: string[],
		options?: LuvusCliOptions,
	) => unknown;
	private readonly sleep: (ms: number) => Effect.Effect<void>;
	private readonly reconnectDelayMs?: number;
	constructor(options: LuvusAdapterOptions = {}) {
		// The fallback socket must honor the same session the CLI targets,
		// mirroring the factory: never hardcode the default-session path.
		this.socketPath =
			options.socketPath ??
			resolveLuvusSocketPath({
				...process.env,
				...(options.session ? { LUVUS_SESSION: options.session } : {}),
			});
		this.requestImpl = options.request;
		this.cliOptions = {
			...(options.binPath ? { binPath: options.binPath } : {}),
			...(options.session ? { session: options.session } : {}),
		};
		this.runCli = options.runCli ?? runLuvus;
		this.sleep = options.sleep ?? ((ms) => Effect.sleep(ms));
		this.reconnectDelayMs = options.reconnectDelayMs;
	}
	private fail(error: unknown): MultiplexerError {
		if (error instanceof MultiplexerError) return error;
		const message = errorMessage(error);
		const code =
			error instanceof UhpError
				? error.code
				: typeof (error as { code?: unknown })?.code === "string"
					? String((error as { code?: unknown }).code)
					: undefined;
		if (
			code &&
			["denied", "unauthorized", "forbidden", "access_denied"].includes(code)
		)
			return new MultiplexerError("denied", "luvus", message, {
				cause: error,
			});
		if (code === "invalid_response")
			return new MultiplexerError("invalid-response", "luvus", message, {
				cause: error,
			});
		const { kind } = classifyMessage(message, code);
		return new MultiplexerError(kind, "luvus", message, { cause: error });
	}
	/** One classified UHP request. The ownership signal closes the in-flight
	 * socket so an abort never leaves server-side work running. */
	private request(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Effect.Effect<unknown, MultiplexerError> {
		const requestImpl = this.requestImpl;
		const socketPath = this.socketPath;
		return Effect.tryPromise({
			try: () => {
				if (signal?.aborted) throw new Error("effect ownership was lost");
				if (requestImpl) return requestImpl(method, params);
				if (!socketPath) throw new Error("Luvus socket path is not configured");
				return uhpCall(socketPath, method, params, signal);
			},
			catch: (error) => this.fail(error),
		});
	}
	private decode<A>(
		// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with decoded shapes; mirrored from decodeHerdrResult.
		schema: Schema.Schema<A, any, never>,
		raw: unknown,
	): Effect.Effect<A, MultiplexerError> {
		return Effect.try({
			try: () => decodeLuvusResult(schema, raw),
			catch: (error) => this.fail(error),
		});
	}
	/** Resolve the id params Luvus accepts for a stable id or a 0-based index. */
	private workspaceParams(idOrLabel: string): Record<string, unknown>[] {
		return /^\d+$/.test(idOrLabel)
			? [{ workspace: idOrLabel }, { workspace_id: idOrLabel }]
			: [{ workspace_id: idOrLabel }, { workspace: idOrLabel }];
	}
	private findWorkspace(
		idOrLabel: string,
	): Effect.Effect<WorkspaceInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			for (const params of this.workspaceParams(idOrLabel)) {
				const raw = yield* this.request("workspace.get", params).pipe(
					Effect.catchIf(
						(error) => error.kind === "absent",
						() => Effect.succeed(undefined),
					),
				);
				if (raw === undefined) continue;
				const row = yield* this.decode(L.workspaceResult, raw);
				const info = workspaceInfo(row);
				if (info) return info;
			}
			const list = yield* this.request("workspace.list");
			const result = yield* this.decode(L.workspaceListResult, list);
			const match = (result.workspaces ?? []).find(
				(row) => row.name === idOrLabel || row.cwd === idOrLabel,
			);
			return match ? workspaceInfo(match) : undefined;
		});
	}
	workspaceCreate(i: {
		cwd: string;
		label: string;
	}): Effect.Effect<WorkspaceInfo, MultiplexerError> {
		return Effect.gen(this, function* () {
			const opened = yield* this.decode(
				L.workspaceResult,
				yield* this.request("workspace.open", { path: i.cwd }),
			);
			if (!opened.workspace)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus workspace.open returned no workspace",
					),
				);
			if (i.label.trim())
				yield* this.request("workspace.rename", {
					workspace: opened.workspace,
					name: i.label,
				});
			const info = yield* this.findWorkspace(opened.workspace);
			return info ?? { workspaceId: opened.workspace, label: i.label };
		});
	}
	workspaceGet(
		idOrLabel: string,
	): Effect.Effect<WorkspaceInfo | undefined, MultiplexerError> {
		return this.findWorkspace(idOrLabel);
	}
	workspaceList(): Effect.Effect<WorkspaceInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.workspaceListResult,
				yield* this.request("workspace.list"),
			);
			return (result.workspaces ?? []).flatMap((row) => {
				const info = workspaceInfo(row);
				return info ? [info] : [];
			});
		});
	}
	workspaceFocus(id: string): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			const ref = yield* this.findWorkspace(id);
			if (!ref)
				return yield* Effect.fail(
					new MultiplexerError("absent", "luvus", `workspace not found: ${id}`),
				);
			yield* this.request("workspace.focus", {
				workspace_id: ref.workspaceId,
			});
		});
	}
	workspaceClose(id: string): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			const ref = yield* this.findWorkspace(id);
			if (!ref) return;
			yield* this.request("workspace.close", {
				workspace_id: ref.workspaceId,
			});
		});
	}
	worktreeCreate(i: {
		cwd: string;
		branch: string;
		base?: string;
		label: string;
	}): Effect.Effect<
		{ workspace: WorkspaceInfo; worktree: string },
		MultiplexerError
	> {
		return Effect.gen(this, function* () {
			const list = yield* this.decode(
				L.workspaceListResult,
				yield* this.request("workspace.list"),
			);
			let repository = (list.workspaces ?? []).find(
				(row) => row.cwd === i.cwd || row.terminal_cwd === i.cwd,
			);
			if (!repository) {
				const opened = yield* this.decode(
					L.workspaceResult,
					yield* this.request("workspace.open", { path: i.cwd }),
				);
				if (opened.workspace) repository = { workspace: opened.workspace };
			}
			if (!repository?.workspace && !repository?.workspace_id)
				return yield* Effect.fail(
					new MultiplexerError(
						"unavailable",
						"luvus",
						`Luvus has no workspace for ${i.cwd}`,
					),
				);
			yield* this.request("worktree.create", {
				branch: i.branch,
				...(repository.workspace_id
					? { workspace_id: repository.workspace_id }
					: { workspace: repository.workspace }),
			});
			const after = yield* this.decode(
				L.workspaceListResult,
				yield* this.request("workspace.list"),
			);
			const workspace = (after.workspaces ?? []).find(
				(row) => row.name === i.branch || row.cwd?.endsWith(`/${i.branch}`),
			);
			if (!workspace)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus worktree.create returned no workspace identity",
					),
				);
			const info = workspaceInfo(workspace) ?? {
				workspaceId: String(workspace.workspace ?? ""),
			};
			const worktree = workspace.cwd;
			if (!worktree)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus worktree.create returned no worktree path",
					),
				);
			// Luvus creates the branch from the workspace's current HEAD and has no
			// base parameter. Verify the requested base rather than silently
			// ignoring it: a mismatch fails loudly with the runtime named.
			if (i.base) {
				const worktrees = yield* this.decode(
					L.worktreeListResult,
					yield* this.request("worktree.list", {
						...(repository.workspace_id
							? { workspace_id: repository.workspace_id }
							: { workspace: repository.workspace }),
					}),
				);
				const created = (worktrees.worktrees ?? []).find(
					(row) => row.path === worktree,
				);
				if (!created)
					return yield* Effect.fail(
						new MultiplexerError(
							"invalid-response",
							"luvus",
							"Luvus worktree.list did not report the created worktree",
						),
					);
				if (
					created.head &&
					created.head !== i.base &&
					!created.head.startsWith(i.base) &&
					!i.base.startsWith(created.head)
				)
					return yield* Effect.fail(
						new MultiplexerError(
							"unavailable",
							"luvus",
							`Luvus created worktree '${i.branch}' at ${created.head} instead of the requested base ${i.base}`,
						),
					);
			}
			return { workspace: info, worktree };
		});
	}
	tabList(workspaceId: string): Effect.Effect<TabInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.tabListResult,
				yield* this.request("tab.list", { workspace_id: workspaceId }),
			);
			return (result.tabs ?? []).flatMap((row) =>
				row.tab_id
					? [
							{
								tabId: row.tab_id,
								...(row.name ? { label: row.name } : {}),
							},
						]
					: [],
			);
		});
	}
	tabCreate(i: {
		workspaceId: string;
		cwd?: string;
		label?: string;
		focus?: boolean;
	}): Effect.Effect<{ tabId: string; rootPaneId: string }, MultiplexerError> {
		return Effect.gen(this, function* () {
			const created = yield* this.decode(
				L.tabResult,
				yield* this.request("tab.new", {
					workspace_id: i.workspaceId,
					...(i.cwd ? { cwd: i.cwd } : {}),
				}),
			);
			if (!created.tab)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus tab.new returned no tab",
					),
				);
			const tab = yield* this.decode(
				L.tabResult,
				yield* this.request("tab.get", { tab: created.tab }),
			);
			const tabId = tab.tab_id;
			if (!tabId)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus tab.get returned no tab id",
					),
				);
			const rootPaneId = tab.panes?.[0];
			if (!rootPaneId)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus tab.new returned no root pane",
					),
				);
			if (i.label) yield* this.tabRename(tabId, i.label);
			return { tabId, rootPaneId };
		});
	}
	tabRename(
		tabId: string,
		label: string,
	): Effect.Effect<void, MultiplexerError> {
		return this.request("tab.rename", { tab_id: tabId, name: label }).pipe(
			Effect.asVoid,
		);
	}
	tabFocus(tabId: string): Effect.Effect<void, MultiplexerError> {
		return this.request("tab.focus", { tab_id: tabId }).pipe(Effect.asVoid);
	}
	tabClose(tabId: string): Effect.Effect<void, MultiplexerError> {
		return this.request("tab.close", { tab_id: tabId }).pipe(Effect.asVoid);
	}
	private tabPanes(
		tabId: string,
	): Effect.Effect<readonly string[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const tab = yield* this.decode(
				L.tabResult,
				yield* this.request("tab.get", { tab_id: tabId }),
			);
			return tab.panes ?? [];
		});
	}
	paneList(i?: {
		workspaceId?: string;
	}): Effect.Effect<PaneInfo[], MultiplexerError> {
		if (!i?.workspaceId)
			return Effect.gen(this, function* () {
				// The documented primitive lists the active tab's panes; enrich each
				// row with pane.get so tab/workspace identity is preserved.
				const listed = yield* this.decode(
					L.paneListResult,
					yield* this.request("pane.list"),
				);
				const panes: PaneInfo[] = [];
				for (const row of listed.panes ?? []) {
					const id = row.pane ?? row.pane_id;
					if (!id) continue;
					const info = yield* this.paneGet(id);
					if (info) panes.push(info);
				}
				return panes;
			});
		return Effect.gen(this, function* () {
			const workspaceId = i?.workspaceId as string;
			const tabs = yield* this.tabList(workspaceId);
			const panes: PaneInfo[] = [];
			for (const tab of tabs) {
				const ids = yield* this.tabPanes(tab.tabId);
				for (const id of ids) {
					const info = yield* this.paneGet(id);
					if (info) panes.push(info);
				}
			}
			return panes;
		});
	}
	paneGet(
		paneId: string,
	): Effect.Effect<PaneInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.paneResult,
				yield* this.request("pane.get", { pane: paneId }),
			);
			return paneInfo(result);
		}).pipe(
			Effect.catchIf(
				(error) => error.kind === "absent",
				() => Effect.succeed(undefined),
			),
		);
	}
	paneLayout(anchor: string): Effect.Effect<PaneLayout, MultiplexerError> {
		return Effect.gen(this, function* () {
			const anchorPane = yield* this.paneGet(anchor);
			const tabId = anchorPane?.tabId;
			if (!tabId)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus pane has no tab",
					),
				);
			const tab = yield* this.decode(
				L.tabResult,
				yield* this.request("tab.get", { tab_id: tabId }),
			);
			const panes: Array<{
				paneId: string;
				y: number;
				x?: number;
				width?: number;
				height?: number;
			}> = [];
			for (const id of tab.panes ?? []) {
				const layout = yield* this.decode(
					L.paneLayoutResult,
					yield* this.request("pane.layout", { pane: id }),
				);
				panes.push({
					paneId: id,
					y: layout.rect?.y ?? 0,
					...(layout.rect?.x !== undefined ? { x: layout.rect.x } : {}),
					...(layout.rect?.width !== undefined
						? { width: layout.rect.width }
						: {}),
					...(layout.rect?.height !== undefined
						? { height: layout.rect.height }
						: {}),
				});
			}
			return {
				...(tab.focus ? { focusedPaneId: tab.focus } : {}),
				panes,
			};
		});
	}
	paneSplit(i: {
		target: string;
		direction: "right" | "down";
		ratio?: number;
	}): Effect.Effect<{ paneId: string; tabId?: string }, MultiplexerError> {
		// Luvus pane.split takes direction/focus only; it applies its own split
		// sizing and the requested ratio is not a UHP parameter. Geometry
		// differences are accepted here rather than failing the launch; callers
		// that need an exact ratio must use layout.set_split_ratio.
		void i.ratio;
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.paneSplitResult,
				yield* this.request("pane.split", {
					pane: i.target,
					direction: i.direction,
					focus: false,
				}),
			);
			if (!result.pane)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus pane.split returned no pane",
					),
				);
			return {
				paneId: result.pane,
				...(result.tab ? { tabId: result.tab } : {}),
			};
		});
	}
	paneRun(
		paneId: string,
		command: string,
	): Effect.Effect<void, MultiplexerError> {
		return this.paneRunRequest(paneId, command);
	}
	private paneRunRequest(
		paneId: string,
		command: string,
		signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError> {
		return this.request("pane.run", { pane: paneId, command }, signal).pipe(
			Effect.asVoid,
		);
	}
	paneFocus(i: {
		paneId: string;
		workspaceId?: string;
	}): Effect.Effect<void, MultiplexerError> {
		return this.request("pane.focus", { pane: i.paneId }).pipe(Effect.asVoid);
	}
	/** Bounded readiness gate: poll the pane's cached process scan until the
	 * runtime reports a root process, then hand the pane to the caller. This
	 * mirrors Herdr's 50 x 100 ms wait and fails loudly instead of queueing a
	 * dashboard command into a pane whose shell never came up. */
	waitForShell(paneId: string): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			for (let attempt = 0; attempt < 50; attempt++) {
				const outcome = yield* Effect.either(
					this.decode(
						L.paneProcessesResult,
						yield* this.request("pane.processes", { pane: paneId }),
					),
				);
				if (Either.isLeft(outcome)) {
					if (outcome.left.kind === "absent")
						return yield* Effect.fail(outcome.left);
					// An unreadable scan is unconfirmed readiness, not failure.
				} else if (outcome.right.root_process?.pid !== undefined) {
					return;
				}
				yield* this.sleep(100);
			}
			return yield* Effect.fail(
				new MultiplexerError(
					"unavailable",
					"luvus",
					`pane did not reach an available shell: ${paneId}`,
				),
			);
		});
	}
	paneForegroundProcesses(
		paneId: string,
	): Effect.Effect<ProcessIdentity[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.paneProcessesResult,
				yield* this.request("pane.processes", { pane: paneId }),
			);
			const identities: ProcessIdentity[] = [];
			if (result.root_process?.pid !== undefined)
				identities.push({
					name: "root",
					pid: result.root_process.pid,
				});
			for (const executable of result.executables ?? []) {
				if (typeof executable === "string") {
					if (executable) identities.push({ name: executable });
					continue;
				}
				if (!executable.name) continue;
				identities.push({
					name: executable.name,
					...(executable.pid !== undefined ? { pid: executable.pid } : {}),
				});
			}
			return identities;
		});
	}
	paneClose(paneId: string): Effect.Effect<void, MultiplexerError> {
		return this.request("pane.close", { pane: paneId }).pipe(Effect.asVoid);
	}
	agentList(): Effect.Effect<AgentInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.agentListResult,
				yield* this.request("agent.list"),
			);
			return (result.agents ?? []).flatMap((row) => {
				const info = agentInfo(row, row.pane ?? "");
				return info ? [info] : [];
			});
		});
	}
	agentGet(
		target: string,
	): Effect.Effect<AgentInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			const result = yield* this.decode(
				L.agentRow,
				yield* this.request("agent.get", { target }),
			);
			return agentInfo(result, target);
		}).pipe(
			Effect.catchIf(
				(error) => error.kind === "absent",
				() => Effect.succeed(undefined),
			),
		);
	}
	private submitLaunchPrompt(
		name: string,
		prompt: string,
		signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (signal?.aborted)
					return yield* Effect.fail(
						new MultiplexerError(
							"ownership-lost",
							"luvus",
							"effect ownership was lost",
						),
					);
				yield* this.request(
					"agent.prompt",
					{ target: name, text: prompt },
					signal,
				);
				for (let poll = 0; poll < 24; poll++) {
					yield* this.sleep(500);
					if (signal?.aborted)
						return yield* Effect.fail(
							new MultiplexerError(
								"ownership-lost",
								"luvus",
								"effect ownership was lost",
							),
						);
					const outcome = yield* Effect.either(this.agentGet(name));
					if (Either.isLeft(outcome)) {
						// Ownership loss is not "unconfirmed": surface it. Other
						// unreadable states stay unconfirmed so the prompt retries.
						if (outcome.left.kind === "ownership-lost")
							return yield* Effect.fail(outcome.left);
						continue;
					}
					const observed = outcome.right;
					if (!observed) continue;
					if (observed.status !== "idle" && observed.status !== "unknown")
						return;
				}
			}
			return yield* Effect.fail(
				new MultiplexerError(
					"unavailable",
					"luvus",
					`agent did not start on its launch prompt: ${name}`,
				),
			);
		});
	}
	agentStart(
		input: AgentStartInput,
	): Effect.Effect<AgentInfo, MultiplexerError> {
		return Effect.gen(this, function* () {
			const aborted = () =>
				new MultiplexerError(
					"ownership-lost",
					"luvus",
					"effect ownership was lost",
				);
			if (input.signal?.aborted) return yield* Effect.fail(aborted());
			if (Object.keys(input.environment).length) {
				const envFile = writeAgentRunEnv({
					cwd: input.cwd,
					...(input.runDirectory ? { runDirectory: input.runDirectory } : {}),
					runId: input.runId,
					environment: input.environment,
				});
				const marker = agentRunEnvMarker(envFile);
				yield* Effect.sync(() => fs.rmSync(marker, { force: true }));
				yield* this.paneRunRequest(
					input.paneId,
					`set -a; . ${shQuote(envFile)}; set +a; touch ${shQuote(marker)}; exec "${"$"}{SHELL:-sh}"`,
					input.signal,
				);
				for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++)
					yield* this.sleep(100);
				if (input.signal?.aborted) return yield* Effect.fail(aborted());
				if (!fs.existsSync(marker))
					return yield* Effect.fail(
						new MultiplexerError(
							"unavailable",
							"luvus",
							`run environment injection did not land in pane: ${input.paneId}`,
						),
					);
			}
			if (input.signal?.aborted) return yield* Effect.fail(aborted());
			const started = yield* this.decode(
				L.agentStartResult,
				yield* this.request(
					"agent.start",
					{
						name: input.name,
						kind: input.kind,
						pane: input.paneId,
						args: [...input.runtimeArgs],
						timeout_s: 300,
					},
					input.signal,
				),
			);
			if (!started.pane)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"luvus",
						"Luvus agent.start returned no pane identity",
					),
				);
			yield* this.submitLaunchPrompt(input.name, input.prompt, input.signal);
			return {
				name: input.name,
				paneId: started.pane,
				status: toAgentStatus(started.status ?? "idle"),
				...(started.kind ? { kind: started.kind } : {}),
			};
		});
	}
	agentPrompt(
		target: string,
		text: string,
		signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			if (signal?.aborted)
				return yield* Effect.fail(
					new MultiplexerError(
						"ownership-lost",
						"luvus",
						"effect ownership was lost",
					),
				);
			const live = yield* this.agentGet(target);
			if (!live)
				return yield* Effect.fail(
					new MultiplexerError(
						"absent",
						"luvus",
						`agent target not found: ${target}`,
					),
				);
			yield* this.request("agent.prompt", { target, text }, signal);
		});
	}
	notify(i: {
		title: string;
		body: string;
		needsAttention?: boolean;
	}): Effect.Effect<NotificationOutcome, MultiplexerError> {
		const text = i.body.trim() ? `${i.title}: ${i.body}` : i.title;
		const level = i.needsAttention ? "warning" : "info";
		const runCli = this.runCli;
		const options = this.cliOptions;
		return Effect.try({
			try: () => {
				runCli(
					["ui", "notification", "push", "--text", text, "--level", level],
					options,
				);
				return "shown" as NotificationOutcome;
			},
			catch: (error) => error,
		}).pipe(
			Effect.catchAll((error) => {
				const message = errorMessage(error);
				const code =
					typeof (error as { code?: unknown })?.code === "string"
						? String((error as { code?: unknown }).code)
						: undefined;
				if (
					[
						"denied",
						"unauthorized",
						"forbidden",
						"access_denied",
						"disabled",
					].includes(code ?? "") ||
					/denied|unauthorized|forbidden|not allowed|disabled/i.test(message)
				)
					return Effect.succeed("refused" as NotificationOutcome);
				return Effect.fail(this.fail(error));
			}),
		);
	}
	eventsSubscribe(
		handler: (event: { event: string; data: Record<string, unknown> }) => void,
	): Effect.Effect<unknown, MultiplexerError, Scope.Scope> {
		const socketPath = this.socketPath;
		if (!socketPath)
			return Effect.fail(
				new MultiplexerError(
					"unavailable",
					"luvus",
					"Luvus socket path is not configured",
				),
			);
		return luvusEventsSubscribe(socketPath, handler, {
			...(this.reconnectDelayMs !== undefined
				? { reconnectDelayMs: this.reconnectDelayMs }
				: {}),
		});
	}
	environment(): {
		envMarker: string;
		socketPath?: string;
		binPath?: string;
		paneId?: string;
	} {
		const binPath = this.cliOptions.binPath ?? process.env.LUVUS_BIN_PATH;
		const paneId = process.env.LUVUS_PANE_ID;
		return {
			envMarker: "LUVUS_ENV",
			...(this.socketPath ? { socketPath: this.socketPath } : {}),
			...(binPath ? { binPath } : {}),
			...(paneId ? { paneId } : {}),
		};
	}
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
