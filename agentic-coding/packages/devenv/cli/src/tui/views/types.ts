import type { TableColumn } from "@ui";
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
} from "../actions/index.ts";
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
} from "../stores/index.ts";

export interface ViewStores {
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

export interface ViewActions {
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

export interface ContentRouterProps {
	stores: ViewStores;
	actions: ViewActions;
	columns: TableColumn[];
	scriptColumns: TableColumn[];
	dimensions: { width: number; height: number };
	/**
	 * Chrome rows the host renders around this body. Standalone `devenv` renders
	 * its own header/footer ({@link LAYOUT_CHROME_LINES}); the embedded feature
	 * body renders none and reserves the shell's chrome height instead.
	 */
	chromeLines?: number;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
	getTabBorderColor: (
		tab:
			| "applications"
			| "infrastructure"
			| "libraries"
			| "scripts"
			| "kubernetes"
			| "ui-test",
	) => string;
	active?: () => boolean;
}

export interface ModalOverlaysProps {
	stores: ViewStores;
	actions: ViewActions;
	dimensions: { width: number; height: number };
}
