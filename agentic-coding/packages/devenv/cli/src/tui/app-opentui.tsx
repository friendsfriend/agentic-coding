import { createClient, getLogger, registerFatalCleanup } from "@devenv/core";
import type { App } from "@devenv/types";
import {
	getSelectableRows,
	Header,
	Layout,
	StatusBar,
	setGlobalSelectionMouseUpHandler,
} from "@devenv/ui";
import { createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useKeymap } from "@opentui/keymap/solid";
import {
	render,
	usePaste,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { APP_VERSION } from "../version";
import {
	createAgentActions,
	createAppActions,
	createCrActions,
	createDockerActions,
	createGitActions,
	createHelpActions,
	createIssueActions,
	createLogActions,
	createPipelineActions,
	createProviderActions,
	createUtilActions,
	initializeApp,
} from "./actions";
import { createColumns, createScriptColumns } from "./columns";
import {
	requestedCategory,
	viewModeForPath,
	viewPathForMode,
} from "./destination-sync";
import { setupLogEffects } from "./effects/log-effects";
import {
	abortExitSignal,
	confirmExitApp,
	destroyExitRenderer,
	exitApp,
	getExitSignal,
	registerExitGuard,
	registerGracefulShutdownHandler,
	setExitRenderer,
} from "./exit";
import {
	type EnvironmentLaunchTarget,
	handlePaste,
	type KeyboardActions,
	type KeyboardContext,
	type KeyboardStores,
	registerGlobalKeymapLayers,
	registerModalKeymapLayers,
	registerTableKeymapLayer,
	registerWorkflowKeymapLayers,
	setupDevenvKeymap,
	syncKeymapRuntimeState,
} from "./keyboard";
import {
	createActionRunStore,
	createAgentStore,
	createAppDetailStore,
	createAppStore,
	createChangeRequestStore,
	createIssueStore,
	createLogStore,
	createProviderStore,
	createUiStore,
} from "./stores";
import {
	applyTheme,
	loadCustomThemes,
	loadRendererThemeColors,
	loadSystemTheme,
	loadThemeName,
} from "./theme-settings";
import type { ViewActions, ViewStores } from "./views";
import {
	ContentRouter,
	getHeaderInfo,
	getTabBorderColor,
	getTabName,
	ModalOverlays,
} from "./views";

export interface TUIAppProps {
	serverUrl: string;
	managedServer?: { stop(timeoutMs?: number): Promise<void> };
	/** Render only the environment feature content (no devenv header/footer and
	 * no fixed terminal dimensions) so the unified shell owns the chrome and the
	 * single renderer. The shell is responsible for exit guards and shutdown. */
	embedded?: boolean;
	/** Chrome rows the host renders around this body. Embedded: the shell's logo
	 * bar + breadcrumb. Absent: this feature's own header/footer. */
	chromeLines?: number;
	/** Embedded mode only: publish the environment's live command registrations
	 * so the shell footer/help are projections of the real keymap metadata rather
	 * than a hand-written summary (compose-unified-feature-shell task 3.6). */
	onKeybindCatalog?: (sections: EnvironmentKeybindSections) => void;
	/** Shell-active predicate. Inactive embedded instances retain view state but
	 * must not overwrite shared keymap runtime data. */
	active?: () => boolean;
	/** Projects the local overlay state into the shell ModalHost. */
	onModalChange?: (open: boolean) => void;
	/**
	 * Shell route authority (replace-nested-tabs-with-page-navigation, task 2.2).
	 * When the page shell embeds this feature, the destination it is showing
	 * comes from the route instead of an inner navigation tab row: the shell
	 * requests a category/view and the feature reports its own changes back, so
	 * exactly one side is authoritative for each direction.
	 */
	destination?: EnvironmentDestination;
	/**
	 * Contextual workflow launch (launch-workflows-from-project-and-wiki-pages,
	 * task 1.3): the unified shell owns the creation form and the start
	 * boundary. The feature reports the selected project's canonical identity
	 * and nothing else, so it never duplicates start or Herdr handoff logic.
	 */
	onStartWorkflow?: (target: EnvironmentLaunchTarget) => void;
}

export interface EnvironmentDestination {
	/** Category page the shell route names (undefined: no request). */
	category?: string;
	/** View path inside the resource page ("changeRequestDetail.jobs", …). */
	view?: string;
	/** The feature reports a destination change back to the shell route. */
	onChange?: (destination: {
		category: string;
		view: string;
		/** Resource identity the view renders, when it has one. */
		resourceId?: string;
	}) => void;
}

type EnvironmentKeybindSections = Array<{
	title: string;
	keybinds: Array<{ key: string; action: string }>;
}>;

interface StartTUIOptions {
	managedServer?: { stop(timeoutMs?: number): Promise<void> };
}

export function TUIApp(props: TUIAppProps) {
	const dimensions = useTerminalDimensions();
	const renderer = useRenderer();

	// --- Stores ---
	const appStore = createAppStore();
	const issueStore = createIssueStore();
	const logStore = createLogStore();
	const changeRequestStore = createChangeRequestStore();
	const providerStore = createProviderStore();
	const uiStore = createUiStore();
	const agentStore = createAgentStore();
	const appDetailStore = createAppDetailStore();
	const actionRunStore = createActionRunStore();
	loadCustomThemes();
	const initialTheme = loadThemeName();
	applyTheme(initialTheme);
	uiStore.setActiveThemeName(initialTheme);

	const showError = uiStore.showError;
	const client = createClient(props.serverUrl, undefined, showError);

	// --- Actions ---
	const appActions = createAppActions(
		appStore,
		appDetailStore,
		uiStore,
		client,
		showError,
		actionRunStore,
	);
	const issueActions = createIssueActions(
		appStore,
		issueStore,
		client,
		showError,
	);
	const logActions = createLogActions(logStore, appStore, client, showError);
	const crActions = createCrActions(
		appStore,
		changeRequestStore,
		uiStore,
		client,
		showError,
	);
	const dockerActions = createDockerActions(
		appStore,
		uiStore,
		client,
		showError,
		async () => {
			appStore.pushModal("actions");
		},
	);
	const gitActions = createGitActions(appStore, uiStore, client, showError);
	const providerActions = createProviderActions(
		appStore,
		providerStore,
		client,
		showError,
		uiStore,
	);
	const agentActions = createAgentActions(appStore, agentStore, client);
	const utilActions = createUtilActions(
		appStore,
		agentStore,
		uiStore,
		renderer,
		client,
		actionRunStore,
	);
	const pipelineActions = createPipelineActions(
		appStore,
		changeRequestStore,
		client,
		showError,
	);
	const helpActions = createHelpActions(
		appStore,
		issueStore,
		logStore,
		changeRequestStore,
		uiStore,
	);

	const clearGlobalSelectionMouseUpHandler = setGlobalSelectionMouseUpHandler(
		utilActions.handleCopySelection,
	);
	onCleanup(clearGlobalSelectionMouseUpHandler);

	const launchPi = (sessionPath: string | null) =>
		agentActions.launchPi(sessionPath, renderer);

	const getSelectedApp = (): App | undefined => {
		const row = (
			appStore.viewMode() === "table"
				? appStore.tableFilteredApps()
				: appStore.filteredApps()
		)[appStore.selectedIndex()];
		return row?.rowKind === "app" ? row : undefined;
	};

	// --- Effects ---
	setupLogEffects(logStore, client, props.active);

	createEffect(() => {
		if (props.active && !props.active()) return;
		if (!uiStore.runningTextEnabled()) return;
		const runningTextInterval = setInterval(() => {
			uiStore.setRunningTextOffset((prev) => prev + 1);
		}, 160);
		onCleanup(() => clearInterval(runningTextInterval));
	});

	/* selectedLine removed — no cursor line / visual mode */

	// --- Initialization ---
	let initialized = false;
	let initializationInFlight = false;
	let initController: AbortController | undefined;
	let removeInitExitListener: (() => void) | undefined;
	// Owner cleanup runs only when TUIApp is destroyed, not when active flips.
	// A completed bootstrap/SSE controller therefore survives hide/show.
	onCleanup(() => {
		removeInitExitListener?.();
		initController?.abort();
	});
	createEffect(() => {
		// Keep the mounted feature cheap until the user first visits it. Abort an
		// in-flight first visit if the shell hides it before bootstrap completes;
		// once bootstrap succeeds, retain its controller/SSE subscription across
		// later hide/show transitions.
		if (props.active && !props.active()) return;
		if (initialized || initializationInFlight) return;
		initializationInFlight = true;
		const controller = new AbortController();
		initController = controller;
		const exitSignal = getExitSignal();
		const abortFromExit = () => controller.abort();
		exitSignal.addEventListener("abort", abortFromExit, { once: true });
		removeInitExitListener = () =>
			exitSignal.removeEventListener("abort", abortFromExit);
		void initializeApp({
			client,
			appStore,
			appActions,
			showError,
			serverUrl: props.serverUrl,
			refreshProviders: providerActions.refreshProviders,
			abortSignal: controller.signal,
		})
			.then(
				() => {
					if (initController === controller && !controller.signal.aborted)
						initialized = true;
				},
				() => {
					if (initController === controller) initialized = false;
				},
			)
			.finally(() => {
				if (initController === controller) initializationInFlight = false;
			});
	});

	const shutdownDelay = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));
	const runWithTimeout = async (
		label: string,
		fn: () => void | Promise<void>,
		timeoutMs = 2000,
	) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(fn),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`${label} timed out`)),
						timeoutMs,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};
	const runShutdownStep = async (
		phase:
			| "preparing"
			| "canceling-background-work"
			| "stopping-input"
			| "stopping-server"
			| "destroying-renderer"
			| "complete",
		message: string,
		fn: () => void | Promise<void>,
		timeoutMs?: number,
	) => {
		appStore.setShutdownState({ phase, message, error: null });
		await shutdownDelay(50);
		await runWithTimeout(message, fn, timeoutMs);
	};
	onMount(() => {
		// Embedded in the unified shell: the shell owns exit guards and process
		// shutdown, so the imported environment app must not register competing
		// handlers or stop a server it does not own.
		if (props.embedded) return;
		const unregisterExitGuard = registerExitGuard(() => {
			const activeRuns = actionRunStore
				.runs()
				.filter((run) => run.status === "active" || run.status === "pending");
			if (activeRuns.length === 0) return true;
			if (uiStore.showConfirmDialog()) return false;

			const targets = [
				...new Set(
					activeRuns
						.map((run) => run.appIdent)
						.filter((ident): ident is string => Boolean(ident)),
				),
			];
			const details = activeRuns
				.slice(0, 5)
				.map(
					(run) => `• ${run.title}${run.appIdent ? ` (${run.appIdent})` : ""}`,
				)
				.join("\n");
			const more =
				activeRuns.length > 5 ? `\n• and ${activeRuns.length - 5} more` : "";
			uiStore.setConfirmDialogTitle("Running actions");
			uiStore.setConfirmDialogMessage(
				`These actions are still running:\n\n${details}${more}\n\nTerminate them and quit?`,
			);
			uiStore.setConfirmDialogAction(() => () => {
				void (async () => {
					await Promise.all(
						targets.map(async (ident) => {
							try {
								await client.cancelAction(ident);
							} catch (error) {
								getLogger().write(
									"WARN",
									`Failed to cancel action for ${ident}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}),
					);
					await confirmExitApp();
				})();
			});
			uiStore.setShowConfirmDialog(true);
			return false;
		});
		const unregister = registerGracefulShutdownHandler(async () => {
			appStore.setIsShuttingDown(true);
			try {
				await runShutdownStep("preparing", "Preparing DevEnv shutdown...", () =>
					shutdownDelay(50),
				);
				await runShutdownStep(
					"canceling-background-work",
					"Canceling background work...",
					() => abortExitSignal(),
				);
				await runShutdownStep(
					"stopping-input",
					"Stopping input handlers...",
					() => shutdownDelay(50),
				);
				if (props.managedServer) {
					appStore.setShutdownState({
						phase: "stopping-server",
						message: "Stopping DevEnv server...",
						error: null,
					});
					await shutdownDelay(50);
					await props.managedServer.stop(2000);
				}
				appStore.setShutdownState({
					phase: "destroying-renderer",
					message: "Destroying terminal renderer...",
					error: null,
				});
				await shutdownDelay(50);
				appStore.setShutdownState({
					phase: "complete",
					message: "Shutdown complete.",
					error: null,
				});
				await shutdownDelay(120);
				renderer.destroy();
			} catch (error) {
				const currentShutdownPhase = appStore.shutdownState().phase;
				const failedPhase =
					currentShutdownPhase === "failed" || currentShutdownPhase === "idle"
						? "preparing"
						: currentShutdownPhase;
				appStore.setShutdownState({
					phase: "failed",
					message: "Shutdown failed.",
					error: error instanceof Error ? error.message : String(error),
					failedPhase,
				});
				abortExitSignal();
				await shutdownDelay(600);
				renderer.destroy();
			}
		});
		onCleanup(unregister);
		onCleanup(unregisterExitGuard);
	});

	// --- Shell route ↔ destination sync (embedded page shell) ---
	// The route names a category and a view path; the store owns the data and the
	// per-tab state. Only a *changed* request is applied: the feature reports its
	// own moves back to the route, so re-applying the request the route still
	// names would reopen the view Escape just closed (the route has not caught up
	// with the report yet). A shell Back to a different view therefore still
	// restores it, while a feature-side step is left standing.
	//
	// ponytail: the request is compared as category+view, so a route that changes
	// only the resource identity at the same view applies nothing. The route
	// carries the identity of the *view* here, not of the resource it renders
	// (`openAppDetail` names the selection), so this is the whole of what the
	// route can ask for today.
	let appliedRequest: string | undefined;
	createEffect(() => {
		const destination = props.destination;
		if (!destination) return;
		const request = `${destination.category ?? ""}|${destination.view ?? ""}`;
		if (request === appliedRequest) return;
		appliedRequest = request;
		const category = requestedCategory(
			destination.category,
			appStore.tableTabs().map((tab) => tab.id),
		);
		if (category && category !== appStore.activeTab()) {
			appStore.setActiveTab(category);
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			if (category === "scripts") void appActions.loadScripts();
		}
		const requestedView = destination.view;
		if (requestedView === undefined) return;
		const wanted = viewModeForPath(requestedView);
		if (wanted !== appStore.viewMode()) appStore.resetViewStack(wanted);
	});
	// The feature reports where it went (a table selection opening the detail
	// view, a CR detail opening its jobs, …) so the route follows the same
	// operations the mouse and keys perform.
	createEffect(() => {
		const destination = props.destination;
		if (!destination?.onChange) return;
		const category = appStore.activeTab();
		const mode = appStore.viewMode();
		const view = viewPathForMode(mode);
		const resourceId =
			mode === "appDetail" ? appDetailStore.appDetailApp()?.ident : undefined;
		destination.onChange({
			category,
			view,
			...(resourceId !== undefined ? { resourceId } : {}),
		});
	});

	// --- Columns ---
	const columns = createColumns();
	const scriptColumns = createScriptColumns();

	// --- Keyboard dispatcher ---
	const kbStores: KeyboardStores = {
		appStore,
		issueStore,
		logStore,
		changeRequestStore,
		providerStore,
		uiStore,
		agentStore,
		appDetailStore,
		actionRunStore,
	};
	const kbActions: KeyboardActions = {
		appActions,
		issueActions,
		logActions,
		crActions,
		dockerActions,
		gitActions,
		providerActions,
		agentActions,
		utilActions,
		pipelineActions,
		helpActions,
	};
	const kbCtx: KeyboardContext = {
		renderer,
		client,
		getSelectedApp,
		launchPi,
		getSelectableRows,
		showError,
		embedded: props.embedded,
		active: props.active,
		...(props.onStartWorkflow ? { startWorkflow: props.onStartWorkflow } : {}),
	};

	const keymap = useKeymap();
	helpActions.setKeymap(keymap);
	onCleanup(() => helpActions.setKeymap(undefined));
	const [keymapVersion, setKeymapVersion] = createSignal(0);
	syncKeymapRuntimeState(
		keymap,
		kbStores,
		() => setKeymapVersion((version) => version + 1),
		props.embedded ? props.active : undefined,
	);
	createEffect(() => {
		if (!props.embedded || !props.onModalChange) return;
		keymapVersion();
		const active = props.active?.() ?? true;
		const modal = String(keymap.getData?.("modal.active") ?? "none");
		props.onModalChange(active && modal !== "none");
	});
	const footerKeybinds = createMemo(() => {
		keymapVersion();
		// Keymap state is external to Solid. Read panel signals here so StatusBar
		// rerenders when panel-specific keymap layers become active.
		appStore.viewMode();
		appStore.activeTab();
		appStore.activeModal();
		actionRunStore.focusedPanel();
		appStore.kubernetesPanelIndex();
		appDetailStore.appDetailPanelIndex();
		issueStore.issueDetailPanelIndex();
		changeRequestStore.crDetailPanelIndex();
		return helpActions.getKeybinds();
	});
	if (props.embedded && props.onKeybindCatalog) {
		// Project the environment's live command registrations into the shell
		// catalog so the shell footer and `?` help advertise real environment
		// commands (task 3.6).
		createEffect(() => {
			const binds = footerKeybinds();
			props.onKeybindCatalog?.([
				{
					title: "Environment",
					keybinds: binds.map((bind) => ({
						key: bind.key,
						action: bind.action,
					})),
				},
			]);
		});
	}
	onMount(() => {
		const disposeGlobalLayers = registerGlobalKeymapLayers(keymap, {
			stores: kbStores,
			actions: kbActions,
			ctx: kbCtx,
		});
		const disposeModalLayers = registerModalKeymapLayers(keymap, {
			stores: kbStores,
			actions: kbActions,
			ctx: kbCtx,
		});
		const disposeTableLayer = registerTableKeymapLayer(keymap, {
			stores: kbStores,
			actions: kbActions,
			ctx: kbCtx,
		});
		const disposeWorkflowLayers = registerWorkflowKeymapLayers(keymap, {
			stores: kbStores,
			actions: kbActions,
			ctx: kbCtx,
		});
		setKeymapVersion((version) => version + 1);
		onCleanup(() => {
			disposeWorkflowLayers();
			disposeTableLayer();
			disposeModalLayers();
			disposeGlobalLayers();
		});
	});

	usePaste((event) => {
		if (appStore.isShuttingDown()) return;
		handlePaste(event, providerStore);
	});

	// --- View props ---
	const viewStores: ViewStores = {
		appStore,
		issueStore,
		logStore,
		changeRequestStore,
		providerStore,
		uiStore,
		agentStore,
		appDetailStore,
		actionRunStore,
	};
	const viewActions: ViewActions = {
		appActions,
		issueActions,
		logActions,
		crActions,
		dockerActions,
		gitActions,
		providerActions,
		agentActions,
		utilActions,
		pipelineActions,
		helpActions,
	};

	const headerDeps = {
		appStore,
		issueStore,
		changeRequestStore,
		appDetailStore,
		helpActions,
		getSelectedApp,
	};

	if (props.embedded) {
		return (
			<box
				width="100%"
				height="100%"
				flexDirection="column"
				onMouseUp={utilActions.handleCopySelection}
			>
				<ContentRouter
					stores={viewStores}
					actions={viewActions}
					columns={columns}
					scriptColumns={scriptColumns}
					dimensions={dimensions()}
					{...(props.chromeLines !== undefined
						? { chromeLines: props.chromeLines }
						: {})}
					runningTextEnabled={uiStore.runningTextEnabled()}
					runningTextOffset={uiStore.runningTextOffset()}
					getTabBorderColor={(tab) => getTabBorderColor(tab, appStore)}
					active={props.active}
				/>
				<ModalOverlays
					stores={viewStores}
					actions={viewActions}
					dimensions={dimensions()}
				/>
			</box>
		);
	}

	return (
		<box
			width={dimensions().width}
			height={dimensions().height}
			onMouseUp={utilActions.handleCopySelection}
		>
			<Layout
				header={
					<Header
						{...getHeaderInfo(headerDeps)}
						version={APP_VERSION}
						runningTextEnabled={uiStore.runningTextEnabled()}
						runningTextOffset={uiStore.runningTextOffset()}
					/>
				}
				content={
					<ContentRouter
						stores={viewStores}
						actions={viewActions}
						columns={columns}
						scriptColumns={scriptColumns}
						dimensions={dimensions()}
						runningTextEnabled={uiStore.runningTextEnabled()}
						runningTextOffset={uiStore.runningTextOffset()}
						getTabBorderColor={(tab) => getTabBorderColor(tab, appStore)}
					/>
				}
				footer={
					<StatusBar
						left={
							appStore.activeTab() === "ui-test"
								? "UI Test"
								: `${getTabName(appStore.activeTab())}: ${appStore.filteredApps().length}`
						}
						center={
							appStore.viewMode() === "providers"
								? "Providers"
								: appStore.viewMode() === "jobs"
									? `Pipeline #${changeRequestStore.currentPipelineId() || "N/A"} \u2022 ${changeRequestStore.jobs().length} jobs`
									: appStore.viewMode() === "changeRequestDetail"
										? `Branch: ${appStore.filteredApps()[appStore.selectedIndex()]?.branch || "unknown"}`
										: appStore.viewMode() === "changeRequests"
											? `Branch: ${appStore.filteredApps()[appStore.selectedIndex()]?.branch || "unknown"}`
											: appStore.viewMode() !== "table"
												? "Viewing Logs"
												: appStore.liveUpdatesActive()
													? `Last update: ${appStore.lastUpdateTime() ? `${appStore.lastUpdateTime()?.toLocaleTimeString()}` : ""}`
													: ""
						}
						right={
							appStore.viewMode() === "table"
								? `Selected: ${appStore.selectedIndex() + 1}/${appStore.filteredApps().length}`
								: ""
						}
						keybinds={footerKeybinds()}
						runningTextEnabled={uiStore.runningTextEnabled()}
						runningTextOffset={uiStore.runningTextOffset()}
					/>
				}
			/>

			<ModalOverlays
				stores={viewStores}
				actions={viewActions}
				dimensions={dimensions()}
			/>
		</box>
	);
}

export async function startTUI(
	serverUrl: string,
	options: StartTUIOptions = {},
) {
	try {
		// Force enable color support for terminal
		process.env.FORCE_COLOR = "3"; // Force truecolor

		const useConsole = process.env.DEVENV_TUI_CONSOLE === "1";
		const renderer = await createCliRenderer({
			targetFps: 60,
			gatherStats: true,
			exitOnCtrlC: false,
			consoleMode: useConsole ? "console-overlay" : "disabled",
			useKittyKeyboard: {},
			exitSignals: [],
			...(useConsole
				? {
						consoleOptions: {
							onCopySelection: (text: string) => {
								import("@devenv/core")
									.then(({ copyToClipboard }) => copyToClipboard(text))
									.catch(() => {});
							},
						},
					}
				: {}),
		});

		loadSystemTheme(await loadRendererThemeColors(renderer));
		setExitRenderer(renderer);

		let destroyed = false;
		const cleanup = () => {
			if (destroyed) return;
			destroyed = true;
			process.off("SIGINT", gracefulSignalCleanup);
			process.off("SIGTERM", gracefulSignalCleanup);
			process.off("SIGHUP", cleanup);
			abortExitSignal();
			destroyExitRenderer();
		};
		const gracefulSignalCleanup = () => {
			void exitApp();
		};
		process.on("SIGINT", gracefulSignalCleanup);
		process.on("SIGTERM", gracefulSignalCleanup);
		process.on("SIGHUP", cleanup);
		const unregisterFatalCleanup = registerFatalCleanup(cleanup);

		const rendererDestroyed = new Promise<void>((resolve) => {
			renderer.once("destroy", () => {
				destroyed = true;
				resolve();
			});
		});

		const keymap = createDefaultOpenTuiKeymap(renderer);
		const disposeDevenvKeymap = setupDevenvKeymap(keymap);

		try {
			await render(
				() => (
					<KeymapProvider keymap={keymap}>
						<TUIApp
							serverUrl={serverUrl}
							managedServer={options.managedServer}
						/>
					</KeymapProvider>
				),
				renderer,
			);
			await rendererDestroyed;
			await new Promise<void>((resolve) => queueMicrotask(resolve));
		} finally {
			disposeDevenvKeymap();
			unregisterFatalCleanup();
			process.off("SIGINT", gracefulSignalCleanup);
			process.off("SIGTERM", gracefulSignalCleanup);
			process.off("SIGHUP", cleanup);
			cleanup();
		}
	} catch (error) {
		console.error("Fatal error in TUI:", error);
		throw error;
	}
}
