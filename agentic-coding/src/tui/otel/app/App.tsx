/** @jsxImportSource @opentui/solid */

import { join } from "node:path";
import type { Renderable } from "@opentui/core";
import { type KeyEvent, TextAttributes } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	type AgentsConfig,
	BUILTIN_PRESET_NAME,
} from "../../../workflow/profiles";
import {
	fetchProjectCatalog,
	projectCanonicalRoots,
	syncCatalogWatchers,
} from "../../../workflow/project-catalog";
import {
	researchWorkflowTarget,
	wikiWorkflowDataRoot,
} from "../../../workflow/runtime";
import type { WikiReviewComment } from "../../../workflow/wiki";
import { copyToClipboard } from "../../clipboard";
import {
	agentConfigEntry,
	refreshAgentConfig,
} from "../../dash/agent-config-cache";
import {
	listPresetNames,
	startSidebarPresentation,
	startWikiCommentWorkflowInProcess,
} from "../../dash/engine";
import { workflowLaunchKeybindCatalog } from "../../dash/keybinds";
import {
	registerShellFeatureField,
	registerShellKeyLayer,
	registerShellOverlayLayer,
} from "../../dash/keymap-setup";
import {
	launchContextError,
	launchRepositoryAvailable,
	launchWorkflow,
	type WorkflowLaunchContext,
	type WorkflowLaunchInput,
	watchAcceptedHandoff,
} from "../../dash/launch";
import { isKeyTraceSuppressed, traceTui } from "../../dash/tracing";
import { NewWorkflowModal } from "../../dash/ui/NewWorkflowModal";
import {
	phase,
	quitConfirmation,
	resolveQuitConfirmation,
} from "../../lifecycle";
import { resolveBackendSettings } from "../../settings/backend-info";
import {
	type SettingsContext,
	type SettingsItem,
	settingsItems,
} from "../../settings/items";
import { SettingsAgentEditor } from "../../settings/SettingsAgentEditor";
import { SettingsSectionView } from "../../settings/SettingsSectionView";
import {
	refreshSettingsProjects,
	refreshSettingsProviders,
	settingsKeybindCatalog,
	settingsProjects,
	settingsProviders,
} from "../../settings/state";
import { ErrorModalOverlay } from "../../shared/ErrorModalOverlay";
import {
	activeErrorModal,
	dismissErrorModal,
	showErrorModal,
} from "../../shared/errorModal";
import { HelpModal } from "../../shared/HelpModal";
import {
	activeKeybindCatalog,
	type KeybindSection,
	setActiveKeybindCatalog,
} from "../../shared/keybinds";
import { ModalHelpOverlay } from "../../shared/ModalHelpOverlay";
import {
	closeModalHelp,
	handleModalHelpKey,
	modalHelpOpen,
} from "../../shared/modalHelp";
import {
	createModalStackState,
	registerFocusRestorer,
} from "../../shared/modalStack";
import { BreadcrumbRow } from "../../shared/navigation/BreadcrumbRow";
import { CategoryPage } from "../../shared/navigation/DestinationPage";
import {
	type DestinationEntry,
	type DestinationSurface,
	environmentDestinations,
	filterPickerEntries,
	homeDestinations,
	observabilityDestinations,
	pickerEntries,
	settingsDestinations,
} from "../../shared/navigation/destinations";
import { destinationPageKeybindCatalog } from "../../shared/navigation/keybinds";
import { LocationPicker } from "../../shared/navigation/LocationPicker";
import { configDir, themeSettingsPath } from "../../shared/preferences";
import {
	breadcrumb,
	createPageNavigation,
	createRouterState,
	type FeatureId,
	type PageId,
	pageLabel,
	RESOURCE_BASE_VIEW,
	type Route,
	resolveAvailable,
	routeKey,
	SETTINGS_SECTION_DESCRIPTIONS,
	SETTINGS_SECTION_LABELS,
	type SettingsSection,
	settingsSectionOfPage,
} from "../../shared/routes";
import { Badge } from "../components/Badge";
import { HighlightedText } from "../components/Highlight";
import { NotificationOverlay } from "../components/Notification";
import { StatusBar } from "../components/StatusBar";
import { ThemePickerModal } from "../components/ThemePickerModal";
import {
	FilterModal,
	SortModal,
	statusOptions,
} from "../components/TraceModals";
import type { LogStore } from "../model/logStore";
import type { MetricStore } from "../model/metricStore";
import type { TelemetryDb } from "../model/telemetry-db";
import type { TopologyStore } from "../model/topologyStore";
import type { SortCriterion, TraceStore } from "../model/traceStore";
import type { LogData as OTelLogData, TreeNode } from "../model/types";
import { uiColors } from "../ui/colors";
import { LogDetailView } from "../views/LogDetailView";
import { LogsView } from "../views/LogsView";
import { MetricDetailView } from "../views/MetricDetailView";
import { MetricsView } from "../views/MetricsView";
import { ServiceDetailView } from "../views/ServiceDetailView";
import { SpanDetailView } from "../views/SpanDetailView";
import { TopologyView } from "../views/TopologyView";
import { TraceListView } from "../views/TraceListView";
import { TraceTreeView } from "../views/TraceTreeView";
import { WikiView, wikiCommentEntryActive } from "../views/WikiView";
import {
	environmentsKeybindCatalog,
	observabilityKeybindCatalog,
} from "./keybinds";
import { createNavigation } from "./navigation";
import { notify } from "./notifications";
import {
	applyTheme,
	getActiveThemeName,
	loadThemeName,
	saveThemeName,
	themeNames,
} from "./theme";

/** Shell overlay kinds whose keys the shell handler itself owns. */
const SHELL_OWNED_OVERLAYS = new Set([
	"locations",
	"help",
	"theme",
	"filter",
	"sort",
	// Contextual workflow creation: the shell owns the form and its start
	// boundary, so its keys are routed through the one shell dispatcher.
	"new-workflow",
]);

type Tab =
	| "home"
	| "environments"
	| "workflow"
	| "wiki"
	| "traces"
	| "metrics"
	| "logs"
	| "topology";
type Workspace = { changeId: string; path: string; spanCount: number };

/**
 * Read-only routing view for the Settings agent section: the agent settings a
 * preset editor does not own (default profile, per-step routes, role routes and
 * definition defaults) are shown with their effective value instead of being
 * silently unreachable (centralize-application-settings, task 2.2).
 */
function agentRoutingEntries(
	agents: AgentsConfig,
): Array<{ label: string; value: string }> {
	const entries: Array<{ label: string; value: string }> = [
		{
			label: "Default profile",
			value: agents.default_profile ?? "(unset)",
		},
	];
	for (const [step, profile] of Object.entries(agents.routes ?? {}))
		entries.push({ label: `Route ${step}`, value: profile });
	for (const [step, roles] of Object.entries(agents.role_routes ?? {}))
		for (const [role, profile] of Object.entries(roles))
			entries.push({ label: `Role route ${step}.${role}`, value: profile });
	for (const [definition, profile] of Object.entries(
		agents.definition_defaults ?? {},
	))
		entries.push({ label: `Definition default ${definition}`, value: profile });
	return entries;
}

/**
 * Shell route authority handed to the embedded environment feature (task 2.2):
 * structurally typed so this layer never imports the environment package.
 */
export interface EnvironmentDestination {
	category?: string;
	view?: string;
	onChange?: (destination: {
		category: string;
		view: string;
		resourceId?: string;
	}) => void;
}

/**
 * Contextual launch request reported by the environment resource page
 * (launch-workflows-from-project-and-wiki-pages, task 1.3). The page names the
 * canonical configured identity; the shell owns the creation form and the
 * start boundary, so the environment feature never starts a workflow itself.
 */
export interface EnvironmentLaunchRequest {
	/** Stable configured project identity (environment `app.ident`). */
	ident: string;
	name: string;
	repository: string;
}

/**
 * Shell keymap/host context. `mode` distinguishes the full application (Home,
 * Wiki, Settings) from a shell that only hosts the dashboard keymap and the
 * Settings surface while attaching. The per-workflow dashboard pane is no
 * longer mounted here: `agentic-coding dash` renders its own root
 * (isolate-workflow-dashboard-mode, task 2.4).
 */
export interface DashboardTab {
	mode: "home" | "dash";
	keymap: Keymap<Renderable, KeyEvent>;
}

export function App(props: {
	repos: string[];
	db: TelemetryDb;
	traceStore: TraceStore;
	metricStore: MetricStore;
	logStore: LogStore;
	topologyStore: TopologyStore;
	tracesOnly?: boolean;
	/** When set, the unified shell exposes the Environments feature. */
	environments?: { serverUrl: string };
	/** True when the shell is attached to a server this process does not own:
	 * the shell states the attached surface/capabilities explicitly. */
	attached?: boolean;
	/** Explicit attached-surface label (e.g. workflow + observability). */
	attachLabel?: string;
	/** Composition hook supplied by the shell root (src/tui/app) so this feature
	 * layer never imports the tui-app shell (source-layer boundary). The shell
	 * root passes a callback the embedded environment uses to publish its live
	 * command registrations (task 3.6). */
	renderEnvironments?: (
		onCatalog: (catalog: KeybindSection[]) => void,
		active: () => boolean,
		onModalChange: (open: boolean) => void,
		destination: () => EnvironmentDestination | undefined,
		onStartWorkflow: (project: EnvironmentLaunchRequest) => void,
	) => JSX.Element;
	/** Keymap/host context; see `DashboardTab`. */
	dashboard?: DashboardTab;
}) {
	const renderer = useRenderer();
	const dimensions = useTerminalDimensions();
	const nav = createNavigation();
	const [helpOffset, setHelpOffset] = createSignal(0);
	const helpLines = () =>
		Math.max(5, Math.floor(dimensions().height * 0.78) - 5);
	const helpMaxOffset = () =>
		Math.max(
			0,
			activeKeybindCatalog().reduce(
				(count, section) => count + section.keybinds.length + 1,
				0,
			) - helpLines(),
		);
	// Page route authority (replace-nested-tabs-with-page-navigation, task 2.3):
	// one typed location, structural parents and chronological Back replace the
	// per-feature stacks and single cross-feature origin.
	const initialRoute: Route =
		props.dashboard?.mode === "home"
			? // The full application enters Home (task 2.4); the per-workflow
				// dashboard is reached by `dash`, not by a shell route.
				{ page: "home" }
			: props.environments
				? { page: "environments" }
				: { page: "observability.traces" };
	const pages = createPageNavigation(createRouterState(initialRoute));
	const currentPage = () => pages.current().page;
	const activeFeature = (): FeatureId | undefined => pages.feature();
	/** Which body owns the terminal for a page: overlays belong to one body. */
	const bodyOwner = (page: string): string => {
		if (page.startsWith("environments")) return "environments";
		if (page.startsWith("workflows")) return "workflows";
		if (page.startsWith("wiki")) return "wiki";
		if (page.startsWith("observability")) return "observability";
		return "home";
	};
	// A shell overlay owns input: while one is on top the feature keymap layers
	// are parked through the shared `modal.active` field, so typing in the
	// location picker cannot reach a dashboard or environment binding. On close
	// the field returns to "none" only if this shell wrote it, so a feature's own
	// modal state is never clobbered.
	let shellModalField: string | undefined;
	createEffect(() => {
		const keymap = props.dashboard?.keymap;
		const modal = nav.modal();
		if (!keymap) return;
		if (modal === "none") {
			if (
				shellModalField &&
				keymap.getData?.("modal.active") === shellModalField
			)
				keymap.setData("modal.active", "none");
			shellModalField = undefined;
			return;
		}
		shellModalField = modal;
		keymap.setData("modal.active", modal);
	});

	// A feature-local overlay cannot remain the input owner after its body is
	// hidden, so moving to a page owned by another body clears the shell overlay
	// host, the shared modal-help state and the dashboard modal field atomically
	// (USABILITY-001).
	let lastOwner = bodyOwner(currentPage());
	createEffect(() => {
		const owner = bodyOwner(currentPage());
		if (owner === lastOwner) return;
		lastOwner = owner;
		nav.modalStack.set(
			createModalStackState<"filter" | "sort" | "theme" | "help">(),
		);
		closeModalHelp();
		props.dashboard?.keymap.setData("modal.active", "none");
	});
	const disposeShellFeatureField = props.dashboard
		? registerShellFeatureField(props.dashboard.keymap)
		: undefined;
	onCleanup(() => disposeShellFeatureField?.());
	createEffect(() => {
		props.dashboard?.keymap.setData("shell.feature", activeFeature());
	});
	// The legacy flat tab is a projection of the current page identity so the
	// existing observability content keeps one switch surface while the tab rows
	// are still rendered (they are removed in task 3.1).
	const activeTab = (): Tab => {
		const page = currentPage();
		if (page === "home") return "home";
		// Settings is chrome, not a feature body: its pages must not leave a
		// hidden observability body rendering behind them.
		if (page.startsWith("settings")) return "home";
		if (page.startsWith("environments")) return "environments";
		if (page.startsWith("workflows")) return "workflow";
		if (page.startsWith("wiki")) return "wiki";
		if (page.includes("metrics")) return "metrics";
		if (page.includes("logs")) return "logs";
		if (page.includes("topology")) return "topology";
		return "traces";
	};
	/** Traces-local view projected from the route, not from a second stack. */
	const traceView = (): "selection" | "detail" | "span" => {
		if (currentPage() === "observability.traces.tree") return "detail";
		if (currentPage() === "observability.traces.tree.span") return "span";
		return "selection";
	};
	/**
	 * The environment store calls the resource root view "appDetail"; the route
	 * calls it the base view so its children nest under the resource identity.
	 */
	const featureView = (view: string | undefined): string | undefined =>
		view === undefined
			? undefined
			: view === "appDetail"
				? RESOURCE_BASE_VIEW
				: view;
	const routeView = (view: string): string =>
		view === "" || view === RESOURCE_BASE_VIEW ? "appDetail" : view;

	/**
	 * Destination projection for the embedded environment feature: the route
	 * names the category and the nested view, and the feature reports its own
	 * destination changes back so one side is authoritative per direction.
	 */
	const environmentDestination = (): EnvironmentDestination | undefined => {
		const route = pages.current();
		if (!route.page.startsWith("environments")) return {};
		const onCategoryPage = route.page === "environments";
		return {
			...(onCategoryPage
				? {}
				: {
						category:
							route.page === "environments.resource"
								? route.params?.kind
								: route.page.split(".")[1],
					}),
			// A category page requests no view; only a resource page names one, so
			// the feature keeps its own table view there.
			view:
				route.params?.view === undefined
					? undefined
					: routeView(route.params.view),
			onChange: ({ category, view, resourceId }) => {
				// The category page is a shell destination list, not a feature
				// destination: while it is shown the feature reports where it happens
				// to sit, which is not a move the user made.
				if (currentPage() === "environments") return;
				if (!currentPage().startsWith("environments")) return;
				if (!view) {
					const page = `environments.${category}` as PageId;
					if (currentPage() !== page) pages.navigate({ page });
					return;
				}
				const next: Route = {
					page: "environments.resource",
					...(resourceId !== undefined ? { resourceId } : {}),
					params: { kind: category, view: featureView(view) ?? view },
				};
				if (routeKey(next) !== routeKey(pages.current())) pages.navigate(next);
			},
		};
	};

	/** Which destinations this shell instance actually renders. */
	const surface = (): DestinationSurface => ({
		environments: Boolean(props.environments),
		tracesOnly: Boolean(props.tracesOnly),
		wiki: props.dashboard?.mode === "home",
		// Settings owns the shared keymap the profile/preset editor needs, so the
		// surface that renders it is the one that has a dashboard-mounted shell.
		settings: Boolean(props.dashboard),
	});
	/** Home and the two category pages are destination lists; other pages are not. */
	const destinationEntries = (): DestinationEntry[] | undefined => {
		switch (currentPage()) {
			case "home":
				return homeDestinations(surface());
			case "settings":
				return settingsDestinations();
			case "environments":
				return environmentDestinations();
			case "observability":
				return observabilityDestinations(surface());
			default:
				return undefined;
		}
	};
	const destinationTitle = (): string => {
		switch (currentPage()) {
			case "home":
				return "Home";
			case "settings":
				return "Settings";
			case "environments":
				return "Environments";
			default:
				return "Observability";
		}
	};
	// Selection lives in route-keyed view state, so returning to a page restores
	// the cursor instead of resetting it (task 3.2).
	const destinationIndex = (): number =>
		pages.viewState<number>(pages.current()) ?? 0;
	const setDestinationIndex = (index: number): void => {
		pages.setViewState(pages.current(), index);
	};
	const openDestination = (entry: DestinationEntry): void => {
		pages.navigate(entry.route);
	};
	const handleDestinationKey = (key: string): boolean => {
		const entries = destinationEntries();
		if (!entries) return false;
		const last = Math.max(0, entries.length - 1);
		if (key === "j" || key === "down") {
			setDestinationIndex(Math.min(last, destinationIndex() + 1));
			return true;
		}
		if (key === "k" || key === "up") {
			setDestinationIndex(Math.max(0, destinationIndex() - 1));
			return true;
		}
		if (key === "enter" || key === "return") {
			const entry = entries[destinationIndex()];
			if (entry) openDestination(entry);
			return true;
		}
		return false;
	};

	// ---- Settings sections (centralize-application-settings) ----
	// One snapshot of the values a section shows; every source is resolved here
	// (route scope, agent config cache, client preferences, server reads) so the
	// item builders stay pure and testable.
	const [settingsAgentVersion, setSettingsAgentVersion] = createSignal(0);
	const [settingsAgentEditor, setSettingsAgentEditor] = createSignal(false);
	const settingsSection = (): SettingsSection | undefined =>
		settingsSectionOfPage(currentPage());
	/** Stable configured project id of a project-scoped Settings page. */
	const settingsProjectIdent = (): string | undefined =>
		settingsSection() ? pages.current().resourceId : undefined;
	/** Repository the project-scoped agent settings resolve from. */
	const settingsAgentRepository = (): string | undefined => {
		const ident = settingsProjectIdent();
		if (!ident) return undefined;
		return settingsProjects().projects.find(
			(project) => project.ident === ident,
		)?.repository;
	};
	const settingsContext = (): SettingsContext => {
		// Re-read the agent cache after a refresh; the cache itself is not reactive.
		settingsAgentVersion();
		const repository = settingsAgentRepository();
		const entry = agentConfigEntry(repository);
		const agents = entry.agents;
		return {
			themes: themeNames,
			activeTheme: getActiveThemeName(),
			clientSettingsPath: themeSettingsPath(),
			customThemeDir: join(configDir(), "themes"),
			section: settingsSection() ?? "appearance",
			agents: {
				scope: settingsProjectIdent() ? "project" : "user",
				...(settingsProjectIdent()
					? { projectIdent: settingsProjectIdent() }
					: {}),
				...(repository ? { repository } : {}),
				...(entry.provenance?.source
					? { source: entry.provenance.source }
					: {}),
				files: entry.provenance?.files ?? [],
				...(entry.provenance?.inactiveFiles?.length
					? { inactiveFiles: entry.provenance.inactiveFiles }
					: {}),
				conflicts: entry.conflicts ?? [],
				...(entry.error ? { error: entry.error } : {}),
				profiles: Object.entries(agents?.profiles ?? {}).map(
					([name, profile]) => ({
						name,
						value: [profile.runtime, profile.model].filter(Boolean).join(" · "),
					}),
				),
				presets: Object.entries(agents?.presets ?? {})
					.filter(([name]) => name !== BUILTIN_PRESET_NAME)
					.map(([name, preset]) => ({
						name,
						value: `${Object.keys(preset.steps ?? {}).length} steps`,
					})),
				routing: agents ? agentRoutingEntries(agents) : [],
			},
			providers: settingsProviders(),
			projects: settingsProjects(),
			backend: {
				values: resolveBackendSettings({
					serverUrl: props.environments?.serverUrl,
					owned: Boolean(props.environments && !props.attached),
					attached: Boolean(props.attached),
				}),
			},
		};
	};
	const settingsSectionItems = (): SettingsItem[] | undefined => {
		if (!settingsSection()) return undefined;
		return settingsItems(settingsContext(), settingsProjectIdent());
	};
	// Reads follow the visible section; an unavailable server stays a section
	// error with a retry rather than a local write.
	createEffect(() => {
		const page = currentPage();
		if (!page.startsWith("settings")) return;
		const section = settingsSectionOfPage(page);
		const ident = pages.current().resourceId;
		if (section === "providers")
			void refreshSettingsProviders(props.environments?.serverUrl);
		if (section === "projects" || (section === "agents" && ident))
			void refreshSettingsProjects(props.environments?.serverUrl);
	});
	createEffect(() => {
		if (settingsSection() !== "agents") return;
		const repository = settingsAgentRepository();
		void refreshAgentConfig(repository).then(() =>
			setSettingsAgentVersion((value) => value + 1),
		);
	});
	// Leaving Settings closes the shared editor: its keymap layer is registered
	// by the editor itself, so a hidden page must not keep it mounted.
	createEffect(() => {
		if (!currentPage().startsWith("settings")) setSettingsAgentEditor(false);
	});
	const settingsIndex = (): number =>
		pages.viewState<number>(pages.current()) ?? 0;
	const setSettingsIndex = (index: number): void => {
		pages.setViewState(pages.current(), index);
	};
	const activateSettingsItem = (item: SettingsItem | undefined): void => {
		if (!item) return;
		switch (item.action.kind) {
			case "none":
				return;
			case "theme-picker":
				// Reuse the shared picker (search, live preview, save on selection)
				// rather than a second theme list inside Settings.
				setThemeIndex(Math.max(0, themeNames.indexOf(getActiveThemeName())));
				setThemeQuery("");
				setThemeFiltering(false);
				nav.pushModal("theme", "home");
				return;
			case "retry":
				void refreshSettingsProviders(props.environments?.serverUrl);
				void refreshSettingsProjects(props.environments?.serverUrl);
				return;
			case "open-agents": {
				const ident = settingsProjectIdent();
				if (ident && !settingsAgentRepository()) {
					notify(
						`Project ${ident} is not in the connected server's catalog; refusing to edit a local fallback configuration`,
						"error",
					);
					return;
				}
				setSettingsAgentEditor(true);
				return;
			}
			case "navigate":
				pages.navigate(item.action.route);
				return;
		}
	};
	const handleSettingsKey = (key: string, shifted: boolean): boolean => {
		const items = settingsSectionItems();
		if (!items) return false;
		if (shifted && key === "r") {
			void refreshSettingsProviders(props.environments?.serverUrl);
			void refreshSettingsProjects(props.environments?.serverUrl);
			void refreshAgentConfig(settingsAgentRepository()).then(() =>
				setSettingsAgentVersion((value) => value + 1),
			);
			notify("Settings reloaded", "info");
			return true;
		}
		const last = Math.max(0, items.length - 1);
		if (key === "j" || key === "down") {
			setSettingsIndex(Math.min(last, settingsIndex() + 1));
			return true;
		}
		if (key === "k" || key === "up") {
			setSettingsIndex(Math.max(0, settingsIndex() - 1));
			return true;
		}
		if (key === "enter" || key === "return") {
			activateSettingsItem(items[settingsIndex()]);
			return true;
		}
		return false;
	};
	// Review comments deliberately live above the conditional tab content so
	// closing a note or switching tabs cannot discard the in-memory session.
	const [wikiComments, setWikiComments] = createSignal<WikiReviewComment[]>([]);
	const [wikiSubmitting, setWikiSubmitting] = createSignal(false);
	// Live command catalog published by the embedded environment feature; when
	// present the shell footer/help project the real registrations (task 3.6).
	const [environmentCatalog, setEnvironmentCatalog] = createSignal<
		KeybindSection[] | undefined
	>();

	// ---- Contextual workflow launch (launch-workflows-from-project-and-wiki-pages) ----
	// Workflow creation belongs to the page that owns the target: an
	// application/library resource page carries the configured project identity,
	// Wiki carries repository-independent research. The shell owns the creation
	// form and the start boundary; the resource page only reports the intent.
	// There is no workflow list, history, reopen or launcher surface anywhere.
	const [launchContext, setLaunchContext] =
		createSignal<WorkflowLaunchContext | null>(null);
	const [launchHandler, setLaunchHandler] = createSignal<
		((event: KeyEvent) => boolean) | undefined
	>();
	let launchPending = false;
	let disposeHandoffWatch: (() => void) | undefined;
	onCleanup(() => disposeHandoffWatch?.());
	/**
	 * Configured catalog roots kept current by the same catalog poll that keeps
	 * the discovery watchers correct. The Herdr sidebar presentation reads this
	 * live set instead of a TUI workflow list.
	 */
	const [catalogRoots, setCatalogRoots] = createSignal<string[]>([]);
	/** Stable repository source for the sidebar presentation owner: the same
	 * closure identity across every refresh, reading the current set lazily, so
	 * the custom view is installed once per connection. */
	const sidebarRepos = (): readonly string[] => [
		...props.repos,
		...catalogRoots(),
		wikiWorkflowDataRoot(),
		researchWorkflowTarget(),
	];
	const openLaunch = (context: WorkflowLaunchContext): void => {
		const problem = launchContextError(context);
		if (problem) {
			notify(problem, "warning");
			return;
		}
		if (!launchRepositoryAvailable(context)) {
			notify(
				context.kind === "project"
					? `Project ${context.name} is not available; clone or reconfigure it before starting work`
					: "The standalone research target is unavailable",
				"error",
			);
			return;
		}
		setLaunchContext(context);
		nav.pushModal("new-workflow", routeKey(pages.current()));
	};
	const closeLaunch = (): void => {
		setLaunchHandler(undefined);
		setLaunchContext(null);
		if (nav.modal() === "new-workflow") nav.popModal();
	};
	/**
	 * Submit through the existing typed start boundary. A rejected start created
	 * nothing and is reported as such; an accepted workflow hands its workspace
	 * to the existing Herdr orchestration while this application stays on the
	 * page it started from, and a later handoff failure is reported by identity
	 * rather than by submitting a second workflow.
	 */
	const submitLaunch = async (input: WorkflowLaunchInput): Promise<void> => {
		if (launchPending) return;
		launchPending = true;
		try {
			const outcome = await launchWorkflow(input);
			closeLaunch();
			if (outcome.kind === "rejected") {
				traceTui(
					"tui.workflow.launch",
					{ surface: "launch", action: "start" },
					"error",
				);
				notify(`Workflow start rejected: ${outcome.message}`, "error");
				return;
			}
			if (outcome.kind === "uncertain") {
				showErrorModal(
					"Workflow start outcome unknown",
					`${outcome.message}\nThe request failed before an answer arrived, so a workflow may exist. Check the Herdr workspace list instead of starting it again.`,
				);
				return;
			}
			traceTui("tui.workflow.launch", { surface: "launch", action: "start" });
			notify(outcome.message, "success");
			disposeHandoffWatch?.();
			disposeHandoffWatch = watchAcceptedHandoff(
				input.repo,
				outcome.workflowId,
				(message) =>
					notify(
						`Workflow ${outcome.workflowId} was accepted but its workspace handoff failed: ${message}. Repair it from its Herdr dashboard; it is not started again here.`,
						"error",
					),
			);
		} finally {
			launchPending = false;
		}
	};
	const [selectedListIndex, setSelectedListIndex] = createSignal(0);
	const [selectedTraceId, setSelectedTraceId] = createSignal<string>();
	const [treeRoots, setTreeRoots] = createSignal<TreeNode[]>([]);
	const [treeIndex, setTreeIndex] = createSignal(0);
	const [selectedSpan, setSelectedSpan] = createSignal<TreeNode>();
	const [activeWorkspace, setActiveWorkspace] = createSignal<string>();
	const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
	const [_spanCount, setSpanCount] = createSignal(0);
	const [filteredCount, setFilteredCount] = createSignal(0);
	const [themeIndex, setThemeIndex] = createSignal(
		Math.max(0, themeNames.indexOf(loadThemeName())),
	);
	const [themeQuery, setThemeQuery] = createSignal("");
	const [themeFiltering, setThemeFiltering] = createSignal(false);
	const filteredThemes = () =>
		themeNames.filter((name) => name.includes(themeQuery().toLowerCase()));
	const [lastQuit, setLastQuit] = createSignal(0);
	const [dataVersion, setDataVersion] = createSignal(0);
	const [filterPane, setFilterPane] = createSignal<"criteria" | "values">(
		"criteria",
	);
	const [filterCriterion, setFilterCriterion] = createSignal(0);
	const [filterStatusIndex, setFilterStatusIndex] = createSignal(0);
	const [filterWorkspaceIndex, setFilterWorkspaceIndex] = createSignal(0);
	const [sortIndex, setSortIndex] = createSignal(0);
	const [sortDraft, setSortDraft] = createSignal<SortCriterion[]>(
		props.traceStore.sortCriteria_,
	);
	const [searchMode, setSearchMode] = createSignal(false);
	const [searchQuery, setSearchQuery] = createSignal("");
	let searchPrevious = "";

	// ― Metric/Log detail state ―
	const [selectedMetricIndex, setSelectedMetricIndex] = createSignal(0);
	const [selectedMetric, setSelectedMetric] = createSignal<{
		name: string;
		serviceName: string;
	}>();
	const [selectedLogIndex, setSelectedLogIndex] = createSignal(0);
	const [selectedLog, setSelectedLog] = createSignal<number | undefined>();
	const [selectedTopologyService, setSelectedTopologyService] =
		createSignal<string>();
	const [topologyDetail, setTopologyDetail] = createSignal<string>();
	const [logFilterQuery, setLogFilterQuery] = createSignal("");

	const db = props.db;
	const traceStore = props.traceStore;
	const metricStore = props.metricStore;
	const logStore = props.logStore;
	const topologyStore = props.topologyStore;

	setWorkspaces(db.getWorkspaces());
	setSpanCount(traceStore.spanCount_);
	setFilteredCount(traceStore.filteredCount_);

	const summaries = createMemo(() => {
		dataVersion();
		return traceStore.getTraceSummaries();
	});
	const flatTree = createMemo(() => {
		const walk = (
			nodes: TreeNode[],
			parents: number[],
		): Array<{ node: TreeNode; path: number[] }> =>
			nodes.flatMap((node, index) => {
				const path = [...parents, index];
				return [
					{ node, path },
					...(node.expanded ? walk(node.children, path) : []),
				];
			});
		return walk(treeRoots(), []);
	});
	const refresh = () => {
		setDataVersion((v) => v + 1);
		setSpanCount(traceStore.spanCount_);
		setFilteredCount(traceStore.filteredCount_);
	};

	function selectTrace(index: number) {
		const trace = summaries()[index];
		if (!trace) return;
		openTrace(trace.traceId);
	}

	/** Open a trace by identity: the route names it, the data follows. */
	function openTrace(traceId: string): void {
		const roots = traceStore.getSpanTree(traceId);
		const index = summaries().findIndex(
			(summary) => summary.traceId === traceId,
		);
		setSelectedListIndex(index < 0 ? 0 : index);
		setSelectedTraceId(traceId);
		setTreeRoots(roots);
		setTreeIndex(0);
		setSelectedSpan(roots[0]);
		pages.navigate({ page: "observability.traces.tree", resourceId: traceId });
	}

	/** Index of the selected trace in the current ordering (ordering may change). */
	const selectedTraceIndex = (): number => {
		const id = selectedTraceId();
		if (!id) return selectedListIndex();
		const index = summaries().findIndex((summary) => summary.traceId === id);
		return index < 0 ? selectedListIndex() : index;
	};

	// ---- Route → data and unavailable-resource fallback (task 3.2) ----
	/**
	 * A resource page loads the identity its route names, so a direct jump and a
	 * Back restore the same content instead of whatever was selected before.
	 */
	const applyRouteData = (route: Route): void => {
		switch (route.page) {
			case "observability.traces.tree":
			case "observability.traces.tree.span": {
				const traceId = route.resourceId ?? route.params?.traceId;
				if (traceId && traceId !== selectedTraceId()) openTrace(traceId);
				break;
			}
			case "observability.metrics.detail": {
				const name = route.resourceId;
				const serviceName = route.params?.service ?? "";
				if (name && selectedMetric()?.name !== name)
					setSelectedMetric({ name, serviceName });
				break;
			}
			case "observability.logs.detail": {
				const index = logs().findIndex(
					(log) => logRouteIdentity(log) === route.resourceId,
				);
				if (index >= 0) setSelectedLog(index);
				break;
			}
			case "observability.topology.service": {
				const id = route.resourceId;
				if (id && topologyDetail() !== id) setTopologyDetail(id);
				break;
			}
			default:
				break;
		}
	};

	/** Whether a requested location still has the resource it names. */
	const routeAvailable = (route: Route): boolean => {
		switch (route.page) {
			case "observability.traces.tree":
			case "observability.traces.tree.span":
				return summaries().some(
					(summary) => summary.traceId === route.resourceId,
				);
			case "observability.metrics.detail":
				return metricStore
					.getStreams()
					.some(
						(stream) =>
							stream.name === route.resourceId &&
							(!route.params?.service ||
								stream.serviceName === route.params?.service),
					);
			case "observability.logs.detail":
				return logs().some((log) => logRouteIdentity(log) === route.resourceId);
			case "observability.topology.service":
				return topologyStore
					.getLayout()
					.some((node) => node.id === route.resourceId);
			default:
				return true;
		}
	};

	/** The log records of the current view (shared by the list and resolution). */
	const logs = (): OTelLogData[] => logStore.getLogs();

	createEffect(() => {
		const route = pages.current();
		const resolution = resolveAvailable(route, routeAvailable);
		if (resolution.unavailable) {
			notify(
				`${pageLabel(resolution.unavailable)} is no longer available`,
				"warning",
			);
			pages.dropViewState(resolution.unavailable);
			pages.replace(resolution.route);
			return;
		}
		applyRouteData(route);
	});

	/** Stable log identity for a route: the record's own fields, not its row. */
	function logRouteIdentity(log: OTelLogData): string {
		return `${log.timeUnixNano}|${log.serviceName}|${log.spanId ?? log.traceId ?? ""}`;
	}

	function selectTree(path: number[]) {
		const index = flatTree().findIndex(
			(item) => item.path.join(".") === path.join("."),
		);
		if (index < 0) return;
		setTreeIndex(index);
		setSelectedSpan(flatTree()[index]?.node);
	}

	function setNodeExpanded(path: number[], expanded: boolean) {
		let node: TreeNode | undefined;
		let nodes = treeRoots();
		for (const index of path) {
			node = nodes[index];
			if (!node) return;
			nodes = node.children;
		}
		if (!node) return;
		node.expanded = expanded;
		setTreeRoots([...treeRoots()]);
		const current =
			flatTree()[Math.min(treeIndex(), Math.max(0, flatTree().length - 1))];
		if (current) setSelectedSpan(current.node);
	}

	function switchWorkspace(changeId?: string) {
		setActiveWorkspace(changeId);
		traceStore.loadFile(db.loadSpans(changeId));
		setSelectedListIndex(0);
		setSelectedTraceId(undefined);
		setTreeRoots([]);
		setSelectedSpan(undefined);
		pages.navigate({ page: "observability.traces" });
		refresh();
	}

	async function finishWikiReview(
		comments: readonly WikiReviewComment[],
	): Promise<string> {
		// Repository-independent wiki review keeps its existing start boundary.
		return startWikiCommentWorkflowInProcess(comments);
	}

	onMount(() => {
		const prune = () => {
			const removed = db.cleanupOlderThan();
			if (!removed) return;
			setWorkspaces(db.getWorkspaces());
			traceStore.loadFile(db.loadSpans(activeWorkspace()));
			setSelectedListIndex(0);
			refresh();
			notify(`Pruned ${removed} spans older than 30 days`, "info");
		};
		const dailyPrune = setInterval(prune, 86_400_000);
		const onNew = (changeId: string) => {
			setWorkspaces(db.getWorkspaces());
			if (!activeWorkspace() || activeWorkspace() === changeId) {
				traceStore.loadFile(db.loadSpans(activeWorkspace()));
				refresh();
			}
		};
		// Watch registrations are diffed by canonical root: a configured-project
		// change adds or stops discovery watchers without touching histories or
		// active workflows.
		const watched = new Map<string, () => void>();
		const applyCatalogRoots = (roots: string[]) =>
			syncCatalogWatchers(watched, roots, (root) =>
				db.watchWorkspaces(root, onNew),
			);
		// Explicit `--repo`/wiki/research roots are always watched; catalog
		// canonical roots are added on top, so a catalog poll can never drop the
		// watcher for a repository that is not a configured catalog project.
		const applyRootsWithExplicit = (roots: string[]) =>
			applyCatalogRoots([...props.repos, ...roots]);
		applyRootsWithExplicit([]);
		// The backend emits `catalog.changed`; polling its revision keeps the
		// watcher set correct even when the event stream is not subscribed.
		const catalogUrl = props.environments?.serverUrl;
		let catalogDisposed = false;
		const catalogController = new AbortController();
		const refreshCatalogRoots = () => {
			if (!catalogUrl || catalogDisposed) return;
			void fetchProjectCatalog({
				baseUrl: catalogUrl,
				signal: catalogController.signal,
			})
				.then((catalog) => {
					if (catalogDisposed) return;
					const roots = projectCanonicalRoots(catalog);
					applyRootsWithExplicit(roots);
					setCatalogRoots(roots);
				})
				.catch(() => {});
		};
		// Seed catalog watchers immediately after first paint; the interval keeps
		// them in sync with configuration changes.
		refreshCatalogRoots();
		const catalogPoll = catalogUrl
			? setInterval(refreshCatalogRoots, 15_000)
			: undefined;
		// The long-lived presentation owner: one stable registration per shell
		// mount so sidebar cards are rebuilt from current views plus live Herdr
		// reads, never re-registered (or its custom view reasserted) on refresh
		// (improve-herdr-workflow-sidebar).
		const stopSidebarPresentation = startSidebarPresentation(sidebarRepos);
		// The initial history load and live OTLP receiver pushes mutate the store
		// directly (shell-owned), so refresh the mounted views on every change.
		const unsubscribeTraceStore = traceStore.onChange(refresh);
		// Focus restoration (task 3.1): when an overlay closes, return key
		// ownership to the underlying view by clearing the parked modal state.
		const disposeFocusRestorers = [
			"environments",
			"workflows",
			"observability",
			"wiki",
		].map((id) =>
			registerFocusRestorer(id, () => {
				props.dashboard?.keymap.setData("modal.active", "none");
			}),
		);
		// The TraceDb is owned by the shell (index.tsx) for the process lifetime;
		// remounting this view must not close it. Only stop this view's watchers.
		onCleanup(() => {
			catalogDisposed = true;
			catalogController.abort();
			clearInterval(dailyPrune);
			if (catalogPoll) clearInterval(catalogPoll);
			for (const stop of watched.values()) stop();
			watched.clear();
			stopSidebarPresentation();
			unsubscribeTraceStore();
			for (const dispose of disposeFocusRestorers) dispose();
		});
	});

	const copySelection = (reportEmpty = false) => {
		const text = renderer.getSelection()?.getSelectedText() ?? "";
		if (!text) {
			if (reportEmpty) notify("No selection to copy", "warning");
			return;
		}
		const copied = copyToClipboard(text);
		notify(
			copied ? "Copied selection" : "Copy failed",
			copied ? "success" : "error",
		);
		renderer.clearSelection();
	};

	const handleKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		const ename = event.name;

		// A global error modal owns every tab: keep it up (and scrollable) until
		// the user dismisses it, even on the observability tabs. The modal's own
		// keymap layer only scrolls; dismissal lives here so the key is consumed
		// once, before it can drive the tab underneath.
		if (activeErrorModal()) {
			if (key === "escape" || key === "enter" || key === "return")
				dismissErrorModal();
			return;
		}
		const traceDashModal = props.dashboard
			? props.dashboard.keymap.getData?.("modal.active")
			: "none";
		// Keystrokes can be character entry (the embedded dashboard's
		// passphrase/askpass prompt, or this pane's own search/filter fields);
		// per-character input must never reach a span, so suppress the
		// diagnostic in exactly those contexts.
		if (
			!isKeyTraceSuppressed({
				anyModalOpen:
					props.dashboard !== undefined &&
					traceDashModal !== undefined &&
					traceDashModal !== "none",
				searchEntry: searchMode(),
				filterEntry: nav.modal() === "theme" && themeFiltering(),
				wikiCommentEntry: wikiCommentEntryActive(),
			})
		) {
			traceTui("tui.observability.key", {
				surface: "observability",
				action: "key",
				key: `${event.ctrl ? "ctrl+" : ""}${key}`,
				view: activeTab(),
				phase: nav.modal() ?? "none",
				modal: traceDashModal,
			});
		}
		// Lifecycle overlay (startup/shutdown modal) consumes keys; 'q' still works
		// via the home keymap layer, which routes it to requestShutdown.
		// Interactive quit guard: while the shell asks whether to cancel running
		// workflow work, only the answer keys are live.
		if (quitConfirmation()) {
			if (key === "y" || key === "Enter") resolveQuitConfirmation(true);
			else if (key === "n" || key === "Escape") resolveQuitConfirmation(false);
			return;
		}
		if (phase() === "starting" || phase() === "stopping") return;

		// Modal `?` help: an open dialog advertises its own `?` entry and opens
		// the shared HelpModal with that dialog's catalog. While it is open,
		// j/k/Esc drive the overlay instead of the dialog underneath.
		if (nav.modal() !== "none") {
			if (modalHelpOpen()) {
				handleModalHelpKey(key);
				return;
			}
			if (key === "?" && handleModalHelpKey(key)) {
				return;
			}
		}

		// The contextual creation form owns input while it is open. The shell
		// routes every key to the mounted form's own handler and never falls
		// through to the page behind it.
		if (nav.modal() === "new-workflow") {
			const handler = launchHandler();
			if (!handler) {
				if (key === "escape") closeLaunch();
				return;
			}
			// A form step that edits text returns false so the native editor keeps
			// the character; the overlay binding never prevents the default.
			handler(event);
			return;
		}

		// The location picker owns input while it is on top: search, select, jump.
		if (nav.modal() === "locations") {
			const matches = pickerMatches();
			const last = Math.max(0, matches.length - 1);
			if (key === "escape" || (event.ctrl && key === "p")) {
				nav.popModal();
			} else if (key === "backspace" || key === "delete") {
				setPickerQuery((query) => query.slice(0, -1));
				setPickerIndex(0);
			} else if (key === "down") {
				// The picker is a search box: typing wins, so only the arrow keys
				// move the cursor (a destination name may contain j or k).
				setPickerIndex((index) => Math.min(last, index + 1));
			} else if (key === "up") {
				setPickerIndex((index) => Math.max(0, index - 1));
			} else if (key === "enter" || key === "return") {
				const entry = matches[pickerIndex()];
				nav.popModal();
				if (entry) pages.navigate(entry.route);
			} else if (!event.ctrl && !event.meta) {
				// A search box accepts spaces: the key event names them "space".
				const typed = key === "space" ? " " : key;
				if (typed.length === 1) {
					setPickerQuery((query) => query + typed);
					setPickerIndex(0);
				}
			}
			return;
		}

		// Global copy
		if (
			(event.meta && key === "c") ||
			(event.ctrl && event.shift && key === "c")
		) {
			copySelection(true);
			return;
		}

		if (nav.modal() === "theme") {
			const items = filteredThemes();
			if (key === "escape") {
				if (themeFiltering()) {
					setThemeFiltering(false);
					setThemeQuery("");
					setThemeIndex(0);
				} else nav.popModal();
			} else if (key === "/") {
				setThemeFiltering(true);
				setThemeQuery("");
				setThemeIndex(0);
			} else if (themeFiltering() && key === "backspace") {
				setThemeQuery((query) => query.slice(0, -1));
				setThemeIndex(0);
			} else if (themeFiltering() && key.length === 1) {
				setThemeQuery((query) => query + key);
				setThemeIndex(0);
			} else if (key === "j" || key === "down") {
				const next = Math.min(items.length - 1, themeIndex() + 1);
				const item = items[next];
				if (item) {
					setThemeIndex(next);
					applyTheme(item);
				}
			} else if (key === "k" || key === "up") {
				const next = Math.max(0, themeIndex() - 1);
				const item = items[next];
				if (item) {
					setThemeIndex(next);
					applyTheme(item);
				}
			} else if (key === "enter" || key === "return") {
				if (themeFiltering()) setThemeFiltering(false);
				const selected = items[themeIndex()];
				if (selected) {
					saveThemeName(selected);
					nav.popModal();
				}
			}
			return;
		}

		if (nav.modal() === "help") {
			if (key === "escape") {
				// Closing restores the parked feature layer through the modal effect.
				nav.popModal();
			} else if (key === "j" || key === "down")
				setHelpOffset((value) => Math.min(helpMaxOffset(), value + 1));
			else if (key === "k" || key === "up")
				setHelpOffset((value) => Math.max(0, value - 1));
			return;
		}

		// Breadcrumb focus: h/l walk the ancestor chain, Enter opens one.
		if (nav.modal() === "none" && focusCrumb()) {
			const chain = ancestors();
			const last = Math.max(0, chain.length - 1);
			const current = Math.min(last, Math.max(0, crumbFocusedIndex()));
			if (key === "h" || key === "left") {
				setCrumbIndex(Math.max(0, current - 1));
				return;
			}
			if (key === "l" || key === "right") {
				setCrumbIndex(Math.min(last, current + 1));
				return;
			}
			if (key === "j" || key === "down") {
				setCrumbIndex(Math.min(last, current + 1));
				return;
			}
			if (key === "k" || key === "up") {
				setCrumbIndex(Math.max(0, current - 1));
				return;
			}
			if (key === "enter" || key === "return") {
				const route = chain[current];
				if (route && routeKey(route) !== routeKey(pages.current()))
					pages.navigate(route);
				return;
			}
			if (key === "escape") {
				setFocusRegion("content");
				setCrumbIndex(-1);
				return;
			}
		}

		// No global destination cycling and no numeric dispatch: destinations are
		// pages reached from Home, the breadcrumb or the location picker. Tab and
		// Shift+Tab traverse this page's focus regions only.
		const activeFeatureId = (): string =>
			props.environments ? (activeFeature() ?? activeTab()) : activeTab();
		const isTab = ename === "Tab" || key === "tab" || key === "\t";
		const isCtrlTab = event.ctrl && key === "i"; // Ctrl+I = Tab in many terminals
		const tabForward = (isTab || isCtrlTab) && !event.shift;
		const tabBack = (isTab || isCtrlTab) && event.shift;
		if (
			nav.modal() === "none" &&
			(tabForward || tabBack) &&
			pageFocusRegions().length > 1
		) {
			cycleFocusRegion(tabBack ? -1 : 1);
			return;
		}

		// Ctrl+P opens the one location picker from anywhere on the shell.
		if (event.ctrl && key === "p") {
			openLocationPicker();
			return;
		}
		// Alt+Up opens the structural parent of the current page.
		if (event.option && key === "up") {
			pages.goToParent();
			return;
		}

		// Dashboard and wiki bodies own their keys through their own keymap layers.
		if (activeTab() === "workflow" || activeTab() === "wiki") return;

		// Quit (global)
		if (key === "q") {
			const now = Date.now();
			if (lastQuit() && now - lastQuit() < 1000) {
				if (props.dashboard?.mode === "home") globalThis.__requestShutdown?.();
				else globalThis.__renderer?.destroy();
			} else {
				setLastQuit(now);
				notify("Press q again to quit", "info");
			}
			return;
		}

		// Escape: the top overlay first, then chronological Back. Escape at Home
		// is a no-op (Home has no parent and quitting stays explicit).
		if (key === "escape") {
			if (nav.esc()) return;
			if (pages.canBack()) {
				pages.back();
				return;
			}
		}

		if (event.shift && key === "t" && nav.modal() === "none") {
			setThemeIndex(Math.max(0, themeNames.indexOf(getActiveThemeName())));
			setThemeQuery("");
			setThemeFiltering(false);
			nav.pushModal("theme", activeFeatureId());
			return;
		}

		// Search mode keeps the query editable; Tab belongs to the input.
		if (searchMode()) {
			if (key === "escape") {
				if (activeTab() === "logs") {
					logStore.setFilter("");
					setLogFilterQuery("");
				} else {
					traceStore.applyFilter(searchPrevious);
					setSearchQuery(searchPrevious);
					refresh();
				}
				setSearchMode(false);
			} else if (key === "backspace") {
				if (activeTab() === "logs") {
					const q = logFilterQuery().slice(0, -1);
					setLogFilterQuery(q);
					logStore.setFilter(q);
				} else {
					const q = searchQuery().slice(0, -1);
					setSearchQuery(q);
					traceStore.applyFilter(q);
					setSelectedListIndex(0);
					refresh();
				}
			} else if (key === "enter" || key === "return") {
				setSearchMode(false);
			} else if (key.length === 1 && !event.ctrl && !event.meta) {
				if (activeTab() === "logs") {
					const q = logFilterQuery() + key;
					setLogFilterQuery(q);
					logStore.setFilter(q);
				} else {
					const q = searchQuery() + key;
					setSearchQuery(q);
					traceStore.applyFilter(q);
					setSelectedListIndex(0);
					refresh();
				}
			}
			return;
		}

		// Help (shell tabs): the `?` modal reads the active catalog. Ignore it
		// while one of this tab's own modals (filter/sort/theme) owns the keys.
		if (key === "?" && nav.modal() === "none") {
			setHelpOffset(0);
			nav.pushModal("help", activeFeatureId());
			return;
		}

		// Destination pages (Home and the category pages) own their cursor. Only
		// those three pages have entries, and only while no overlay is on top.
		if (nav.modal() === "none" && !focusCrumb() && handleDestinationKey(key))
			return;

		// Settings section pages own their cursor the same way (j/k/Enter and the
		// explicit reload); the shared editor dialog owns its keys through its own
		// keymap layer while it is open.
		if (
			nav.modal() === "none" &&
			!focusCrumb() &&
			handleSettingsKey(key, event.shift)
		)
			return;

		// The embedded environment feature owns its keys; do not fall through to
		// the traces handlers below (which would move the hidden trace selection).
		if (activeTab() === "environments") return;

		// Tab-specific key handling
		if (activeTab() === "metrics") return handleMetricsKey(event, key);
		if (activeTab() === "logs") return handleLogsKey(event, key);
		if (activeTab() === "topology") return handleTopologyKey(event, key);

		// ---- Traces tab key handling (existing logic) ----
		if (nav.modal() === "filter") {
			if (key === "x") {
				traceStore.applyFilter("");
				traceStore.setStatusFilter("all");
				setSearchQuery("");
				setFilterPane("criteria");
				setFilterCriterion(0);
				setFilterStatusIndex(0);
				setFilterWorkspaceIndex(0);
				switchWorkspace();
				refresh();
			} else if (key === "h" || key === "left") setFilterPane("criteria");
			else if (key === "l" || key === "right") setFilterPane("values");
			else if (filterPane() === "criteria" && (key === "j" || key === "down"))
				setFilterCriterion((i) => Math.min(1, i + 1));
			else if (filterPane() === "criteria" && (key === "k" || key === "up"))
				setFilterCriterion((i) => Math.max(0, i - 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 0 &&
				(key === "j" || key === "down")
			)
				setFilterStatusIndex((i) => Math.min(statusOptions.length - 1, i + 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 0 &&
				(key === "k" || key === "up")
			)
				setFilterStatusIndex((i) => Math.max(0, i - 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 1 &&
				(key === "j" || key === "down")
			)
				setFilterWorkspaceIndex((i) => Math.min(workspaces().length, i + 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 1 &&
				(key === "k" || key === "up")
			)
				setFilterWorkspaceIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return") {
				traceStore.setStatusFilter(statusOptions[filterStatusIndex()]?.value);
				switchWorkspace(
					filterWorkspaceIndex() === 0
						? undefined
						: workspaces()[filterWorkspaceIndex() - 1]?.changeId,
				);
				setSelectedListIndex(0);
				refresh();
				nav.popModal();
			}
			return;
		}
		if (nav.modal() === "sort") {
			const shifted =
				event.shift ||
				(event.name.length === 1 && event.name >= "A" && event.name <= "Z");
			if (key === "space")
				setSortDraft((criteria) =>
					criteria.map((c, i) =>
						i === sortIndex()
							? {
									...c,
									mode:
										c.mode === "asc"
											? "desc"
											: c.mode === "desc"
												? "none"
												: "asc",
								}
							: c,
					),
				);
			else if (key === "j" && shifted)
				setSortDraft((criteria) => {
					const i = sortIndex();
					if (i >= criteria.length - 1) return criteria;
					const copy = [...criteria];
					[copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
					setSortIndex(i + 1);
					return copy;
				});
			else if (key === "k" && shifted)
				setSortDraft((criteria) => {
					const i = sortIndex();
					if (i === 0) return criteria;
					const copy = [...criteria];
					[copy[i], copy[i - 1]] = [copy[i - 1], copy[i]];
					setSortIndex(i - 1);
					return copy;
				});
			else if (key === "j" || key === "down")
				setSortIndex((i) => Math.min(sortDraft().length - 1, i + 1));
			else if (key === "k" || key === "up")
				setSortIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return") {
				traceStore.setSortCriteria(sortDraft());
				setSelectedListIndex(0);
				refresh();
				nav.popModal();
			}
			return;
		}

		const shifted =
			event.shift ||
			(event.name.length === 1 && event.name >= "A" && event.name <= "Z");
		if (key === "/") {
			searchPrevious = traceStore.filterQuery_;
			setSearchQuery(searchPrevious);
			setSearchMode(true);
		} else if (key === "f" && shifted) {
			setFilterPane("criteria");
			setFilterCriterion(0);
			setFilterStatusIndex(
				Math.max(
					0,
					statusOptions.findIndex((o) => o.value === traceStore.statusFilter_),
				),
			);
			setFilterWorkspaceIndex(
				Math.max(
					0,
					workspaces().findIndex((w) => w.changeId === activeWorkspace()) + 1,
				),
			);
			nav.pushModal("filter", activeFeatureId());
		} else if (key === "o" && shifted) {
			setSortDraft(traceStore.sortCriteria_);
			setSortIndex(0);
			nav.pushModal("sort", activeFeatureId());
		} else if (key === "w") {
			switchWorkspace();
			notify("All workspaces", "info");
		} else if (traceView() === "selection") {
			if (key === "j" || key === "down")
				setSelectedListIndex((i) => Math.min(summaries().length - 1, i + 1));
			else if (key === "k" || key === "up")
				setSelectedListIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return")
				selectTrace(selectedListIndex());
		} else {
			const items = flatTree();
			if (key === "escape" || key === "b") pages.back();
			else if (key === "j" || key === "down") {
				const i = Math.min(items.length - 1, treeIndex() + 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "k" || key === "up") {
				const i = Math.max(0, treeIndex() - 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "g" && event.shift) {
				const i = Math.max(0, items.length - 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "g") {
				setTreeIndex(0);
				setSelectedSpan(items[0]?.node);
			} else if (key === "h") {
				const item = items[treeIndex()];
				if (item) setNodeExpanded(item.path, false);
			} else if (key === "l") {
				const item = items[treeIndex()];
				if (item) setNodeExpanded(item.path, true);
			} else if (key === "enter" || key === "return") {
				const span = selectedSpan();
				if (span)
					pages.navigate({
						page: "observability.traces.tree.span",
						resourceId: `${span.span.traceId}:${span.span.spanId}`,
						params: { traceId: span.span.traceId },
					});
			}
		}
	};

	// ---- Metric tab keys ----
	function handleMetricsKey(_event: KeyEvent, key: string) {
		if (currentPage() === "observability.metrics.detail") {
			if (key === "escape" || key === "b") pages.back();
			return;
		}
		const streams = metricStore.getStreams();
		if (key === "j" || key === "down")
			setSelectedMetricIndex((i) => Math.min(streams.length - 1, i + 1));
		else if (key === "k" || key === "up")
			setSelectedMetricIndex((i) => Math.max(0, i - 1));
		else if (key === "enter" || key === "return") {
			const stream = streams[selectedMetricIndex()];
			if (stream) {
				setSelectedMetric({
					name: stream.name,
					serviceName: stream.serviceName,
				});
				pages.navigate({
					page: "observability.metrics.detail",
					resourceId: stream.name,
					params: { service: stream.serviceName },
				});
			}
		}
	}

	// ---- Log tab keys ----
	function handleLogsKey(_event: KeyEvent, key: string) {
		if (currentPage() === "observability.logs.detail") {
			if (key === "escape" || key === "b") pages.back();
			return;
		}
		const logs = logStore.getLogs();
		if (key === "j" || key === "down")
			setSelectedLogIndex((i) => Math.min(logs.length - 1, i + 1));
		else if (key === "k" || key === "up")
			setSelectedLogIndex((i) => Math.max(0, i - 1));
		else if (key === "enter" || key === "return") {
			const log = logs[selectedLogIndex()];
			if (log) {
				setSelectedLog(selectedLogIndex());
				pages.navigate({
					page: "observability.logs.detail",
					resourceId: logRouteIdentity(log),
				});
			}
		} else if (key === "/") {
			setLogFilterQuery("");
			setSearchMode(true);
		}
	}

	// ---- Topology tab keys ----
	function handleTopologyKey(_event: KeyEvent, key: string) {
		if (currentPage() === "observability.topology.service") {
			if (key === "escape" || key === "b") pages.back();
			return;
		}
		const ids = topologyStore.getLayout().map((node) => node.id);
		const current = Math.max(0, ids.indexOf(selectedTopologyService() ?? ""));
		if (key === "j" || key === "down")
			setSelectedTopologyService(ids[Math.min(ids.length - 1, current + 1)]);
		else if (key === "k" || key === "up")
			setSelectedTopologyService(ids[Math.max(0, current - 1)]);
		else if (key === "enter" || key === "return") {
			const id = selectedTopologyService() ?? ids[0];
			if (id) {
				setTopologyDetail(id);
				pages.navigate({
					page: "observability.topology.service",
					resourceId: id,
				});
			}
		}
	}

	// Single dispatcher: when the shell owns a keymap (the production home/dash
	// entrypoints always pass one), shell keys are a lowest-priority keymap
	// layer so higher-priority dashboard/environment layers run first. The raw
	// listener remains only as a fallback for keymap-less test mounts.
	const shellKeymap = props.dashboard?.keymap;
	if (shellKeymap) {
		const disposeShellKeyLayer = registerShellKeyLayer(shellKeymap, handleKey);
		onCleanup(disposeShellKeyLayer);
		// Shell-owned overlays take input precedence over every feature layer;
		// the environment feature's own dialogs stay with the environment layer.
		createEffect(() => {
			const kind = nav.modal();
			if (!SHELL_OWNED_OVERLAYS.has(kind)) return;
			onCleanup(registerShellOverlayLayer(shellKeymap, handleKey));
		});
	} else {
		renderer.keyInput.on("keypress", handleKey);
		onCleanup(() => renderer.keyInput.off("keypress", handleKey));
	}

	// Page-local focus regions. Tab/Shift+Tab move between these only; a feature
	// body that owns its own focus handling such as the embedded environment
	// surface or the dashboard contributes a single region, so the shell never
	// steals Tab from it.
	const pageFocusRegions = (): Array<"breadcrumb" | "content"> => {
		if (currentPage().startsWith("environments.")) return ["content"];
		if (activeTab() === "workflow" || activeTab() === "wiki")
			return ["content"];
		return ["breadcrumb", "content"];
	};
	const [focusRegion, setFocusRegion] = createSignal<"breadcrumb" | "content">(
		"content",
	);
	const focusCrumb = () => focusRegion() === "breadcrumb";
	const cycleFocusRegion = (delta: number): void => {
		const regions = pageFocusRegions();
		const current = Math.max(0, regions.indexOf(focusRegion()));
		setFocusRegion(
			regions[(current + delta + regions.length) % regions.length],
		);
	};
	// Breadcrumb cursor over the logical ancestor chain; the last ancestor (the
	// current location) is where it rests until the user moves it.
	const ancestors = () => breadcrumb(pages.current());
	const [crumbIndex, setCrumbIndex] = createSignal(-1);
	const crumbFocusedIndex = (): number =>
		crumbIndex() >= 0 ? crumbIndex() : ancestors().length - 1;

	// One location picker, opened from anywhere (Ctrl+P), over in-memory
	// destinations only.
	const [pickerQuery, setPickerQuery] = createSignal("");
	const [pickerIndex, setPickerIndex] = createSignal(0);
	const pickerMatches = (): DestinationEntry[] =>
		filterPickerEntries(
			pickerEntries(surface(), pickerEntriesForPage()),
			pickerQuery(),
		);
	const openLocationPicker = (): void => {
		setPickerQuery("");
		setPickerIndex(0);
		nav.pushModal("locations", routeKey(pages.current()));
	};
	/**
	 * In-memory identities the picker may offer: the resources this shell has
	 * already loaded, never a repository or global index scan. Capped: the
	 * picker is a jump list, not a catalogue of everything on disk.
	 */
	const resourceEntries = (): DestinationEntry[] => {
		const entries: DestinationEntry[] = [];
		for (const summary of summaries().slice(0, 20)) {
			entries.push({
				id: `trace:${summary.traceId}`,
				label: summary.traceId,
				description: "Loaded trace",
				group: "Traces",
				route: {
					page: "observability.traces.tree",
					resourceId: summary.traceId,
				},
			});
		}
		for (const stream of metricStore.getStreams().slice(0, 20)) {
			entries.push({
				id: `metric:${stream.serviceName}:${stream.name}`,
				label: stream.name,
				description: stream.serviceName,
				group: "Metrics",
				route: {
					page: "observability.metrics.detail",
					resourceId: stream.name,
					params: { service: stream.serviceName },
				},
			});
		}
		for (const node of topologyStore.getLayout().slice(0, 20)) {
			entries.push({
				id: `service:${node.id}`,
				label: node.id,
				description: "Topology service",
				group: "Topology",
				route: {
					page: "observability.topology.service",
					resourceId: node.id,
				},
			});
		}
		return entries;
	};
	const pickerEntriesForPage = (): DestinationEntry[] => resourceEntries();

	const tabKeybindCatalog = (): KeybindSection[] => {
		const tab = activeTab();
		return observabilityKeybindCatalog({
			tab: tab === "home" ? "traces" : tab,
			view: traceView(),
		});
	};

	// The shell footer and `?` help read the active surface catalog from the
	// shared store. The dashboard (workflow tab) publishes its own catalog, so
	// the shell skips it there instead of fighting for the store.
	createEffect(() => {
		// The contextual creation form currently owns input, so the footer and `?`
		// describe what it is doing rather than the page behind it.
		if (nav.modal() === "new-workflow") {
			setActiveKeybindCatalog(workflowLaunchKeybindCatalog());
			return;
		}
		// Destination pages publish their own catalog: the shell feature bodies
		// (environments) publish theirs while visible.
		if (destinationEntries()) {
			setActiveKeybindCatalog(destinationPageKeybindCatalog());
			return;
		}
		// Settings sections publish their own catalog: the destination catalog
		// describes a list of pages, which a section is not.
		if (settingsSection()) {
			setActiveKeybindCatalog(settingsKeybindCatalog());
			return;
		}
		setActiveKeybindCatalog(
			props.environments && currentPage().startsWith("environments.")
				? (environmentCatalog() ?? environmentsKeybindCatalog())
				: tabKeybindCatalog(),
			// The wiki's note-only actions are footer-visible while a note is open.
			currentPage() === "wiki.note" ? "note" : undefined,
		);
	});

	return (
		<box
			backgroundColor={uiColors.bgBase}
			width="100%"
			height="100%"
			onMouseUp={() => copySelection()}
		>
			<box
				backgroundColor={uiColors.bgBase}
				style={{
					width: "100%",
					height: "100%",
					flexDirection: "column",
					padding: props.dashboard ? 0 : 1,
					gap: 0,
				}}
			>
				{/* Header — the workflow header (dashboard data) or a simple logo bar */}
				<box
					backgroundColor={uiColors.bgMantle}
					style={{ width: "100%", flexDirection: "column" }}
				>
					{(() => {
						return (
							<box
								style={{
									height: 1,
									flexDirection: "row",
									alignItems: "center",
									paddingLeft: 1,
									paddingRight: 1,
								}}
							>
								<text
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								>
									AGENTIC CODING
								</text>
								<box style={{ flexGrow: 1 }} />
								<Show when={props.attached}>
									<text fg={uiColors.textMuted} attributes={TextAttributes.DIM}>
										{props.attachLabel ??
											`attached ${props.environments?.serverUrl ?? ""} · environment features only · remote workflow features unavailable`}
									</text>
								</Show>
								<Badge text={activeTab()} highlight="accent" />
							</box>
						);
					})()}
				</box>
				{/* One bounded breadcrumb row from structural ancestors (never history). */}
				<BreadcrumbRow
					ancestors={ancestors()}
					focusedIndex={crumbFocusedIndex()}
					onSelectIndex={(index) => {
						setFocusRegion("breadcrumb");
						setCrumbIndex(index);
					}}
					onNavigate={(route) => pages.navigate(route)}
				/>

				{/* Tab content */}
				<box
					backgroundColor={uiColors.bgBase}
					style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
				>
					{/* Destination pages: Home and the category pages. */}
					{(() => {
						const entries = destinationEntries();
						return entries ? (
							<CategoryPage
								title={destinationTitle()}
								description={
									currentPage() === "home"
										? "Choose a destination. Ctrl+P jumps anywhere."
										: undefined
								}
								entries={entries}
								selectedIndex={destinationIndex()}
								onSelectIndex={setDestinationIndex}
								onOpen={openDestination}
							/>
						) : null;
					})()}
					{/* Settings sections: one list of effective values per section. */}
					{(() => {
						const section = settingsSection();
						const items = settingsSectionItems();
						return section && items ? (
							<SettingsSectionView
								title={SETTINGS_SECTION_LABELS[section]}
								description={SETTINGS_SECTION_DESCRIPTIONS[section]}
								items={items}
								selectedIndex={settingsIndex()}
								onSelectIndex={setSettingsIndex}
							/>
						) : null;
					})()}
					{/* Feature bodies stay mounted while hidden: switching shell tabs must
					 * preserve live environment/workflow drafts, selections and subscriptions. */}
					{props.renderEnvironments && (
						<box
							visible={currentPage().startsWith("environments.")}
							style={{ flexGrow: 1, minHeight: 0 }}
						>
							{props.renderEnvironments(
								setEnvironmentCatalog,
								() => currentPage().startsWith("environments."),
								(open) => {
									// While a shell-owned overlay is on top the shell owns input,
									// so the feature's own modal report is not authoritative:
									// mirroring it here would stack the two overlays and leave the
									// top one without a key handler.
									if (SHELL_OWNED_OVERLAYS.has(nav.modal())) return;
									if (open && activeFeature() === "environments") {
										if (nav.modal() !== "environment")
											nav.pushModal("environment", "environments");
									} else if (!open && nav.modal() === "environment") {
										nav.popModal();
									}
								},
								environmentDestination,
								(project) =>
									openLaunch({
										kind: "project",
										ident: project.ident,
										name: project.name,
										repository: project.repository,
									}),
							)}
						</box>
					)}
					{props.dashboard?.mode === "home" && (
						<box
							visible={activeTab() === "wiki"}
							style={{ flexGrow: 1, minHeight: 0 }}
						>
							<WikiView
								keymap={props.dashboard.keymap}
								shellFeature="wiki"
								comments={wikiComments()}
								onAddComment={(comment) =>
									setWikiComments((comments) => [...comments, comment])
								}
								onFinish={finishWikiReview}
								submitting={wikiSubmitting()}
								onSubmittingChange={setWikiSubmitting}
								onClearComments={() => setWikiComments([])}
								noteId={
									currentPage() === "wiki.note"
										? pages.current().resourceId
										: undefined
								}
								onOpenNote={(conceptId) =>
									pages.navigate({
										page: "wiki.note",
										resourceId: conceptId,
									})
								}
								onCloseNote={() => pages.back()}
								// Repository-independent research starts from Wiki, the only
								// full-application entry for work that has no project.
								onStartWorkflow={() => openLaunch({ kind: "independent" })}
								onHelp={() => {
									setHelpOffset(0);
									// The shell modal effect parks WikiView's keymap layer while
									// the help overlay is open, so j/k/Esc reach the modal.
									nav.pushModal("help", "wiki");
								}}
							/>
						</box>
					)}
					{activeTab() === "traces" && (
						<>
							{traceView() === "selection" && (
								<TraceListView
									summaries={summaries}
									selectedIndex={selectedTraceIndex}
									searchMode={searchMode}
									searchQuery={searchQuery}
									resultCount={filteredCount}
									onSelect={selectTrace}
								/>
							)}
							{traceView() === "detail" && (
								<box
									style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
								>
									<box
										height={1}
										paddingLeft={1}
										flexShrink={0}
										flexDirection="row"
									>
										<HighlightedText
											text="Span tree"
											attributes={TextAttributes.BOLD}
										/>
										<box style={{ flexGrow: 1 }} />
										<text fg={uiColors.textMuted}>
											{flatTree().length} visible
										</text>
									</box>
									<box style={{ flexGrow: 1, minHeight: 0 }}>
										<TraceTreeView
											roots={treeRoots}
											selectedIndex={treeIndex}
											onToggle={(node, path) =>
												setNodeExpanded(path, !node.expanded)
											}
											onSelect={selectTree}
										/>
									</box>
								</box>
							)}
							{traceView() === "span" && <SpanDetailView node={selectedSpan} />}
						</>
					)}
					{activeTab() === "metrics" && (
						<>
							{currentPage() !== "observability.metrics.detail" && (
								<MetricsView
									store={metricStore}
									selectedIndex={selectedMetricIndex}
									onSelectIndex={setSelectedMetricIndex}
									onOpen={(name, serviceName) => {
										setSelectedMetric({ name, serviceName });
										pages.navigate({
											page: "observability.metrics.detail",
											resourceId: name,
											params: { service: serviceName },
										});
									}}
								/>
							)}
							{(() => {
								const selected = selectedMetric();
								return currentPage() === "observability.metrics.detail" &&
									selected ? (
									<MetricDetailView
										store={metricStore}
										name={selected.name}
										serviceName={selected.serviceName}
										onBack={() => pages.back()}
									/>
								) : null;
							})()}
						</>
					)}
					{activeTab() === "logs" && (
						<>
							{currentPage() !== "observability.logs.detail" && (
								<LogsView
									store={logStore}
									selectedIndex={selectedLogIndex}
									onSelectIndex={setSelectedLogIndex}
									onOpen={(index) => {
										setSelectedLog(index);
										const log = logStore.getLogs()[index];
										if (log)
											pages.navigate({
												page: "observability.logs.detail",
												resourceId: logRouteIdentity(log),
											});
									}}
								/>
							)}
							{(() => {
								const idx = selectedLog();
								return currentPage() === "observability.logs.detail" &&
									idx !== undefined ? (
									<LogDetailView
										store={logStore}
										index={idx}
										onBack={() => pages.back()}
									/>
								) : null;
							})()}
						</>
					)}
					{activeTab() === "topology" && (
						<>
							{currentPage() !== "observability.topology.service" && (
								<TopologyView
									store={topologyStore}
									selectedService={selectedTopologyService}
									onSelect={(id) => {
										setSelectedTopologyService(id);
										pages.navigate({
											page: "observability.topology.service",
											resourceId: id,
										});
									}}
								/>
							)}
							{(() => {
								const id = topologyDetail();
								return currentPage() === "observability.topology.service" &&
									id ? (
									<ServiceDetailView store={topologyStore} id={id} />
								) : null;
							})()}
						</>
					)}
				</box>

				{/* Status bar — one global footer for all tabs; keybinds are tab-dependent. */}
				<box style={{ height: 1 }} />
				<StatusBar />
			</box>
			<NotificationOverlay />
			<ErrorModalOverlay keymap={props.dashboard?.keymap} />
			{nav.modal() === "filter" && (
				<FilterModal
					pane={filterPane}
					criterion={filterCriterion}
					statusIndex={filterStatusIndex}
					workspaceIndex={filterWorkspaceIndex}
					workspaces={workspaces}
				/>
			)}
			{nav.modal() === "sort" && (
				<SortModal selected={sortIndex} criteria={sortDraft} />
			)}
			{nav.modal() === "theme" && (
				<ThemePickerModal
					selected={themeIndex}
					active={getActiveThemeName}
					themes={filteredThemes}
					query={themeQuery}
					filtering={themeFiltering}
				/>
			)}
			{nav.modal() === "locations" && (
				<LocationPicker
					entries={pickerEntries(surface(), pickerEntriesForPage())}
					query={pickerQuery()}
					selectedIndex={pickerIndex()}
					onQueryChange={setPickerQuery}
					onSelectIndex={setPickerIndex}
					onAccept={(route) => {
						nav.popModal();
						pages.navigate(route);
					}}
					onClose={() => nav.popModal()}
				/>
			)}
			{nav.modal() === "help" && (
				<HelpModal
					title="Keybindings"
					offset={helpOffset()}
					lines={helpLines()}
				/>
			)}
			{/* The shared profile/preset editor, owned by Settings (task 2.1). */}
			{settingsAgentEditor() && props.dashboard && (
				<SettingsAgentEditor
					keymap={props.dashboard.keymap}
					{...(settingsAgentRepository()
						? { repository: settingsAgentRepository() }
						: {})}
					onClose={() => setSettingsAgentEditor(false)}
				/>
			)}
			{/* Contextual workflow creation: one form for a configured project
			    (application/library page) or independent Wiki work. */}
			{nav.modal() === "new-workflow" && launchContext() && (
				<NewWorkflowModal
					context={launchContext() as WorkflowLaunchContext}
					presetsForRepository={listPresetNames}
					onKeyReady={(handler) => setLaunchHandler(() => handler)}
					onCancel={closeLaunch}
					onComplete={submitLaunch}
				/>
			)}
			{/* Shared portaled modals (e.g. the theme picker) publish a modal-help
			    catalog; paint it at the shell root so `?` is not a dead key. */}
			<ModalHelpOverlay zIndex={30} />
		</box>
	);
}
