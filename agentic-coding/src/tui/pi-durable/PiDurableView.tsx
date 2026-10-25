// Sidebar → Pi Durable: one persistent pi-durable coding session rendered with
// the shared durable transcript (`AgentSessionView`), the same view the Home
// Orchestrator uses. It talks to a dedicated coding-session host
// (`agent host --session`, see `./session.ts`): a plain coding agent with no
// workflow tools and no orchestrator capability. The page owns its keys through
// the `durable.view` keymap field: the transcript layer while the prompt is up,
// the model/thinking picker layer while a picker is open.
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { setActiveKeybindCatalog, useTerminalDimensions } from "@ui";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type {
	AgentSessionBlock,
	AgentSessionMetadata,
} from "../dash/agent-session.ts";
import { agentSessionKeybindCatalog } from "../dash/keybinds.ts";
import { notify } from "../dash/notifications.ts";
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "../dash/ui/AgentSessionView.tsx";
import {
	loadPromptHistory,
	MAX_PROMPT_HISTORY,
	savePromptHistory,
} from "../shared/preferences.ts";
import type { PiDurableSession } from "./session.ts";

export interface PiDurableViewProps {
	readonly keymap: Keymap<Renderable, KeyEvent>;
	/** The page body holds focus (not the workspace sidebar). */
	readonly active: () => boolean;
	/** A shell overlay is on top: the prompt must blur. */
	readonly overlay: () => boolean;
	/** Leave the page (Escape, `/hide`). */
	readonly onBack: () => void;
	/** Open the shell's `?` keybind help. */
	readonly onHelp: () => void;
	/** The repository the session works in (the shell's primary project). */
	readonly cwd: string;
}

/** Footer and `?` catalog of the Pi Durable page: the session view's keys, with
 * Escape leaving for Home. */
export function piDurableKeybindCatalog() {
	return agentSessionKeybindCatalog().map((section) => ({
		...section,
		title: "Pi durable",
		keybinds: section.keybinds.map((keybind) =>
			keybind.key === "Esc" ? { ...keybind, action: "Back to Home" } : keybind,
		),
	}));
}

/** Start a new conversation rather than only clearing the rendered transcript:
 * the host creates it and the view reconnects to it. */
function piDurableSessionCommands(startNewSession: () => void) {
	return [
		{
			name: "/clear-session",
			description: "Start a fresh coding session",
			run: startNewSession,
		},
		{
			name: "/new",
			description: "Start a new coding session (alias of /clear-session)",
			run: startNewSession,
		},
	];
}

export function PiDurableView(props: PiDurableViewProps) {
	const dimensions = useTerminalDimensions();
	const [session, setSession] = createSignal<PiDurableSession>();
	/** Wait for the host snapshot before accepting input, so the prompt never
	 * sends into a conversation the view has not rendered yet. */
	const [sessionReady, setSessionReady] = createSignal(false);
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{
			id: "route:connecting",
			kind: "notice",
			tone: "muted",
			text: "Starting the coding session…",
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
	let stopWatch: (() => void) | undefined;
	let stopProjection = () => {};
	let scrollBox: ScrollBoxRenderable | undefined;
	let pickerHandler: ((event: KeyEvent) => boolean) | undefined;
	let disposed = false;

	const client = async () => {
		const current = session();
		if (!current) throw new Error("the coding session is not ready");
		const { HostClient } = await import("../../agent-host/client.ts");
		return { client: new HostClient(current.hostSocket), current };
	};

	/** (Re)connect: ensure the host and conversation, then stream its
	 * transcript. */
	const connect = async (fresh = false) => {
		setSessionReady(false);
		stopWatch?.();
		stopProjection();
		stopWatch = undefined;
		try {
			const [{ openPiDurableSession }, view] = await Promise.all([
				import("./session.ts"),
				import("../dash/agent-session.ts"),
			]);
			const opened = await openPiDurableSession({
				fresh,
				cwd: props.cwd,
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
			// `watchStream` reconnects instead of freezing the transcript on the
			// last frame. The transcript stays once a frame has arrived and
			// refreshes silently on reconnect; before the first frame a drop keeps
			// the "Connecting…" placeholder rather than going blank.
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
						"Could not start the coding session: " +
						(error instanceof Error ? error.message : String(error)),
				},
			]);
		}
	};

	onMount(() => {
		void connect();
	});

	const submit = (text: string) => {
		void (async () => {
			try {
				const { client: host, current } = await client();
				await host.submit(current.runId, text, crypto.randomUUID(), "steer");
			} catch (error) {
				notify(
					`Could not send message: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		})();
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
	/** `/compact [instructions]`: the coding-session host serves it through the
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
				text: "Starting a new coding session…",
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
		props.keymap.setData("durable.view", view());
	});
	createEffect(() => {
		if (!props.active()) return;
		setActiveKeybindCatalog(piDurableKeybindCatalog());
	});

	const disposeSession = props.keymap.registerLayer({
		name: "pi-durable-session",
		priority: 1000,
		durableView: "session",
		activeModal: "none",
		commands: [
			{
				name: "pi-durable-session.handle",
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
				cmd: "pi-durable-session.handle",
			})),
			// The prompt input still receives these (it owns the toggles).
			...["ctrl+o", "ctrl+t"].map((key) => ({
				key,
				cmd: "pi-durable-session.handle",
				preventDefault: false,
			})),
		],
	});
	const disposePicker = props.keymap.registerLayer({
		name: "pi-durable-picker",
		priority: 1100,
		durableView: "picker",
		commands: [
			{
				name: "pi-durable-picker.handle",
				run: ({ event }) => (pickerHandler ? pickerHandler(event) : false),
			},
		],
		bindings: SESSION_PICKER_KEYS.map((key) => ({
			key,
			cmd: "pi-durable-picker.handle",
		})),
	});
	onCleanup(() => {
		stopProjection();
		disposed = true;
		stopWatch?.();
		disposeSession();
		disposePicker();
		props.keymap.setData("durable.view", "none");
	});

	return (
		<AgentSessionView
			role="pi durable"
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
			extraCommands={piDurableSessionCommands(startNewSession)}
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
