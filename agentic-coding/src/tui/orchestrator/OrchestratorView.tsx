// Home → Orchestrator: the chat page of the one persistent orchestrator
// session. It renders the shared durable-session transcript
// (`AgentSessionView`) over the dedicated orchestrator host (`session.ts`) and
// owns its keys through the `orchestrator.view` keymap field: the transcript
// layer while the prompt is up, the model/thinking picker layer while a picker
// is open. The prompt input itself owns text keys.
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
import { loadAgentConfig } from "../data/agents.ts";
import {
	loadPromptHistory,
	MAX_PROMPT_HISTORY,
	savePromptHistory,
} from "../shared/preferences.ts";
import type { OrchestratorModel, OrchestratorSession } from "./session.ts";

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
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{
			id: "route:connecting",
			kind: "notice",
			tone: "muted",
			text: "Starting the orchestrator…",
		},
	]);
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
	let scrollBox: ScrollBoxRenderable | undefined;
	let pickerHandler: ((event: KeyEvent) => boolean) | undefined;
	let disposed = false;

	const client = async () => {
		const current = session();
		if (!current) throw new Error("the orchestrator session is not ready");
		const { HostClient } = await import("../../agent-host/client.ts");
		return { client: new HostClient(current.hostSocket), current };
	};

	/** (Re)connect: ensure the host and session, then stream its transcript. */
	const connect = async (fresh = false) => {
		stopWatch?.();
		stopWatch = undefined;
		try {
			const [{ openOrchestratorSession }, view, model] = await Promise.all([
				import("./session.ts"),
				import("../dash/agent-session.ts"),
				configuredModel(),
			]);
			const opened = await openOrchestratorSession({ fresh, model });
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
			const stop = watchStream(host, opened.runId, {
				onFrame: (value) => {
					if (session()?.runId !== opened.runId) return;
					receivedFrame = true;
					setBlocks(view.buildAgentSessionView(value));
					setMetadata(view.readAgentSessionMetadata(value));
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
				await host.abort(current.runId);
				notify("Abort requested", "info");
			} catch (error) {
				notify(
					`Could not abort: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		})();
	};
	const startNewSession = () => {
		setSession(undefined);
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
			onHelp={props.onHelp}
			inputActive={() => props.active() && !props.overlay()}
			extraCommands={[
				{
					name: "/new",
					description: "Start a new orchestrator session",
					run: startNewSession,
				},
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
