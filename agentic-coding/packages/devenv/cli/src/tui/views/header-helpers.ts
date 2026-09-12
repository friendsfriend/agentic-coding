import type { App, InfraService } from "@devenv/types";
import { runtimeState, uiColors } from "@devenv/ui";
import type { HelpActions } from "../actions";
import type {
	AppDetailStore,
	AppStore,
	ChangeRequestStore,
	IssueStore,
} from "../stores";

export type TabType =
	| "applications"
	| "infrastructure"
	| "libraries"
	| "scripts"
	| "kubernetes"
	| "ui-test";

export const getTabName = (tab: TabType): string => {
	switch (tab) {
		case "applications":
			return "Applications";
		case "infrastructure":
			return "Infrastructure";
		case "libraries":
			return "Libraries";
		case "scripts":
			return "Tasks";
		case "kubernetes":
			return "Kubernetes";
		case "ui-test":
			return "UI Test";
	}
};

function hasRunningAppInTab(tab: TabType, appStore: AppStore): boolean {
	const allApps = appStore.apps();
	if (tab === "scripts" || tab === "ui-test") return false;
	if (tab === "kubernetes")
		return appStore.kubernetesClusterStatus()?.state === "running";

	const appsInTab: (App | InfraService)[] =
		tab === "applications"
			? allApps.filter((app) => app.appType === "APP")
			: tab === "libraries"
				? allApps.filter((app) => app.appType === "LIB")
				: appStore.infraServices();

	return appsInTab.some(
		(app) =>
			runtimeState(app.runtimeStatus, app.status || app.dockerInfo?.Status) ===
			"running",
	);
}

export function getTabBorderColor(tab: TabType, appStore: AppStore): string {
	return hasRunningAppInTab(tab, appStore)
		? uiColors.success
		: uiColors.primary;
}

export interface HeaderInfo {
	title: string;
	context?: string;
	detail?: string;
	details?: Array<Record<string, string | number | undefined | null>>;
	right?: string;
	severity?: "normal" | "success" | "warning" | "error";
}

interface HeaderSubtitleDeps {
	appStore: AppStore;
	issueStore: IssueStore;
	changeRequestStore: ChangeRequestStore;
	appDetailStore: AppDetailStore;
	helpActions: HelpActions;
	getSelectedApp: () => App | undefined;
}

const headerText = (value: unknown, _max?: number): string =>
	String(value ?? "");

const appDetails = (app: App | undefined): Array<Record<string, string>> => {
	const details: Array<Record<string, string>> = [];
	const id = app?.dockerInfo?.ContainerID;
	if (id) details.push({ containerId: id.slice(0, 12) });
	if (app?.localDirectoryPath) details.push({ path: app.localDirectoryPath });
	return details;
};

export function getHeaderInfo(deps: HeaderSubtitleDeps): HeaderInfo {
	const {
		appStore,
		issueStore,
		changeRequestStore,
		appDetailStore,
		helpActions,
		getSelectedApp,
	} = deps;
	const view = appStore.viewMode();
	const selectedApp = getSelectedApp();
	const live = appStore.liveUpdatesActive() ? "live" : "paused";
	const branch = selectedApp?.branch ? ` · ${selectedApp.branch}` : "";
	const crLabel = (): string => {
		const cr = changeRequestStore.selectedChangeRequest();
		return cr ? `CR !${cr.iid}` : "";
	};

	if (appStore.loading()) {
		return {
			title: "Starting",
			context: appStore.startupState().message,
			right: live,
		};
	}
	if (appStore.error()) {
		return {
			title: "Error",
			context: headerText(appStore.error(), 90),
			right: "? help",
			severity: "error",
		};
	}
	if (view === "table") {
		const search = appStore.tableSearchQuery();
		return {
			title: getTabName(appStore.activeTab()),
			details: search ? [{ search }] : appDetails(selectedApp),
			right: live,
		};
	}
	if (view === "help") {
		const helpData = helpActions.getHelpContent(appStore.helpAllContexts());
		return {
			title: "Help",
			context: appStore.helpActiveTab(),
			detail: helpData.title,
			right: appStore.helpSearchQuery()
				? `Search: ${appStore.helpSearchQuery()}`
				: "? close",
		};
	}
	if (view === "providers") {
		return {
			title: "Providers",
			context: "configured providers",
			detail: "add/edit/delete provider connections",
		};
	}
	if (view === "jobs") {
		const failed = changeRequestStore
			.jobs()
			.filter((j) => j.status === "failed").length;
		const running = changeRequestStore
			.jobs()
			.filter((j) => j.status === "running").length;
		return {
			title: `Pipeline #${changeRequestStore.currentPipelineId() || "N/A"}`,
			context: `${changeRequestStore.jobs().length} jobs · ${running} running · ${failed} failed`,
			detail: headerText(selectedApp?.displayName),
			severity: failed ? "error" : running ? "warning" : "normal",
		};
	}
	if (view === "issues") {
		return {
			title: "Issues",
			context: `${issueStore.issueListFilters().scope?.[0] ?? "all"} · page ${issueStore.currentPage()}/${issueStore.totalPages() || 1}`,
			detail: issueStore.issueSearchQuery()
				? `Search: "${issueStore.issueSearchQuery()}"`
				: headerText(`${selectedApp?.displayName ?? "All apps"}${branch}`),
			right: `${issueStore.totalCount()} total`,
		};
	}
	if (view === "issueDetail") {
		const issue = issueStore.selectedIssue();
		const issueReference = (issue as { reference?: string } | null)?.reference;
		return issue
			? {
					title: issueReference ?? `#${issue.iid}`,
					context: headerText(issue.title),
					detail: `comments: ${issueStore.issueComments().length} · linked CRs: ${issueStore.linkedChangeRequests().length} · refs: ${issueStore.references().length}`,
					right: issue.state ?? "",
				}
			: { title: "Issue detail" };
	}
	if (view === "changeRequests") {
		return {
			title: "Change requests",
			context: `${selectedApp?.displayName ?? "All apps"}${branch}`,
			detail: changeRequestStore.crSearchQuery()
				? `Search: "${changeRequestStore.crSearchQuery()}"`
				: `page ${changeRequestStore.currentPage()}/${changeRequestStore.totalPages() || 1}`,
			right: `${changeRequestStore.totalCount()} total`,
		};
	}
	if (view === "changeRequestDetail") {
		const cr = changeRequestStore.selectedChangeRequest();
		return cr
			? {
					title: `CR !${cr.iid}`,
					context: headerText(cr.title),
					detail: `changes: ${changeRequestStore.crChanges().length} · discussions: ${changeRequestStore.crDiscussions().length} · jobs: ${changeRequestStore.crJobsForDetail().length}`,
					right: cr.state ?? "",
				}
			: { title: "Change request" };
	}
	if (view === "changedFiles") {
		const files = changeRequestStore.changedFilesFiltered();
		const file = files[changeRequestStore.selectedChangedFileIndex()];
		return {
			title: "Changed files",
			context: `${files.length} files`,
			detail: changeRequestStore.changedFilesSearchQuery()
				? `Search: "${changeRequestStore.changedFilesSearchQuery()}"`
				: headerText(file?.new_path ?? file?.old_path ?? "No file"),
			right: crLabel(),
		};
	}
	if (view === "discussionsView") {
		return {
			title: "Discussions",
			context: `${changeRequestStore.crDiscussions().length} threads`,
			detail: changeRequestStore.discussionsShowOnlyComments()
				? "comments only"
				: "all discussions",
			right: crLabel(),
		};
	}
	if (view === "testResults") {
		const test = changeRequestStore.selectedTestForDetail();
		return {
			title: "Test results",
			context: changeRequestStore.crTestSummary() ? "loaded" : "no summary",
			detail: headerText(test?.name ?? test?.classname ?? "No test selected"),
			right: crLabel(),
		};
	}
	if (view === "appDetail") {
		const app = appDetailStore.appDetailApp();
		return {
			title: "Repository detail",
			context: headerText(
				`${app?.displayName ?? "Unknown"}${app?.branch ? ` · ${app.branch}` : ""}`,
			),
			detail: `CRs: ${appDetailStore.appDetailChangeRequests().length} · logs: ${appDetailStore.appDetailLogs().length}`,
			details: appDetails(app),
		};
	}
	if (view === "changeRequestLinkedIssues")
		return {
			title: "CR linked issues",
			context: `${changeRequestStore.changeRequestLinkedIssues().length} items`,
			detail: headerText(changeRequestStore.selectedChangeRequest()?.title),
		};
	if (view === "references")
		return {
			title: "References",
			context: `${issueStore.references().length} items`,
			detail: headerText(issueStore.selectedIssue()?.title),
		};
	if (view === "agentView")
		return {
			title: "Pi sessions",
			context: "sessions",
			detail: "launch or resume pi",
		};
	if (view === "sshPicker")
		return { title: "SSH hosts", context: "connect", detail: "select host" };
	return {
		title: getTabName(appStore.activeTab()),
		detail: headerText(
			`${selectedApp?.displayName ?? "No selection"}${branch}`,
		),
		right: live,
	};
}

function _getHeaderSubtitle(deps: HeaderSubtitleDeps): string {
	const {
		appStore,
		issueStore,
		changeRequestStore,
		appDetailStore,
		helpActions,
		getSelectedApp,
	} = deps;

	if (appStore.viewMode() === "help") {
		const helpData = helpActions.getHelpContent();
		return `Help: ${helpData.title}`;
	}
	if (appStore.viewMode() === "providers") {
		return "Providers";
	}
	if (appStore.viewMode() === "jobs") {
		const app = getSelectedApp();
		return `Pipeline Jobs: ${app?.displayName || "Unknown"} (#${changeRequestStore.currentPipelineId() || "N/A"})`;
	}
	if (appStore.viewMode() === "issues") {
		const app = appStore.filteredApps()[appStore.selectedIndex()];
		return `Issues: ${app?.displayName || "Unknown"} (${issueStore.issueListFilters().scope?.[0] ?? "all"})`;
	}
	if (appStore.viewMode() === "issueDetail") {
		const issue = issueStore.selectedIssue();
		return issue ? `Issue #${issue.iid}: ${issue.title}` : "Issue Detail";
	}
	if (appStore.viewMode() === "issueScopePicker") {
		return "Select Issue Scope";
	}
	if (appStore.viewMode() === "changeRequestDetail") {
		const cr = changeRequestStore.selectedChangeRequest();
		return cr ? `CR !${cr.iid}: ${cr.title}` : "Change Request Detail";
	}
	if (appStore.viewMode() === "changeRequests") {
		const app = appStore.filteredApps()[appStore.selectedIndex()];
		return `Change Request: ${app?.displayName || "Unknown"} (${app?.branch || "unknown"})`;
	}
	if (appStore.viewMode() === "appDetail") {
		const app = appDetailStore.appDetailApp();
		return `Details: ${app?.displayName || "Unknown"}`;
	}
	// Show active tab name in table view
	return getTabName(appStore.activeTab());
}
