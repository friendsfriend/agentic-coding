// Home → Orchestrator: the chat page of the one persistent orchestrator
// session. It renders the shared durable-session transcript
// (`AgentSessionView`) over the dedicated orchestrator host (`session.ts`) and
// owns its keys through the `orchestrator.view` keymap field: the transcript
// layer while the prompt is up, the model/thinking picker layer while a picker
// is open. The prompt input itself owns text keys.

import {
	setActiveKeybindCatalog,
	useTerminalDimensions,
} from "@agentic-coding/ui";
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	untrack,
} from "solid-js";
import type { WorkflowEventSubscription } from "../../contracts/workflow-events.ts";
import type {
	AgentSessionBlock,
	AgentSessionMetadata,
} from "../dash/agent-session.ts";
import { submissionStateNote } from "../dash/agent-session.ts";
import { agentSessionKeybindCatalog } from "../dash/keybinds.ts";
import { notify } from "../dash/notifications.ts";
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "../dash/ui/AgentSessionView.tsx";
import { loadAgentConfig } from "../data/agents.ts";
import {
	loadEventSubscriptions,
	removeEventSubscription,
} from "../data/orchestrator-events.ts";
import {
	loadPromptHistory,
	MAX_PROMPT_HISTORY,
	savePromptHistory,
} from "../shared/preferences.ts";
import { configuredMonitorMode } from "./monitor.ts";
import type { OrchestratorModel, OrchestratorSession } from "./session.ts";
import { orchestratorSessionCommands } from "./session-commands.ts";
import {
	guardOrchestratorSubmit,
	refreshOrchestratorGateBlocks,
} from "./submission.ts";
import {
	orchestratorSubscriptionCommands,
	removalNotice,
	subscriptionsNotice,
} from "./subscription-commands.ts";

export interface OrchestratorViewProps {
	readonly keymap: Keymap<Renderable, KeyEvent>;
	/** The page body holds focus (not the workspace sidebar). */
	readonly active: () => boolean;
	/** A shell overlay is on top: the prompt must blur. */
	readonly overlay: () => boolean;
	/** Leave the page (Escape, `/hide`). */
	readonly onBack: () => void;
	/** Open the shell's `?` keybind help. */
	readonly onHelp: () => void;
	/** The shell's primary repository, shared with the OpenCode page. */
	readonly opencodeCwd?: string;
}

/** Footer and `?` catalog of the Orchestrator page: the session view's keys,
 * with Escape leaving for Home. */
export function orchestratorKeybindCatalog() {
	return agentSessionKeybindCatalog().map((section) => ({
		...section,
		title: "Orchestrator",
		keybinds: section.keybinds.map((keybind) =>
			keybind.key === "Esc" ? { ...keybind, action: "Back to Home" } : keybind,
		),
	}));
}

/** The configured orchestrator model, or the host default when unreadable. */
async function configuredModel(): Promise<OrchestratorModel> {
	try {
		const loaded = await loadAgentConfig();
		const agents = loaded?.agents as
			| { orchestrator?: OrchestratorModel }
			| undefined;
		return agents?.orchestrator ?? {};
	} catch {
		return {};
	}
}

export function OrchestratorView(props: OrchestratorViewProps) {
	const dimensions = useTerminalDimensions();
	const [session, setSession] = createSignal<OrchestratorSession>();
	/** Wait for the host snapshot before accepting input, so configured defaults
	 * are known before the submit gate judges the conversation. */
	const [sessionReady, setSessionReady] = createSignal(false);
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{
			id: "route:connecting",
			kind: "notice",
			tone: "muted",
			text: "Starting the orchestrator…",
		},
	]);
	/** Local transcript notices the host's documents cannot carry: an aborted
	 * manual compaction places no summary, and only this client knows one was in
	 * flight when it asked for the abort. */
	const [notices, setNotices] = createSignal<readonly AgentSessionBlock[]>([]);
	const [metadata, setMetadata] = createSignal<AgentSessionMetadata>({
		working: false,
	});
	const [models, setModels] = createSignal<readonly string[]>([]);
	const [thinkingLevels, setThinkingLevels] = createSignal<readonly string[]>(
		[],
	);
	const [contextWindows, setContextWindows] = createSignal<
		Readonly<Record<string, number>>
	>({});
	const [draft, setDraft] = createSignal("");
	const [history, setHistory] = createSignal<readonly string[]>(
		loadPromptHistory(),
	);
	const [pickerOpen, setPickerOpen] = createSignal(false);
	/** The active event subscriptions, so `/subscriptions` can list and remove
	 * them without the view performing the I/O itself. */
	const [subscriptions, setSubscriptions] = createSignal<
		readonly WorkflowEventSubscription[]
	>([]);
	/** Why the last subscription read failed, so a failed read is reported as a
	 * failure instead of rendered as an empty list. */
	const [subscriptionsError, setSubscriptionsError] = createSignal<
		string | undefined
	>();
	let stopWatch: (() => void) | undefined;
	let stopProjection = () => {};
	let scrollBox: ScrollBoxRenderable | undefined;
	let pickerHandler: ((event: KeyEvent) => boolean) | undefined;
	let disposed = false;

	/** The effective master switch (`[agents.orchestrator] monitor`), read when
	 * the listing is built: a listed `wake` mode must never imply delivery the
	 * switch forbids. */
	const monitorMode = (): "wake" | "notify" | "off" => configuredMonitorMode();

	const client = async () => {
		const current = session();
		if (!current) throw new Error("the orchestrator session is not ready");
		const { HostClient } = await import("../../agent-host/client.ts");
		return { client: new HostClient(current.hostSocket), current };
	};

	/** (Re)connect: ensure the host and session, then stream its transcript. */
	const connect = async (fresh = false) => {
		setSessionReady(false);
		stopWatch?.();
		stopProjection();
		stopWatch = undefined;
		try {
			const [{ openOrchestratorSession }, view, model] = await Promise.all([
				import("./session.ts"),
				import("../dash/agent-session.ts"),
				configuredModel(),
			]);
			const opened = await openOrchestratorSession({
				fresh,
				model,
				...(props.opencodeCwd ? { opencodeCwd: props.opencodeCwd } : {}),
			});
			if (disposed) return;
			setSession(opened);
			const { HostClient, watchStream } = await import(
				"../../agent-host/client.ts"
			);
			const host = new HostClient(opened.hostSocket);
			void host
				.catalog()
				.then((catalog) => {
					setModels([...catalog.models]);
					setThinkingLevels([...catalog.thinkingLevels]);
					setContextWindows(catalog.contextWindows ?? {});
				})
				.catch(() => undefined);
			// The stream stays live across a host restart or a dropped socket:
			// `watchStream` reconnects instead of freezing the transcript on the last
			// frame. The transcript stays once a frame has arrived and refreshes
			// silently on reconnect; before the first frame a drop keeps the
			// "Connecting…" placeholder rather than going blank.
			let receivedFrame = false;
			const cache = new view.AgentSessionProjectionCache();
			const stop = watchStream(host, opened.runId, {
				onFrame: (value) => {
					if (session()?.runId !== opened.runId) return;
					receivedFrame = true;
					stopProjection();
					stopProjection = view.streamAgentSessionProjection(
						view.createAgentSessionProjection(value, {
							notices: notices(),
							cache,
						}),
						setBlocks,
					);
					setMetadata(view.readAgentSessionMetadata(value));
					setSessionReady(true);
				},
				onState: (state) => {
					if (session()?.runId !== opened.runId) return;
					if (state !== "open" && !receivedFrame)
						setBlocks([
							{
								id: "route:connecting",
								kind: "notice",
								tone: "muted",
								text: "Connecting…",
							},
						]);
				},
			});
			if (disposed || session()?.runId !== opened.runId) {
				stop();
				return;
			}
			stopWatch = stop;
		} catch (error) {
			if (disposed) return;
			setBlocks([
				{
					id: "route:host-error",
					kind: "error",
					tone: "error",
					text:
						"Could not start the orchestrator: " +
						(error instanceof Error ? error.message : String(error)),
				},
			]);
		}
	};

	onMount(() => {
		void connect();
		void refreshSubscriptions();
	});

	createEffect(() => {
		// The session snapshot includes configured defaults as well as live picker
		// choices. Keep any local error accurate while a partial selection changes,
		// and remove it as soon as both settings are available, retaining blocked
		// user messages so the developer can resend them.
		const selection = metadata();
		untrack(() => {
			setNotices((current) =>
				refreshOrchestratorGateBlocks(current, selection),
			);
			setBlocks((current) => refreshOrchestratorGateBlocks(current, selection));
		});
	});

	/** Re-read the session's event subscriptions (through the data layer). A
	 * failed read is kept, so the listing can say the list may be stale instead
	 * of claiming there is nothing. */
	const refreshSubscriptions = async (): Promise<void> => {
		try {
			const loaded = await loadEventSubscriptions({ refresh: true });
			if (disposed) return;
			// A superseded read (a newer read for the same key started first) is
			// "nothing new", not "nothing there": keep the list and the error state.
			if (loaded === undefined) return;
			setSubscriptions([...loaded]);
			setSubscriptionsError(undefined);
		} catch (error) {
			if (disposed) return;
			setSubscriptionsError(
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	/** Write (or replace) the transcript's `local:subscriptions` block from the
	 * current signals. Returns the read's failure message when the last read
	 * failed, so a caller can report it instead of rendering a stale list. */
	const renderSubscriptions = (): string | undefined => {
		const failure = subscriptionsError();
		if (failure !== undefined) {
			setNotices((notice) => [
				...notice.filter((block) => block.id !== "local:subscriptions"),
				{
					id: "local:subscriptions",
					kind: "error",
					tone: "error",
					text: `Could not read the event subscriptions: ${failure} — the list could not be refreshed; any remove command shown in the prompt palette comes from the last successful read`,
				},
			]);
			return failure;
		}
		const current = subscriptions();
		setNotices((notice) => [
			...notice.filter((block) => block.id !== "local:subscriptions"),
			{
				id: "local:subscriptions",
				kind: "notice",
				tone: "muted",
				text: `Event subscriptions:\n${subscriptionsNotice(current, monitorMode())}`,
			},
		]);
		return undefined;
	};

	/** `/subscriptions`: list them compactly in the transcript, with the master
	 * switch that decides whether any of them can deliver. */
	const listSubscriptions = () => {
		void (async () => {
			await refreshSubscriptions();
			const failure = renderSubscriptions();
			if (failure !== undefined) {
				notify(`Could not read the event subscriptions: ${failure}`, "error");
				return;
			}
			const current = subscriptions();
			notify(
				current.length === 0
					? "No event subscription is active"
					: `${current.length} event subscription${current.length === 1 ? "" : "s"} listed in the transcript`,
				"info",
			);
		})();
	};

	/** Remove one subscription from the list. The listing is rebuilt from the
	 * refreshed signal, so the transcript and the confirmation agree; the
	 * removal notice is the only toast this path adds. */
	const unsubscribe = (subscriptionId: string) => {
		void (async () => {
			try {
				const removed = await removeEventSubscription(subscriptionId);
				await refreshSubscriptions();
				renderSubscriptions();
				notify(
					removalNotice(subscriptionId, removed),
					removed ? "success" : "info",
				);
			} catch (error) {
				notify(
					`Could not remove ${subscriptionId}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		})();
	};

	const submit = (text: string) => {
		guardOrchestratorSubmit(
			text,
			metadata(),
			`local:orchestrator-model-gate:${crypto.randomUUID()}`,
			{
				onSubmit: (message) => {
					void (async () => {
						try {
							const { client: host, current } = await client();
							const response = await host.submit(
								current.runId,
								message,
								crypto.randomUUID(),
								"steer",
							);
							const note = submissionStateNote(response.workflowState);
							if (note) notify(note.text, note.tone);
						} catch (error) {
							notify(
								`Could not send message: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}
					})();
				},
				onBlocked: (localBlocks) => {
					setNotices((current) => [...current, ...localBlocks]);
					setBlocks((current) => [...current, ...localBlocks]);
				},
			},
		);
	};
	const configure = (change: { model?: string; thinking?: string }) => {
		void (async () => {
			try {
				const { client: host, current } = await client();
				await host.configureRun(current.runId, change);
				setMetadata((current) => ({ ...current, ...change }));
				notify(
					change.model
						? `Model set to ${change.model} for this session`
						: `Thinking level set to ${change.thinking ?? ""} for this session`,
					"success",
				);
			} catch (error) {
				notify(
					`Could not apply the change: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		})();
	};
	const abort = () => {
		void (async () => {
			try {
				const { client: host, current } = await client();
				const compacting = blocks().some(
					(block) => block.kind === "compaction" && block.live === true,
				);
				await host.abort(current.runId);
				if (compacting) {
					setNotices((current) => [
						...current.filter(
							(notice) => notice.id !== "local:compaction-aborted",
						),
						{
							id: "local:compaction-aborted",
							kind: "notice",
							tone: "warning",
							text: "Compaction aborted — a compaction in flight was cancelled and places no summary",
						},
					]);
					notify(
						"Abort requested — a compaction in flight is cancelled and places no summary",
						"info",
					);
				} else notify("Abort requested", "info");
			} catch (error) {
				notify(
					`Could not abort: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		})();
	};
	/** `/compact [instructions]`: the orchestrator's own host serves it through the
	 * same protocol request the dashboard uses. */
	const compact = (instructions?: string) => {
		void (async () => {
			try {
				const { client: host, current } = await client();
				const answer = await host.compactRun(current.runId, instructions);
				switch (answer.status) {
					case "started":
						notify(
							"Compaction started — the summary is placed at the next turn boundary",
							"info",
						);
						return;
					case "already-compacting":
						notify(
							`Already compacting (${answer.reason ?? "automatic"}) — no second summary was started`,
							"warning",
						);
						return;
					case "nothing-to-compact":
						notify(
							"Nothing to compact — this conversation holds no range a summary could replace",
							"info",
						);
						return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(
					message.includes("unknown-run")
						? "This session has finished; nothing was compacted"
						: `Could not compact: ${message}`,
					message.includes("unknown-run") ? "info" : "error",
				);
			}
		})();
	};
	const startNewSession = () => {
		setDraft("");
		setPickerOpen(false);
		setSession(undefined);
		setNotices([]);
		setBlocks([
			{
				id: "route:connecting",
				kind: "notice",
				tone: "muted",
				text: "Starting a new orchestrator session…",
			},
		]);
		setMetadata({ working: false });
		void connect(true);
	};
	const rememberInput = (text: string) => {
		if (history().at(-1) === text) return;
		const next = [...history(), text].slice(-MAX_PROMPT_HISTORY);
		setHistory(next);
		try {
			savePromptHistory(next);
		} catch {
			/* history is a convenience */
		}
	};

	const view = () => (pickerOpen() ? "picker" : "session");
	createEffect(() => {
		props.keymap.setData("orchestrator.view", view());
	});
	createEffect(() => {
		if (!props.active()) return;
		setActiveKeybindCatalog(orchestratorKeybindCatalog());
	});

	const disposeSession = props.keymap.registerLayer({
		shellFeature: "orchestrator",
		name: "orchestrator-session",
		priority: 1000,
		orchestratorView: "session",
		activeModal: "none",
		commands: [
			{
				name: "orchestrator-session.handle",
				run: ({ event }) => {
					const name = event.name.toLowerCase();
					if (name === "escape") {
						props.onBack();
						return true;
					}
					// Ctrl+O/Ctrl+T toggle tool output/thinking in the focused prompt;
					// consuming them here keeps the shell's Back from firing too.
					if (event.ctrl && (name === "o" || name === "t")) return true;
					if (!scrollBox) return false;
					const page = Math.max(1, Math.floor(dimensions().height / 3));
					if (name === "pageup") scrollBox.scrollBy(-page);
					else if (name === "pagedown") scrollBox.scrollBy(page);
					else if (name === "u" && event.ctrl) scrollBox.scrollBy(-page);
					else if (name === "d" && event.ctrl) scrollBox.scrollBy(page);
					return true;
				},
			},
		],
		bindings: [
			...["pageup", "pagedown", "ctrl+u", "ctrl+d", "escape"].map((key) => ({
				key,
				cmd: "orchestrator-session.handle",
			})),
			// The prompt input still receives these (it owns the toggles).
			...["ctrl+o", "ctrl+t"].map((key) => ({
				key,
				cmd: "orchestrator-session.handle",
				preventDefault: false,
			})),
		],
	});
	const disposePicker = props.keymap.registerLayer({
		shellFeature: "orchestrator",
		name: "orchestrator-picker",
		priority: 1100,
		orchestratorView: "picker",
		commands: [
			{
				name: "orchestrator-picker.handle",
				run: ({ event }) => (pickerHandler ? pickerHandler(event) : false),
			},
		],
		bindings: SESSION_PICKER_KEYS.map((key) => ({
			key,
			cmd: "orchestrator-picker.handle",
		})),
	});
	onCleanup(() => {
		stopProjection();
		disposed = true;
		stopWatch?.();
		disposeSession();
		disposePicker();
		props.keymap.setData("orchestrator.view", "none");
	});

	return (
		<AgentSessionView
			role="orchestrator"
			blocks={blocks()}
			{...metadata()}
			{...(metadata().model
				? { contextWindow: contextWindows()[metadata().model as string] }
				: {})}
			models={models()}
			thinkingLevels={thinkingLevels()}
			draft={draft()}
			history={history()}
			onDraftChange={setDraft}
			onHistoryAppend={rememberInput}
			onSubmit={submit}
			onAbort={abort}
			onBack={props.onBack}
			onConfigure={configure}
			onCompact={compact}
			onHelp={props.onHelp}
			inputActive={() => props.active() && !props.overlay() && sessionReady()}
			extraCommands={[
				...orchestratorSessionCommands(startNewSession),
				...orchestratorSubscriptionCommands({
					subscriptions: subscriptions(),
					onList: listSubscriptions,
					onRemove: unsubscribe,
				}),
			]}
			onScrollBoxReady={(box) => {
				scrollBox = box;
			}}
			onPickerKeyReady={(handler) => {
				pickerHandler = handler;
			}}
			onPickerActiveChange={setPickerOpen}
		/>
	);
}
