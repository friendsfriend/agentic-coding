import type { App } from "@devenv/types";
import type {
	AgentActions,
	AppActions,
	CrActions,
	DockerActions,
	GitActions,
	HelpActions,
	IssueActions,
	LogActions,
	PipelineActions,
	ProviderActions,
	UtilActions,
} from "../actions";
import type {
	ActionRunStore,
	AgentStore,
	AppDetailStore,
	AppStore,
	ChangeRequestStore,
	IssueStore,
	LogStore,
	ProviderStore,
	UiStore,
} from "../stores";

export interface KeyboardEvent {
	name?: string;
	sequence?: string;
	ctrl?: boolean;
	shift?: boolean;
	meta?: boolean;
	super?: boolean;
	raw?: string;
}

/** All stores bundled for dispatcher access */
export interface KeyboardStores {
	appStore: AppStore;
	issueStore: IssueStore;
	logStore: LogStore;
	changeRequestStore: ChangeRequestStore;
	providerStore: ProviderStore;
	uiStore: UiStore;
	agentStore: AgentStore;
	appDetailStore: AppDetailStore;
	actionRunStore: ActionRunStore;
}

/** All actions bundled for dispatcher access */
export interface KeyboardActions {
	appActions: AppActions;
	issueActions: IssueActions;
	logActions: LogActions;
	crActions: CrActions;
	dockerActions: DockerActions;
	gitActions: GitActions;
	providerActions: ProviderActions;
	agentActions: AgentActions;
	utilActions: UtilActions;
	pipelineActions: PipelineActions;
	helpActions: HelpActions;
}

/** Extra context that dispatchers may need beyond stores/actions */
export interface KeyboardContext {
	renderer: ReturnType<typeof import("@opentui/solid").useRenderer>;
	client: ReturnType<typeof import("@devenv/core").createClient>;
	getSelectedApp: () => App | undefined;
	launchPi: (sessionPath: string | null) => void;
	getSelectableRows: typeof import("@ui").getSelectableRows;
	showError: UiStore["showError"];
	/** Embedded in the unified shell: the shell owns process shutdown, so the
	 * imported app must not bind q/Ctrl+C to its own exit path. */
	embedded?: boolean;
	/** Active shell feature predicate used by embedded keymap layers. */
	active?: () => boolean;
	/**
	 * Contextual workflow launch (launch-workflows-from-project-and-wiki-pages,
	 * task 1.3): the unified shell owns the creation form and the start
	 * boundary, so the environment feature only reports the selected project's
	 * canonical identity. Absent when the environment runs standalone, in which
	 * case no start-workflow action is advertised.
	 */
	startWorkflow?: (target: EnvironmentLaunchTarget) => void;
}

/** Canonical identity of the configured application/library a launch targets. */
export interface EnvironmentLaunchTarget {
	/** Stable configured project identity (environment `App.ident`). */
	ident: string;
	name: string;
	repository: string;
}
