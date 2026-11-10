// v1's DevEnvClient facade, ported for the restored environments TUI. Every
// method routes to a `DevEnvBackend`: v2 answers what its authenticated native
// gateway supports and rejects the rest with a visible "not available" error,
// which the v1 error dialog shows. No HTTP, no v1 server, no v1 import.

import type * as T from "../types/index.ts";
import type {
	ActionDefinition,
	ActionDefinitionList,
	App,
	AppStatus,
	ContainerStats,
	CRVersion,
	CreateAppRequest,
	DockerInfo,
	GitInfo,
	InfraService,
	Provider,
	ProviderCreateRequest,
	ProviderUpdateRequest,
	RepoSearchResult,
	ServerEvent,
} from "../types/index.ts";
import type { DomainEventMessage } from "./domain-events-client.ts";
import type { AppSlot } from "./environment-client.ts";
import type { StagesStatusResponse } from "./stages-client.ts";

export interface ActionRegistryStatus {
	version: number;
	actionsCount: number;
	error: string;
	available: boolean;
}
export type ActionHistoryScope = "recent" | "older" | "all";
export interface StartAppResponse {
	missingEnvVars?: string[];
}

/** One generic dispatch: the method name and its v1 arguments. The facade
 * keeps v1's typed signatures; the backend answers each with the value that
 * signature names (a Promise, or an AsyncGenerator for the two streams). */
export interface DevEnvBackend {
	call(method: DevEnvMethod, ...args: unknown[]): never;
}

export type DevEnvMethod =
	| "addIssueComment"
	| "addScriptArgsHistory"
	| "analyzeLogsWithAI"
	| "analyzeLogsWithAIStream"
	| "approveChangeRequest"
	| "buildApp"
	| "cancelAction"
	| "cancelJob"
	| "closeIssue"
	| "createApp"
	| "createCRComment"
	| "createExampleConfig"
	| "createKubernetesCluster"
	| "createProvider"
	| "createScript"
	| "createShellActionScript"
	| "createWorktree"
	| "deleteApp"
	| "deleteKubernetesCluster"
	| "deleteProvider"
	| "deleteScript"
	| "executeScript"
	| "exportKubernetesKubeconfig"
	| "getActionDefinition"
	| "getActionDefinitions"
	| "getActionHistory"
	| "getActionLogs"
	| "getActionRegistryStatus"
	| "getActionTargets"
	| "getAppSlots"
	| "getApps"
	| "getBranches"
	| "getCRDiscussions"
	| "getCRLinkedIssues"
	| "getCRVersions"
	| "getChangeRequest"
	| "getChangeRequestChanges"
	| "getChangeRequests"
	| "getContainerLogs"
	| "getDockerInfo"
	| "getGitInfo"
	| "getInfraServiceLogs"
	| "getInfraServices"
	| "getIssue"
	| "getIssueComments"
	| "getIssueLinkedCRs"
	| "getIssueReferencedIssues"
	| "getIssues"
	| "getJobLogs"
	| "getKubernetesClusterStatus"
	| "getKubernetesLogs"
	| "getPiSessions"
	| "getPipelineJobs"
	| "getProfiles"
	| "getProjectCatalog"
	| "getProvider"
	| "getProviders"
	| "getRepoBranches"
	| "getRepoCollaborators"
	| "getRepoLabels"
	| "getScriptArgsHistory"
	| "getScriptMetadata"
	| "getScripts"
	| "getStages"
	| "getStatus"
	| "getTestSummary"
	| "gitCheckout"
	| "gitCreateBranch"
	| "gitFetch"
	| "gitPull"
	| "gitPush"
	| "health"
	| "linkScript"
	| "listWorktrees"
	| "rebaseCR"
	| "recreateKubernetesCluster"
	| "refreshKubernetesCluster"
	| "releaseApp"
	| "removeIssueAssignee"
	| "removeWorktree"
	| "reopenIssue"
	| "replyToDiscussion"
	| "reportActionEvent"
	| "resolveDiscussion"
	| "restartContainer"
	| "retryJob"
	| "runApp"
	| "searchRepos"
	| "setIssueAssignee"
	| "setIssueLabels"
	| "startActionRun"
	| "startApp"
	| "startContainer"
	| "stopApp"
	| "stopContainer"
	| "streamContainerLogs"
	| "streamContainerStats"
	| "streamJobLogs"
	| "subscribeDomainEvents"
	| "subscribeToEvents"
	| "switchWorktree"
	| "testApp"
	| "toggleCRApproval"
	| "unapproveChangeRequest"
	| "updateProvider";

export class DevEnvClient {
	constructor(
		private readonly backend: DevEnvBackend,
		readonly baseUrl = "agentic-coding-v2://gateway",
	) {}

	startActionRun(
		actionId: string,
		inputs: Record<string, unknown> = {},
	): Promise<void> {
		return this.backend.call("startActionRun", actionId, inputs);
	}

	getActionDefinitions(
		ident: string,
		kind = "app",
	): Promise<ActionDefinitionList> {
		return this.backend.call("getActionDefinitions", ident, kind);
	}

	getActionDefinition(id: string): Promise<ActionDefinition> {
		return this.backend.call("getActionDefinition", id);
	}

	getActionRegistryStatus(): Promise<ActionRegistryStatus> {
		return this.backend.call("getActionRegistryStatus");
	}

	getApps(): Promise<App[]> {
		return this.backend.call("getApps");
	}
	getProjectCatalog(signal?: AbortSignal): Promise<T.ProjectCatalog> {
		return this.backend.call("getProjectCatalog", signal);
	}
	/** Every configured app's slot: holder, status, waiters and wait times. */
	getAppSlots(): Promise<AppSlot[]> {
		return this.backend.call("getAppSlots");
	}
	/** Developer force release: stop the holder's run and let the queue advance. */
	releaseApp(appIdent: string): Promise<void> {
		return this.backend.call("releaseApp", appIdent);
	}
	/** The bounded domain event stream (`/api/v1/events`). */
	subscribeDomainEvents(
		signal?: AbortSignal,
		cursor?: number,
	): AsyncGenerator<DomainEventMessage> {
		return this.backend.call("subscribeDomainEvents", signal, cursor);
	}
	createExampleConfig(): Promise<void> {
		return this.backend.call("createExampleConfig");
	}
	getScripts(): Promise<T.ScriptListResponse> {
		return this.backend.call("getScripts");
	}
	/** The configured, allow-listed stages (`GET /api/v1/stages`). A picker reads
	 * labels, idents, environments, access markers and application URLs; nothing
	 * here can carry a credential value. */
	getStages(signal?: AbortSignal): Promise<StagesStatusResponse> {
		return this.backend.call("getStages", signal);
	}
	executeScript(
		relativePath: string,
		args: string[] = [],
	): Promise<T.ExecuteScriptResponse> {
		return this.backend.call("executeScript", relativePath, args);
	}
	createScript(targetPath: string): Promise<T.ScriptMutationResponse> {
		return this.backend.call("createScript", targetPath);
	}
	linkScript(
		targetPath: string,
		sourcePath: string,
	): Promise<T.ScriptMutationResponse> {
		return this.backend.call("linkScript", targetPath, sourcePath);
	}
	deleteScript(relativePath: string): Promise<T.ScriptMutationResponse> {
		return this.backend.call("deleteScript", relativePath);
	}
	getScriptArgsHistory(
		relativePath: string,
		limit: number = 50,
	): Promise<T.ScriptArgsHistoryResponse> {
		return this.backend.call("getScriptArgsHistory", relativePath, limit);
	}
	addScriptArgsHistory(
		relativePath: string,
		values: Record<string, string>,
	): Promise<void> {
		return this.backend.call("addScriptArgsHistory", relativePath, values);
	}
	getScriptMetadata(relativePath: string): Promise<T.ScriptMetadataResponse> {
		return this.backend.call("getScriptMetadata", relativePath);
	}
	getInfraServices(): Promise<InfraService[]> {
		return this.backend.call("getInfraServices");
	}
	getInfraServiceLogs(ident: string): Promise<string> {
		return this.backend.call("getInfraServiceLogs", ident);
	}
	getStatus(): Promise<AppStatus[]> {
		return this.backend.call("getStatus");
	}
	getDockerInfo(ident: string): Promise<DockerInfo> {
		return this.backend.call("getDockerInfo", ident);
	}
	getGitInfo(ident: string): Promise<GitInfo> {
		return this.backend.call("getGitInfo", ident);
	}
	getContainerLogs(containerID: string): Promise<string> {
		return this.backend.call("getContainerLogs", containerID);
	}
	streamContainerStats(
		containerID: string,
		signal: AbortSignal,
		onData: (stats: ContainerStats) => void,
		onError?: (err: Error) => void,
	): Promise<void> {
		return this.backend.call(
			"streamContainerStats",
			containerID,
			signal,
			onData,
			onError,
		);
	}
	streamContainerLogs(
		containerID: string,
		signal: AbortSignal,
		onLine: (line: string) => void,
		onError?: (err: Error) => void,
		tail: string = "100",
	): Promise<void> {
		return this.backend.call(
			"streamContainerLogs",
			containerID,
			signal,
			onLine,
			onError,
			tail,
		);
	}
	streamJobLogs(
		appIdent: string,
		jobId: number,
		signal: AbortSignal,
		onLine: (line: string) => void,
		onError?: (err: Error) => void,
	): Promise<void> {
		return this.backend.call(
			"streamJobLogs",
			appIdent,
			jobId,
			signal,
			onLine,
			onError,
		);
	}
	getChangeRequests(
		appIdent: string,
		state: string = "opened",
		scope: "current" | "all" = "current",
		sourceType?: string,
		page: number = 1,
		perPage: number = 50,
		search?: string,
		sort?: string,
		direction?: "asc" | "desc",
		labels?: string[],
		signal?: AbortSignal,
	): Promise<T.ChangeRequestListResult> {
		return this.backend.call(
			"getChangeRequests",
			appIdent,
			state,
			scope,
			sourceType,
			page,
			perPage,
			search,
			sort,
			direction,
			labels,
			signal,
		);
	}
	getIssues(
		appIdent: string,
		scope: T.IssueScope = "all",
		sourceType?: string,
		page: number = 1,
		perPage: number = 50,
		search?: string,
		state?: string,
		sort?: string,
		direction?: "asc" | "desc",
		labels?: string[],
		signal?: AbortSignal,
	): Promise<T.IssueListResult> {
		return this.backend.call(
			"getIssues",
			appIdent,
			scope,
			sourceType,
			page,
			perPage,
			search,
			state,
			sort,
			direction,
			labels,
			signal,
		);
	}
	getIssue(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.Issue> {
		return this.backend.call("getIssue", appIdent, number, sourceType, signal);
	}
	getIssueComments(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.IssueCommentListResult> {
		return this.backend.call(
			"getIssueComments",
			appIdent,
			number,
			sourceType,
			signal,
		);
	}

	// ─── Issue Mutations ───────────────────────────────────────────────────

	closeIssue(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		reason?: string,
	): Promise<T.Issue> {
		return this.backend.call(
			"closeIssue",
			appIdent,
			number,
			sourceType,
			reason,
		);
	}

	reopenIssue(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
	): Promise<T.Issue> {
		return this.backend.call("reopenIssue", appIdent, number, sourceType);
	}

	setIssueLabels(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		labels: string[],
	): Promise<T.Issue> {
		return this.backend.call(
			"setIssueLabels",
			appIdent,
			number,
			sourceType,
			labels,
		);
	}

	setIssueAssignee(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		assignee: string,
	): Promise<T.Issue> {
		return this.backend.call(
			"setIssueAssignee",
			appIdent,
			number,
			sourceType,
			assignee,
		);
	}

	removeIssueAssignee(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
	): Promise<T.Issue> {
		return this.backend.call(
			"removeIssueAssignee",
			appIdent,
			number,
			sourceType,
		);
	}

	addIssueComment(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		body: string,
	): Promise<T.IssueComment> {
		return this.backend.call(
			"addIssueComment",
			appIdent,
			number,
			sourceType,
			body,
		);
	}

	getRepoLabels(
		appIdent: string,
		sourceType: string | undefined,
	): Promise<string[]> {
		return this.backend.call("getRepoLabels", appIdent, sourceType);
	}

	getRepoCollaborators(
		appIdent: string,
		sourceType: string | undefined,
	): Promise<string[]> {
		return this.backend.call("getRepoCollaborators", appIdent, sourceType);
	}

	getIssueLinkedCRs(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.ChangeRequest[]> {
		return this.backend.call(
			"getIssueLinkedCRs",
			appIdent,
			number,
			sourceType,
			signal,
		);
	}

	getIssueReferencedIssues(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.Issue[]> {
		return this.backend.call(
			"getIssueReferencedIssues",
			appIdent,
			number,
			sourceType,
			signal,
		);
	}

	getCRLinkedIssues(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.Issue[]> {
		return this.backend.call(
			"getCRLinkedIssues",
			appIdent,
			number,
			sourceType,
			signal,
		);
	}
	getPipelineJobs(
		appIdent: string,
		pipelineId: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.Job[]> {
		return this.backend.call(
			"getPipelineJobs",
			appIdent,
			pipelineId,
			sourceType,
			signal,
		);
	}
	getTestSummary(
		appIdent: string,
		pipelineId: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.TestSummary> {
		return this.backend.call(
			"getTestSummary",
			appIdent,
			pipelineId,
			sourceType,
			signal,
		);
	}
	getChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.ChangeRequest> {
		return this.backend.call(
			"getChangeRequest",
			appIdent,
			crIID,
			sourceType,
			signal,
		);
	}
	getChangeRequestChanges(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.ChangeRequestChange[]> {
		return this.backend.call(
			"getChangeRequestChanges",
			appIdent,
			crIID,
			sourceType,
			signal,
		);
	}
	getCRVersions(appIdent: string, crIID: number): Promise<CRVersion[]> {
		return this.backend.call("getCRVersions", appIdent, crIID);
	}
	createCRComment(
		appIdent: string,
		crIID: number,
		body: string,
		position?: {
			baseSHA: string;
			headSHA: string;
			startSHA: string;
			positionType: string;
			newPath: string;
			oldPath: string;
			newLine?: number;
			oldLine?: number;
			lineCode?: string;
			lineRange?: {
				start: { type: string; oldLine?: number; newLine?: number };
				end: { type: string; oldLine?: number; newLine?: number };
			};
		},
	): Promise<{ status: string; message: string }> {
		return this.backend.call(
			"createCRComment",
			appIdent,
			crIID,
			body,
			position,
		);
	}
	getCRDiscussions(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<T.Discussion[]> {
		return this.backend.call(
			"getCRDiscussions",
			appIdent,
			crIID,
			sourceType,
			signal,
		);
	}
	toggleCRApproval(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return this.backend.call("toggleCRApproval", appIdent, crIID, sourceType);
	}
	approveChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return this.backend.call(
			"approveChangeRequest",
			appIdent,
			crIID,
			sourceType,
		);
	}
	unapproveChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return this.backend.call(
			"unapproveChangeRequest",
			appIdent,
			crIID,
			sourceType,
		);
	}
	rebaseCR(appIdent: string, crIID: number): Promise<void> {
		return this.backend.call("rebaseCR", appIdent, crIID);
	}
	resolveDiscussion(
		appIdent: string,
		crIID: number,
		discussionID: string,
		resolveAction: "resolve" | "unresolve",
	): Promise<{ status: string; message: string }> {
		return this.backend.call(
			"resolveDiscussion",
			appIdent,
			crIID,
			discussionID,
			resolveAction,
		);
	}
	replyToDiscussion(
		appIdent: string,
		crIID: number,
		discussionID: string,
		body: string,
	): Promise<{ status: string; message: string }> {
		return this.backend.call(
			"replyToDiscussion",
			appIdent,
			crIID,
			discussionID,
			body,
		);
	}
	getJobLogs(
		appIdent: string,
		jobId: number,
		sourceType?: string,
	): Promise<string> {
		return this.backend.call("getJobLogs", appIdent, jobId, sourceType);
	}
	analyzeLogsWithAI(logs: string, prompt?: string): Promise<string> {
		return this.backend.call("analyzeLogsWithAI", logs, prompt);
	}
	analyzeLogsWithAIStream(
		logs: string,
		prompt?: string,
		onSessionId?: (sessionId: string) => void,
	): AsyncGenerator<string> {
		return this.backend.call(
			"analyzeLogsWithAIStream",
			logs,
			prompt,
			onSessionId,
		);
	}
	searchRepos(
		provider: string,
		query: string,
		host?: string,
		signal?: AbortSignal,
	): Promise<RepoSearchResult[]> {
		return this.backend.call("searchRepos", provider, query, host, signal);
	}
	getRepoBranches(url: string, provider?: string): Promise<string[]> {
		return this.backend.call("getRepoBranches", url, provider);
	}
	createApp(request: CreateAppRequest): Promise<App> {
		return this.backend.call("createApp", request);
	}
	deleteApp(ident: string): Promise<void> {
		return this.backend.call("deleteApp", ident);
	}
	getProviders(): Promise<Provider[]> {
		return this.backend.call("getProviders");
	}
	getProvider(name: string): Promise<Provider> {
		return this.backend.call("getProvider", name);
	}
	createProvider(provider: ProviderCreateRequest): Promise<Provider> {
		return this.backend.call("createProvider", provider);
	}
	updateProvider(
		name: string,
		updates: ProviderUpdateRequest,
	): Promise<Provider> {
		return this.backend.call("updateProvider", name, updates);
	}
	deleteProvider(name: string): Promise<void> {
		return this.backend.call("deleteProvider", name);
	}
	startApp(
		appIdent: string,
		profile: string = "",
		targetId?: string,
	): Promise<StartAppResponse> {
		return this.backend.call("startApp", appIdent, profile, targetId);
	}
	createShellActionScript(
		request: T.ShellActionScriptRequest,
	): Promise<T.ShellActionScriptResponse> {
		return this.backend.call("createShellActionScript", request);
	}
	getKubernetesLogs(appIdent: string): Promise<string> {
		return this.backend.call("getKubernetesLogs", appIdent);
	}
	getKubernetesClusterStatus(): Promise<T.KubernetesClusterStatus> {
		return this.backend.call("getKubernetesClusterStatus");
	}
	createKubernetesCluster(): Promise<T.KubernetesClusterStatus | undefined> {
		return this.backend.call("createKubernetesCluster");
	}
	deleteKubernetesCluster(): Promise<T.KubernetesClusterStatus | undefined> {
		return this.backend.call("deleteKubernetesCluster");
	}
	recreateKubernetesCluster(): Promise<T.KubernetesClusterStatus | undefined> {
		return this.backend.call("recreateKubernetesCluster");
	}
	exportKubernetesKubeconfig(): Promise<void> {
		return this.backend.call("exportKubernetesKubeconfig");
	}
	refreshKubernetesCluster(): Promise<T.KubernetesClusterStatus> {
		return this.backend.call("refreshKubernetesCluster");
	}
	getProfiles(
		appIdent: string,
	): Promise<{ profiles: string[]; hasDockerfile: boolean }> {
		return this.backend.call("getProfiles", appIdent);
	}
	getActionTargets(
		appIdent: string,
		action: T.AppAction,
	): Promise<T.ActionTarget[]> {
		return this.backend.call("getActionTargets", appIdent, action);
	}
	testApp(
		appIdent: string,
		targetId?: string,
		profile?: string,
		targetLabel?: string,
	): Promise<void> {
		return this.backend.call(
			"testApp",
			appIdent,
			targetId,
			profile,
			targetLabel,
		);
	}
	runApp(
		appIdent: string,
		profile: string = "",
		targetId?: string,
		targetLabel?: string,
	): Promise<void> {
		return this.backend.call(
			"runApp",
			appIdent,
			profile,
			targetId,
			targetLabel,
		);
	}
	stopApp(appIdent: string, targetId?: string): Promise<void> {
		return this.backend.call("stopApp", appIdent, targetId);
	}
	startContainer(containerID: string): Promise<void> {
		return this.backend.call("startContainer", containerID);
	}
	stopContainer(containerID: string, appIdent?: string): Promise<void> {
		return this.backend.call("stopContainer", containerID, appIdent);
	}
	restartContainer(containerID: string, appIdent?: string): Promise<void> {
		return this.backend.call("restartContainer", containerID, appIdent);
	}
	gitPull(appIdent: string): Promise<void> {
		return this.backend.call("gitPull", appIdent);
	}
	gitPush(appIdent: string): Promise<void> {
		return this.backend.call("gitPush", appIdent);
	}
	gitFetch(appIdent: string): Promise<void> {
		return this.backend.call("gitFetch", appIdent);
	}
	getBranches(appIdent: string): Promise<{
		appIdent: string;
		currentBranch: string;
		localBranches: string[];
		remoteBranches: string[];
	}> {
		return this.backend.call("getBranches", appIdent);
	}
	gitCheckout(appIdent: string, branch: string): Promise<void> {
		return this.backend.call("gitCheckout", appIdent, branch);
	}
	listWorktrees(appIdent: string): Promise<T.WorktreeInfo[]> {
		return this.backend.call("listWorktrees", appIdent);
	}
	removeWorktree(appIdent: string, branch: string): Promise<void> {
		return this.backend.call("removeWorktree", appIdent, branch);
	}
	createWorktree(appIdent: string, branch: string): Promise<void> {
		return this.backend.call("createWorktree", appIdent, branch);
	}
	switchWorktree(appIdent: string, branch: string): Promise<void> {
		return this.backend.call("switchWorktree", appIdent, branch);
	}
	gitCreateBranch(appIdent: string, branchName: string): Promise<void> {
		return this.backend.call("gitCreateBranch", appIdent, branchName);
	}
	cancelAction(appIdent: string): Promise<void> {
		return this.backend.call("cancelAction", appIdent);
	}
	buildApp(
		appIdent: string,
		targetId?: string,
		profile?: string,
		targetLabel?: string,
	): Promise<void> {
		return this.backend.call(
			"buildApp",
			appIdent,
			targetId,
			profile,
			targetLabel,
		);
	}
	retryJob(appIdent: string, jobId: number): Promise<void> {
		return this.backend.call("retryJob", appIdent, jobId);
	}
	cancelJob(appIdent: string, jobId: number): Promise<void> {
		return this.backend.call("cancelJob", appIdent, jobId);
	}
	reportActionEvent(
		type: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		return this.backend.call("reportActionEvent", type, properties);
	}
	getActionHistory(
		scope?: ActionHistoryScope,
		limit?: number,
	): Promise<ServerEvent[]> {
		return this.backend.call("getActionHistory", scope, limit);
	}
	getActionLogs(runId: string, stepId?: string): Promise<ServerEvent[]> {
		return this.backend.call("getActionLogs", runId, stepId);
	}
	subscribeToEvents(signal?: AbortSignal): AsyncGenerator<ServerEvent> {
		return this.backend.call("subscribeToEvents", signal);
	}
	health(): Promise<boolean> {
		return this.backend.call("health");
	}
	getPiSessions(): Promise<T.AgentGroup[]> {
		return this.backend.call("getPiSessions");
	}
}
