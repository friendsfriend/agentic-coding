// Herdr multiplexer adapter (add-multiplexer-adapters).
//
// Mechanical passthrough over the existing Herdr CLI calls: the command
// argument arrays, envelope decoding, launch confirmation, retry counts, and
// error text are the ones already in production. `HerdrLifecycle` is the
// moved launch/observe/stop boundary; `HerdrMultiplexer` implements the
// `MultiplexerPort` over it. Nothing here changes observable Herdr behavior.
import fs from "node:fs";
import { Effect, Either, type Scope } from "effect";
import { agentRunEnvMarker, writeAgentRunEnv } from "../agent-env.ts";
import {
	type AgentInfo,
	type AgentObservation,
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
import { decodeHerdrResult, directionBetween, type HerdrCli } from "./cli.ts";
import { herdrEventsSubscribe } from "./events.ts";
import * as H from "./schema.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toAgentStatus(value: unknown): AgentInfo["status"] {
	const observed = String(value ?? "unknown");
	return ["idle", "working", "blocked", "done"].includes(observed)
		? (observed as AgentInfo["status"])
		: "unknown";
}

const SHELL_NAMES = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"fish",
	"ksh",
	"mksh",
	"csh",
	"tcsh",
	"elvish",
	"xonsh",
	"nu",
	"pwsh",
	"powershell",
	"cmd",
]);

/** The Herdr launch/observe/stop boundary. Owns env injection, shell
 * readiness, launch-prompt confirmation, retry counts, and the one
 * unavailable-shell retry. */
export class HerdrLifecycle {
	/** How many launch-prompt submissions one launch may take, and how long each
	 * submission is watched for before it counts as dropped. */
	static readonly PROMPT_SUBMIT_ATTEMPTS = 3;
	static readonly PROMPT_CONFIRM_POLLS = 24;
	static readonly PROMPT_CONFIRM_INTERVAL_MS = 500;
	constructor(
		private readonly herdr: HerdrCli,
		private readonly sleep: (ms: number) => Effect.Effect<void> = (ms) =>
			Effect.sleep(ms),
		private readonly signal?: AbortSignal,
	) {}
	private call(
		args: string[],
		signal = this.signal,
	): Effect.Effect<unknown, Error> {
		const herdr = this.herdr;
		return Effect.gen(function* () {
			if (signal?.aborted)
				return yield* Effect.fail(new Error("effect ownership was lost"));
			return yield* Effect.tryPromise({
				try: () =>
					herdr.callAsync
						? herdr.callAsync(args, signal)
						: Promise.resolve(herdr.call(...args)),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			});
		});
	}
	waitForShell(
		paneId: string,
		signal = this.signal,
	): Effect.Effect<void, Error> {
		const self = this;
		return Effect.gen(function* () {
			for (let attempt = 0; attempt < 50; attempt++) {
				const raw = yield* self.call(
					["pane", "process-info", "--pane", paneId],
					signal,
				);
				const result = decodeHerdrResult(H.processInfoResult, raw);
				const info = result.process_info;
				const foreground = info?.foreground_processes ?? [];
				// Match Herdr's Linux/macOS available-shell check. Linux can report zsh
				// alongside startup helpers; seeing zsh somewhere in that job is not ready.
				const foregroundName = String(
					foreground[0]?.name ?? foreground[0]?.argv?.[0] ?? "",
				)
					.split(/[\\/]/)
					.at(-1)
					?.replace(/^-/, "")
					.replace(/\.exe$/, "")
					.toLowerCase();
				const shellIsForeground =
					typeof info?.shell_pid === "number" &&
					info.foreground_process_group_id === info.shell_pid &&
					foreground.length === 1 &&
					foreground[0]?.pid === info.shell_pid &&
					SHELL_NAMES.has(foregroundName ?? "");
				if (shellIsForeground) return;
				yield* self.sleep(100);
			}
			throw new Error(`pane did not reach foreground shell: ${paneId}`);
		});
	}
	start(input: AgentStartInput): Effect.Effect<AgentInfo, Error> {
		const self = this;
		return Effect.gen(function* () {
			yield* self.waitForShell(input.paneId, input.signal);
			// herdr 0.8.0 has no agent-level env flag and spawns agents through the pane
			// shell, so the run environment must be injected into the pane first. Source
			// a 0600 env file (secrets stay out of the terminal scrollback), then keep a
			// shell alive with the exported vars for `agent start` to inherit.
			const envFile = writeAgentRunEnv({
				cwd: input.cwd,
				...(input.runDirectory ? { runDirectory: input.runDirectory } : {}),
				runId: input.runId,
				environment: input.environment,
			});
			// pane run is asynchronous and waitForShell cannot tell the pre-injection
			// shell from the exec'd one; a marker touched after sourcing proves the
			// env landed before `agent start` inherits it.
			const marker = agentRunEnvMarker(envFile);
			yield* Effect.sync(() => fs.rmSync(marker, { force: true }));
			yield* self.call(
				[
					"pane",
					"run",
					input.paneId,
					`set -a; . ${shQuote(envFile)}; set +a; touch ${shQuote(marker)}; exec "${"$"}{SHELL:-sh}"`,
				],
				input.signal,
			);
			for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++) {
				if (input.signal?.aborted)
					return yield* Effect.fail(new Error("effect ownership was lost"));
				yield* self.sleep(100);
			}
			if (!fs.existsSync(marker))
				throw new Error(
					`run environment injection did not land in pane: ${input.paneId}`,
				);
			yield* self.waitForShell(input.paneId, input.signal);
			const invoke = () =>
				self.call(
					[
						"agent",
						"start",
						input.name,
						"--kind",
						input.kind,
						"--pane",
						input.paneId,
						"--",
						...input.runtimeArgs,
					],
					input.signal,
				);
			let invokeOutcome = yield* Effect.either(invoke());
			if (
				Either.isLeft(invokeOutcome) &&
				String(invokeOutcome.left?.message ?? "").includes(
					"not an available shell",
				)
			) {
				yield* self.sleep(250);
				yield* self.waitForShell(input.paneId, input.signal);
				invokeOutcome = yield* Effect.either(invoke());
			}
			const result = Either.isLeft(invokeOutcome)
				? yield* Effect.fail(invokeOutcome.left)
				: invokeOutcome.right;
			const started = agent(result);
			const paneId = String(started.pane_id ?? input.paneId);
			const live = agent(
				yield* self.call(["agent", "get", paneId], input.signal),
			);
			if (String(live.pane_id) !== paneId)
				throw new Error(`agent get mismatch for ${paneId}`);
			yield* self.submitLaunchPrompt(paneId, input.prompt, input.signal);
			return {
				name: input.name,
				paneId,
				status: toAgentStatus(live.agent_status),
				...(live.tab_id ? { tabId: String(live.tab_id) } : {}),
				...(live.session_id ? { sessionId: String(live.session_id) } : {}),
			};
		});
	}
	/** Deliver the launch prompt and confirm the runtime left idle for it. Herdr
	 * reports a known runtime as ready through an idle fallback the moment its
	 * process appears, so `agent start` can return while the runtime is still
	 * booting and a prompt submitted into that window is dropped without any
	 * error. The run would then stay parked on a live, unprompted agent, so the
	 * submission is confirmed by the agent leaving idle and re-submitted while it
	 * never does. A submission that was only partially consumed (text landed, the
	 * submit key did not) is re-sent on top of the retained text; clearing it
	 * would need per-runtime input semantics this boundary deliberately avoids. */
	private submitLaunchPrompt(
		paneId: string,
		prompt: string,
		signal?: AbortSignal,
	): Effect.Effect<void, Error> {
		const self = this;
		return Effect.gen(function* () {
			for (
				let attempt = 0;
				attempt < HerdrLifecycle.PROMPT_SUBMIT_ATTEMPTS;
				attempt++
			) {
				yield* self.call(["agent", "prompt", paneId, prompt], signal);
				if (yield* self.promptTookEffect(paneId, signal)) return;
			}
			return yield* Effect.fail(
				new Error(`agent did not start on its launch prompt: ${paneId}`),
			);
		});
	}
	/** Watch the agent through the same boundary the engine observes it, so a
	 * prompt that did land is never submitted twice. An unreadable state counts
	 * as unconfirmed: a launch may retry, a duplicated assignment may not. */
	private promptTookEffect(
		paneId: string,
		signal?: AbortSignal,
	): Effect.Effect<boolean> {
		const self = this;
		return Effect.gen(function* () {
			for (
				let attempt = 0;
				attempt < HerdrLifecycle.PROMPT_CONFIRM_POLLS;
				attempt++
			) {
				yield* self.sleep(HerdrLifecycle.PROMPT_CONFIRM_INTERVAL_MS);
				const observed = yield* Effect.either(
					self.call(["agent", "get", paneId], signal),
				);
				if (Either.isLeft(observed)) return false;
				const status = agentStatus(observed.right);
				if (status === "") return false;
				if (status !== "idle") return true;
			}
			return false;
		});
	}
	prompt(
		target: string,
		message: string,
		signal = this.signal,
	): Effect.Effect<void, Error> {
		const self = this;
		return Effect.gen(function* () {
			agent(yield* self.call(["agent", "get", target], signal));
			yield* self.call(["agent", "prompt", target, message], signal);
		});
	}
	observe(
		target: string,
		signal = this.signal,
	): Effect.Effect<AgentObservation, Error> {
		const self = this;
		return Effect.gen(function* () {
			const live = agent(yield* self.call(["agent", "get", target], signal));
			return {
				status: toAgentStatus(live.agent_status),
				paneId: String(live.pane_id ?? target),
				...(live.session_id ? { sessionId: String(live.session_id) } : {}),
			};
		});
	}
	stop(target: string, signal = this.signal): Effect.Effect<void, Error> {
		return this.call(["pane", "close", target], signal);
	}
}

function agent(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || !("agent" in value))
		throw new Error("Herdr returned no agent");
	const item = (value as { agent: unknown }).agent;
	if (!item || typeof item !== "object")
		throw new Error("Herdr returned invalid agent");
	return item as Record<string, unknown>;
}
/** Agent state from an `agent get` envelope, empty when it cannot be read. */
function agentStatus(value: unknown): string {
	try {
		return String(agent(value).agent_status ?? "");
	} catch {
		return "";
	}
}
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rectOf(pane: {
	readonly x?: number;
	readonly y: number;
	readonly width?: number;
	readonly height?: number;
}): { x: number; y: number; width: number; height: number } {
	return {
		x: pane.x ?? 0,
		y: pane.y,
		width: pane.width ?? 0,
		height: pane.height ?? 0,
	};
}

export interface HerdrAdapterOptions {
	binPath?: string;
	socketPath?: string;
	paneId?: string;
	sleep?: (ms: number) => Effect.Effect<void>;
}

/** The Herdr `MultiplexerPort` implementation. */
export class HerdrMultiplexer implements MultiplexerPort {
	readonly id = "herdr" as const;
	readonly lifecycle: HerdrLifecycle;
	private readonly binPath?: string;
	private readonly socketPath?: string;
	private readonly paneId?: string;
	constructor(
		private readonly cli: HerdrCli,
		options: HerdrAdapterOptions = {},
	) {
		this.lifecycle = new HerdrLifecycle(
			cli,
			options.sleep ?? ((ms) => Effect.sleep(ms)),
		);
		this.binPath = options.binPath;
		this.socketPath = options.socketPath;
		this.paneId = options.paneId;
	}
	/** Classify one raw adapter error the same way for every operation. */
	private fail(error: unknown): MultiplexerError {
		if (error instanceof MultiplexerError) return error;
		const message = errorMessage(error);
		const code =
			typeof (error as { code?: unknown })?.code === "string"
				? String((error as { code?: unknown }).code)
				: undefined;
		const { kind } = classifyMessage(message, code);
		return new MultiplexerError(kind, "herdr", message, { cause: error });
	}
	/** One classified CLI call. The raw argv never escapes this class. */
	private call(
		args: string[],
		signal?: AbortSignal,
	): Effect.Effect<unknown, MultiplexerError> {
		const cli = this.cli;
		return Effect.gen(function* () {
			if (signal?.aborted)
				return yield* Effect.fail(
					new MultiplexerError(
						"ownership-lost",
						"herdr",
						"effect ownership was lost",
					),
				);
			return yield* Effect.tryPromise({
				try: () =>
					cli.callAsync
						? cli.callAsync(args, signal)
						: Promise.resolve(cli.call(...args)),
				catch: (error) => {
					const message = errorMessage(error);
					const code =
						typeof (error as { code?: unknown })?.code === "string"
							? String((error as { code?: unknown }).code)
							: undefined;
					const { kind } = classifyMessage(message, code);
					return new MultiplexerError(kind, "herdr", message, {
						cause: error,
					});
				},
			});
		});
	}
	private decode<A>(
		schema: Parameters<typeof decodeHerdrResult<A>>[0],
		raw: unknown,
	): Effect.Effect<A, MultiplexerError> {
		return Effect.try({
			try: () => decodeHerdrResult(schema, raw),
			catch: (error) =>
				new MultiplexerError("invalid-response", "herdr", errorMessage(error), {
					cause: error,
				}),
		});
	}
	workspaceCreate(i: {
		cwd: string;
		label: string;
	}): Effect.Effect<WorkspaceInfo, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call([
				"workspace",
				"create",
				"--cwd",
				i.cwd,
				"--label",
				i.label,
			]);
			const result = yield* this.decode(H.workspaceCreateResult, raw);
			const workspace = result.workspace?.workspace_id;
			if (!workspace)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"Herdr workspace create returned no workspace",
					),
				);
			return { workspaceId: workspace, label: i.label };
		});
	}
	workspaceGet(
		idOrLabel: string,
	): Effect.Effect<WorkspaceInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["workspace", "get", idOrLabel]);
			const result = yield* this.decode(H.workspaceGetResult, raw);
			const workspace = result.workspace;
			if (!workspace?.workspace_id) return undefined;
			return {
				workspaceId: workspace.workspace_id,
				...(workspace.label ? { label: workspace.label } : {}),
				...(workspace.name ? { name: workspace.name } : {}),
				...(workspace.status ? { status: workspace.status } : {}),
				...(workspace.closed_at ? { closedAt: workspace.closed_at } : {}),
			};
		}).pipe(
			Effect.catchIf(
				(error) => error.kind === "absent",
				() => Effect.succeed(undefined),
			),
		);
	}
	workspaceList(): Effect.Effect<WorkspaceInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["workspace", "list"]);
			const result = yield* this.decode(H.workspaceListResult, raw);
			return (result.workspaces ?? []).flatMap((workspace) =>
				workspace.workspace_id
					? [
							{
								workspaceId: workspace.workspace_id,
								...(workspace.label ? { label: workspace.label } : {}),
								...(workspace.name ? { name: workspace.name } : {}),
								...(workspace.status ? { status: workspace.status } : {}),
								...(workspace.closed_at
									? { closedAt: workspace.closed_at }
									: {}),
							},
						]
					: [],
			);
		});
	}
	workspaceFocus(id: string): Effect.Effect<void, MultiplexerError> {
		return this.call(["workspace", "focus", id]).pipe(Effect.asVoid);
	}
	workspaceClose(id: string): Effect.Effect<void, MultiplexerError> {
		return this.call(["workspace", "close", id]).pipe(Effect.asVoid);
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
			const raw = yield* this.call([
				"worktree",
				"create",
				"--cwd",
				i.cwd,
				"--branch",
				i.branch,
				...(i.base ? ["--base", i.base] : []),
				"--label",
				i.label,
				"--no-focus",
			]);
			const result = yield* this.decode(H.worktreeCreateResult, raw);
			const workspace = result.workspace?.workspace_id;
			const worktree = result.worktree?.path;
			if (!workspace || !worktree)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"Herdr worktree setup returned incomplete identity",
					),
				);
			return {
				workspace: { workspaceId: workspace, label: i.label },
				worktree,
			};
		});
	}
	tabList(workspaceId: string): Effect.Effect<TabInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["tab", "list", "--workspace", workspaceId]);
			const result = yield* this.decode(H.tabListResult, raw);
			return (result.tabs ?? []).flatMap((tab) =>
				tab.tab_id
					? [
							{
								tabId: tab.tab_id,
								...(tab.label ? { label: tab.label } : {}),
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
			const args = ["tab", "create", "--workspace", i.workspaceId];
			if (i.cwd) args.push("--cwd", i.cwd);
			if (i.label) args.push("--label", i.label);
			if (i.focus) args.push("--focus");
			const raw = yield* this.call(args);
			const result = yield* this.decode(H.tabCreateResult, raw);
			const pane = result.root_pane?.pane_id;
			if (!pane)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"Herdr tab create returned no pane",
					),
				);
			// Herdr 0.8 returns the root pane and tab id with the create; older
			// envelopes omit the tab id, so resolve the created pane's real tab and
			// fail loudly rather than fabricating a tab identity.
			if (result.root_pane?.tab_id)
				return { tabId: result.root_pane.tab_id, rootPaneId: pane };
			const createdPane = yield* this.paneGet(pane);
			if (!createdPane?.tabId)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"Herdr tab create returned no tab identity",
					),
				);
			return { tabId: createdPane.tabId, rootPaneId: pane };
		});
	}
	tabRename(
		tabId: string,
		label: string,
	): Effect.Effect<void, MultiplexerError> {
		return this.call(["tab", "rename", tabId, label]).pipe(Effect.asVoid);
	}
	tabFocus(tabId: string): Effect.Effect<void, MultiplexerError> {
		return this.call(["tab", "focus", tabId]).pipe(Effect.asVoid);
	}
	tabClose(tabId: string): Effect.Effect<void, MultiplexerError> {
		return this.call(["tab", "close", tabId]).pipe(Effect.asVoid);
	}
	paneList(i?: {
		workspaceId?: string;
	}): Effect.Effect<PaneInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(
				i?.workspaceId
					? ["pane", "list", "--workspace", i.workspaceId]
					: ["pane", "list"],
			);
			const result = yield* this.decode(H.paneListResult, raw);
			return (result.panes ?? []).flatMap((pane) =>
				pane.pane_id
					? [
							{
								paneId: pane.pane_id,
								...(pane.tab_id ? { tabId: pane.tab_id } : {}),
								...(pane.workspace_id
									? { workspaceId: pane.workspace_id }
									: {}),
								...(pane.agent ? { agent: pane.agent } : {}),
								...(pane.agent_status
									? { agentStatus: pane.agent_status }
									: {}),
								...(pane.terminal_title_stripped
									? { title: pane.terminal_title_stripped }
									: {}),
							},
						]
					: [],
			);
		});
	}
	paneGet(
		paneId: string,
	): Effect.Effect<PaneInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["pane", "get", paneId]);
			const result = yield* this.decode(H.paneGetResult, raw);
			const pane = result.pane;
			if (!pane?.pane_id) return undefined;
			return {
				paneId: pane.pane_id,
				...(pane.tab_id ? { tabId: pane.tab_id } : {}),
				...(pane.workspace_id ? { workspaceId: pane.workspace_id } : {}),
				...(pane.agent ? { agent: pane.agent } : {}),
				...(pane.agent_status ? { agentStatus: pane.agent_status } : {}),
			};
		}).pipe(
			Effect.catchIf(
				(error) => error.kind === "absent",
				() => Effect.succeed(undefined),
			),
		);
	}
	paneLayout(anchor: string): Effect.Effect<PaneLayout, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["pane", "layout", "--pane", anchor]);
			const result = yield* this.decode(H.paneLayoutResult, raw);
			const layout = result.layout;
			return {
				...(layout?.focused_pane_id
					? { focusedPaneId: layout.focused_pane_id }
					: {}),
				panes: (layout?.panes ?? []).flatMap((pane) =>
					pane.pane_id
						? [
								{
									paneId: pane.pane_id,
									y: pane.rect?.y ?? 0,
									x: pane.rect?.x ?? 0,
									width: pane.rect?.width ?? 0,
									height: pane.rect?.height ?? 0,
								},
							]
						: [],
				),
			};
		});
	}
	paneSplit(i: {
		target: string;
		direction: "right" | "down";
		ratio?: number;
	}): Effect.Effect<{ paneId: string; tabId?: string }, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call([
				"pane",
				"split",
				i.target,
				"--direction",
				i.direction,
				"--ratio",
				String(i.ratio ?? 0.5),
			]);
			const result = yield* this.decode(H.paneSplitResult, raw);
			const pane = result.pane;
			if (!pane?.pane_id)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"Herdr pane split returned no pane",
					),
				);
			return {
				paneId: pane.pane_id,
				...(pane.tab_id ? { tabId: pane.tab_id } : {}),
			};
		});
	}
	paneRun(
		paneId: string,
		command: string,
	): Effect.Effect<void, MultiplexerError> {
		return this.call(["pane", "run", paneId, command]).pipe(Effect.asVoid);
	}
	paneFocus(i: {
		paneId: string;
		workspaceId?: string;
	}): Effect.Effect<void, MultiplexerError> {
		return Effect.gen(this, function* () {
			const target = i.paneId;
			let workspace = i.workspaceId;
			if (!workspace) {
				const pane = yield* this.paneGet(target);
				workspace = pane?.workspaceId;
			}
			if (workspace) yield* this.workspaceFocus(workspace);
			const pane = yield* this.paneGet(target);
			const tabId = pane?.tabId;
			if (!tabId)
				return yield* Effect.fail(
					new MultiplexerError(
						"invalid-response",
						"herdr",
						"agent pane has no tab",
					),
				);
			yield* this.tabFocus(tabId);
			for (let attempt = 0; attempt < 8; attempt++) {
				const layout = yield* this.paneLayout(target);
				if (layout.focusedPaneId === target) return;
				const current = layout.panes.find(
					(item) => item.paneId === layout.focusedPaneId,
				);
				const targetPane = layout.panes.find((item) => item.paneId === target);
				if (!current || !targetPane)
					return yield* Effect.fail(
						new MultiplexerError(
							"invalid-response",
							"herdr",
							"agent pane not present in focused tab",
						),
					);
				yield* this.call([
					"pane",
					"focus",
					"--pane",
					current.paneId,
					"--direction",
					directionBetween(rectOf(current), rectOf(targetPane)),
				]);
			}
			return yield* Effect.fail(
				new MultiplexerError(
					"invalid-response",
					"herdr",
					"could not reach agent pane",
				),
			);
		});
	}
	waitForShell(paneId: string): Effect.Effect<void, MultiplexerError> {
		return this.lifecycle
			.waitForShell(paneId)
			.pipe(Effect.mapError((error) => this.fail(error)));
	}
	paneForegroundProcesses(
		paneId: string,
	): Effect.Effect<ProcessIdentity[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["pane", "process-info", "--pane", paneId]);
			const result = yield* this.decode(H.processInfoResult, raw);
			return (result.process_info?.foreground_processes ?? []).flatMap(
				(process) => {
					const name = String(process.name ?? process.argv?.[0] ?? "").trim();
					if (!name) return [];
					return [
						{
							name,
							...(typeof process.pid === "number" ? { pid: process.pid } : {}),
						},
					];
				},
			);
		});
	}
	paneClose(paneId: string): Effect.Effect<void, MultiplexerError> {
		return this.call(["pane", "close", paneId]).pipe(Effect.asVoid);
	}
	agentList(): Effect.Effect<AgentInfo[], MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["agent", "list"]);
			const result = yield* this.decode(H.agentListResult, raw);
			return (result.agents ?? []).flatMap((row) =>
				row.pane_id
					? [
							{
								name: String(row.agent ?? row.pane_id),
								paneId: row.pane_id,
								status: toAgentStatus(row.agent_status),
								...(row.tab_id ? { tabId: row.tab_id } : {}),
								...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
							},
						]
					: [],
			);
		});
	}
	agentGet(
		target: string,
	): Effect.Effect<AgentInfo | undefined, MultiplexerError> {
		return Effect.gen(this, function* () {
			const raw = yield* this.call(["agent", "get", target]);
			const result = yield* this.decode(H.agentGetResult, raw);
			const live = result.agent;
			if (!live?.pane_id) return undefined;
			return {
				name: String(live.agent ?? target),
				paneId: String(live.pane_id),
				status: toAgentStatus(live.agent_status),
				...(live.tab_id ? { tabId: String(live.tab_id) } : {}),
				...(live.session_id ? { sessionId: String(live.session_id) } : {}),
			};
		}).pipe(
			Effect.catchIf(
				(error) => error.kind === "absent",
				() => Effect.succeed(undefined),
			),
		);
	}
	agentStart(
		input: AgentStartInput,
	): Effect.Effect<AgentInfo, MultiplexerError> {
		return this.lifecycle
			.start(input)
			.pipe(Effect.mapError((error) => this.fail(error)));
	}
	agentPrompt(
		target: string,
		text: string,
		signal?: AbortSignal,
	): Effect.Effect<void, MultiplexerError> {
		return this.lifecycle
			.prompt(target, text, signal)
			.pipe(Effect.mapError((error) => this.fail(error)));
	}
	notify(i: {
		title: string;
		body: string;
		needsAttention?: boolean;
	}): Effect.Effect<NotificationOutcome, MultiplexerError> {
		const args = ["notification", "show", i.title, "--body", i.body];
		if (i.needsAttention) args.push("--sound", "request");
		return this.call(args).pipe(
			Effect.map((result) => {
				if (!result || typeof result !== "object") return "shown";
				const record = result as Record<string, unknown>;
				const raw = record.delivery ?? record.status ?? record.outcome;
				if (typeof raw !== "string") return "shown";
				const normalized = raw.toLowerCase();
				return (
					[
						"shown",
						"disabled",
						"rate_limited",
						"busy",
						"no_foreground_client",
						"refused",
						"unknown",
					].includes(normalized)
						? normalized
						: "unknown"
				) as NotificationOutcome;
			}),
		);
	}
	eventsSubscribe(
		handler: (event: { event: string; data: Record<string, unknown> }) => void,
	): Effect.Effect<unknown, MultiplexerError, Scope.Scope> {
		return herdrEventsSubscribe(handler, {
			...(this.socketPath ? { socketPath: this.socketPath } : {}),
		});
	}
	environment(): {
		envMarker: string;
		socketPath?: string;
		binPath?: string;
		paneId?: string;
	} {
		const socketPath = this.socketPath ?? process.env.HERDR_SOCKET_PATH;
		const binPath = this.binPath ?? process.env.HERDR_BIN_PATH;
		const paneId = this.paneId ?? process.env.HERDR_PANE_ID;
		return {
			envMarker: "HERDR_ENV",
			...(socketPath ? { socketPath } : {}),
			...(binPath ? { binPath } : {}),
			...(paneId ? { paneId } : {}),
		};
	}
}
