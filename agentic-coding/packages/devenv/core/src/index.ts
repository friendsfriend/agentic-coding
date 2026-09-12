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
} from "@devenv/types";
import { getPiSessions } from "./agent-client";
import {
	createApp,
	deleteApp,
	getActionDefinition,
	getActionDefinitions,
	getActionRegistryStatus,
	getApps,
	getDockerInfo,
	getGitInfo,
	getInfraServiceLogs,
	getInfraServices,
	getProfiles,
	getStatus,
	startActionRun,
} from "./apps-client";
import {
	cancelJob,
	getJobLogs,
	getPipelineJobs,
	getTestSummary,
	retryJob,
	streamJobLogs,
} from "./ci-client";
import type { ClientDeps, FetchFunction } from "./client-types";
import {
	approveChangeRequest,
	createCRComment,
	getChangeRequest,
	getChangeRequestChanges,
	getChangeRequests,
	getCRDiscussions,
	getCRVersions,
	rebaseCR,
	replyToDiscussion,
	resolveDiscussion,
	toggleCRApproval,
	unapproveChangeRequest,
} from "./cr-client";
import { createCustomFetch, createCustomFetchWithSSE } from "./custom-fetch";
import {
	buildApp,
	cancelAction,
	createKubernetesCluster,
	createShellActionScript,
	deleteKubernetesCluster,
	exportKubernetesKubeconfig,
	getActionTargets,
	getContainerLogs,
	getKubernetesClusterStatus,
	getKubernetesLogs,
	recreateKubernetesCluster,
	refreshKubernetesCluster,
	restartContainer,
	runApp,
	type StartAppResponse,
	startApp,
	startContainer,
	stopApp,
	stopContainer,
	streamContainerLogs,
	streamContainerStats,
	testApp,
} from "./docker-client";
import {
	getActionHistory,
	getActionLogs,
	health,
	reportActionEvent,
	subscribeToEvents,
} from "./events-client";
import { createExampleConfig } from "./example-config-client";
import {
	createWorktree,
	getBranches,
	gitCheckout,
	gitCreateBranch,
	gitFetch,
	gitPull,
	gitPush,
	listWorktrees,
	removeWorktree,
	switchWorktree,
} from "./git-client";
import {
	addIssueComment,
	closeIssue,
	getCRLinkedIssues,
	getIssue,
	getIssueComments,
	getIssueLinkedCRs,
	getIssueReferencedIssues,
	getIssues,
	getRepoCollaborators,
	getRepoLabels,
	removeIssueAssignee,
	reopenIssue,
	setIssueAssignee,
	setIssueLabels,
} from "./issues-client";
import {
	analyzeCRWithAIStream,
	analyzeLogsWithAI,
	analyzeLogsWithAIStream,
} from "./logs-client";
import {
	createProvider,
	deleteProvider,
	getProvider,
	getProviders,
	updateProvider,
} from "./provider-client";
import { getRepoBranches, searchRepos } from "./repos-client";
import {
	addScriptArgsHistory,
	createScript,
	deleteScript,
	executeScript,
	getScriptArgsHistory,
	getScriptMetadata,
	getScripts,
	linkScript,
} from "./scripts-client";

function createFetch(): FetchFunction {
	console.error(
		"[CLIENT] Using custom Node.js http-based fetch (Bun fetch is broken for localhost)",
	);
	return createCustomFetch() as FetchFunction;
}

export class DevEnvClient {
	private deps: ClientDeps;

	constructor(
		baseUrl = "http://127.0.0.1:4050",
		customFetch?: FetchFunction,
		onError?: (title: string, message: string) => void,
	) {
		this.deps = {
			baseUrl,
			fetchFn: customFetch || createFetch(),
			sseFetchFn: createCustomFetchWithSSE() as FetchFunction,
			onError,
		};
		console.error(
			`[CLIENT] DevEnvClient constructed with baseUrl: ${this.deps.baseUrl}`,
		);
	}

	get baseUrl(): string {
		return this.deps.baseUrl;
	}

	startActionRun(
		actionId: string,
		inputs: Record<string, unknown> = {},
	): Promise<void> {
		return startActionRun(this.deps, actionId, inputs);
	}

	getActionDefinitions(
		ident: string,
		kind = "app",
	): Promise<ActionDefinitionList> {
		return getActionDefinitions(this.deps, ident, kind);
	}

	getActionDefinition(id: string): Promise<ActionDefinition> {
		return getActionDefinition(this.deps, id);
	}

	getActionRegistryStatus(): Promise<
		import("./apps-client").ActionRegistryStatus
	> {
		return getActionRegistryStatus(this.deps);
	}

	getApps(): Promise<App[]> {
		return getApps(this.deps);
	}
	createExampleConfig(): Promise<void> {
		return createExampleConfig(this.deps);
	}
	getScripts(): Promise<import("@devenv/types").ScriptListResponse> {
		return getScripts(this.deps);
	}
	executeScript(
		relativePath: string,
		args: string[] = [],
	): Promise<import("@devenv/types").ExecuteScriptResponse> {
		return executeScript(this.deps, relativePath, args);
	}
	createScript(
		targetPath: string,
	): Promise<import("@devenv/types").ScriptMutationResponse> {
		return createScript(this.deps, targetPath);
	}
	linkScript(
		targetPath: string,
		sourcePath: string,
	): Promise<import("@devenv/types").ScriptMutationResponse> {
		return linkScript(this.deps, targetPath, sourcePath);
	}
	deleteScript(
		relativePath: string,
	): Promise<import("@devenv/types").ScriptMutationResponse> {
		return deleteScript(this.deps, relativePath);
	}
	getScriptArgsHistory(
		relativePath: string,
		limit: number = 50,
	): Promise<import("@devenv/types").ScriptArgsHistoryResponse> {
		return getScriptArgsHistory(this.deps, relativePath, limit);
	}
	addScriptArgsHistory(
		relativePath: string,
		values: Record<string, string>,
	): Promise<void> {
		return addScriptArgsHistory(this.deps, relativePath, values);
	}
	getScriptMetadata(
		relativePath: string,
	): Promise<import("@devenv/types").ScriptMetadataResponse> {
		return getScriptMetadata(this.deps, relativePath);
	}
	getInfraServices(): Promise<InfraService[]> {
		return getInfraServices(this.deps);
	}
	getInfraServiceLogs(ident: string): Promise<string> {
		return getInfraServiceLogs(this.deps, ident);
	}
	getStatus(): Promise<AppStatus[]> {
		return getStatus(this.deps);
	}
	getDockerInfo(ident: string): Promise<DockerInfo> {
		return getDockerInfo(this.deps, ident);
	}
	getGitInfo(ident: string): Promise<GitInfo> {
		return getGitInfo(this.deps, ident);
	}
	getContainerLogs(containerID: string): Promise<string> {
		return getContainerLogs(this.deps, containerID);
	}
	streamContainerStats(
		containerID: string,
		signal: AbortSignal,
		onData: (stats: ContainerStats) => void,
		onError?: (err: Error) => void,
	): Promise<void> {
		return streamContainerStats(
			this.deps,
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
		return streamContainerLogs(
			this.deps,
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
		return streamJobLogs(this.deps, appIdent, jobId, signal, onLine, onError);
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
	): Promise<import("@devenv/types").ChangeRequestListResult> {
		return getChangeRequests(
			this.deps,
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
		scope: import("@devenv/types").IssueScope = "all",
		sourceType?: string,
		page: number = 1,
		perPage: number = 50,
		search?: string,
		state?: string,
		sort?: string,
		direction?: "asc" | "desc",
		labels?: string[],
		signal?: AbortSignal,
	): Promise<import("@devenv/types").IssueListResult> {
		return getIssues(
			this.deps,
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
	): Promise<import("@devenv/types").Issue> {
		return getIssue(this.deps, appIdent, number, sourceType, signal);
	}
	getIssueComments(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").IssueCommentListResult> {
		return getIssueComments(this.deps, appIdent, number, sourceType, signal);
	}

	// ─── Issue Mutations ───────────────────────────────────────────────────

	closeIssue(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		reason?: string,
	): Promise<import("@devenv/types").Issue> {
		return closeIssue(this.deps, appIdent, number, sourceType, reason);
	}

	reopenIssue(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
	): Promise<import("@devenv/types").Issue> {
		return reopenIssue(this.deps, appIdent, number, sourceType);
	}

	setIssueLabels(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		labels: string[],
	): Promise<import("@devenv/types").Issue> {
		return setIssueLabels(this.deps, appIdent, number, sourceType, labels);
	}

	setIssueAssignee(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		assignee: string,
	): Promise<import("@devenv/types").Issue> {
		return setIssueAssignee(this.deps, appIdent, number, sourceType, assignee);
	}

	removeIssueAssignee(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
	): Promise<import("@devenv/types").Issue> {
		return removeIssueAssignee(this.deps, appIdent, number, sourceType);
	}

	addIssueComment(
		appIdent: string,
		number: number,
		sourceType: string | undefined,
		body: string,
	): Promise<import("@devenv/types").IssueComment> {
		return addIssueComment(this.deps, appIdent, number, sourceType, body);
	}

	getRepoLabels(
		appIdent: string,
		sourceType: string | undefined,
	): Promise<string[]> {
		return getRepoLabels(this.deps, appIdent, sourceType);
	}

	getRepoCollaborators(
		appIdent: string,
		sourceType: string | undefined,
	): Promise<string[]> {
		return getRepoCollaborators(this.deps, appIdent, sourceType);
	}

	getIssueLinkedCRs(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").ChangeRequest[]> {
		return getIssueLinkedCRs(this.deps, appIdent, number, sourceType, signal);
	}

	getIssueReferencedIssues(
		appIdent: string,
		number: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").Issue[]> {
		return getIssueReferencedIssues(
			this.deps,
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
	): Promise<import("@devenv/types").Issue[]> {
		return getCRLinkedIssues(this.deps, appIdent, number, sourceType, signal);
	}
	getPipelineJobs(
		appIdent: string,
		pipelineId: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").Job[]> {
		return getPipelineJobs(this.deps, appIdent, pipelineId, sourceType, signal);
	}
	getTestSummary(
		appIdent: string,
		pipelineId: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").TestSummary> {
		return getTestSummary(this.deps, appIdent, pipelineId, sourceType, signal);
	}
	getChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").ChangeRequest> {
		return getChangeRequest(this.deps, appIdent, crIID, sourceType, signal);
	}
	getChangeRequestChanges(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").ChangeRequestChange[]> {
		return getChangeRequestChanges(
			this.deps,
			appIdent,
			crIID,
			sourceType,
			signal,
		);
	}
	getCRVersions(appIdent: string, crIID: number): Promise<CRVersion[]> {
		return getCRVersions(this.deps, appIdent, crIID);
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
		return createCRComment(this.deps, appIdent, crIID, body, position);
	}
	getCRDiscussions(
		appIdent: string,
		crIID: number,
		sourceType?: string,
		signal?: AbortSignal,
	): Promise<import("@devenv/types").Discussion[]> {
		return getCRDiscussions(this.deps, appIdent, crIID, sourceType, signal);
	}
	toggleCRApproval(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return toggleCRApproval(this.deps, appIdent, crIID, sourceType);
	}
	approveChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return approveChangeRequest(this.deps, appIdent, crIID, sourceType);
	}
	unapproveChangeRequest(
		appIdent: string,
		crIID: number,
		sourceType?: string,
	): Promise<void> {
		return unapproveChangeRequest(this.deps, appIdent, crIID, sourceType);
	}
	rebaseCR(appIdent: string, crIID: number): Promise<void> {
		return rebaseCR(this.deps, appIdent, crIID);
	}
	resolveDiscussion(
		appIdent: string,
		crIID: number,
		discussionID: string,
		resolveAction: "resolve" | "unresolve",
	): Promise<{ status: string; message: string }> {
		return resolveDiscussion(
			this.deps,
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
		return replyToDiscussion(this.deps, appIdent, crIID, discussionID, body);
	}
	getJobLogs(
		appIdent: string,
		jobId: number,
		sourceType?: string,
	): Promise<string> {
		return getJobLogs(this.deps, appIdent, jobId, sourceType);
	}
	analyzeLogsWithAI(logs: string, prompt?: string): Promise<string> {
		return analyzeLogsWithAI(this.deps, logs, prompt);
	}
	analyzeLogsWithAIStream(
		logs: string,
		prompt?: string,
		onSessionId?: (sessionId: string) => void,
	): AsyncGenerator<string> {
		return analyzeLogsWithAIStream(this.deps, logs, prompt, onSessionId);
	}
	analyzeCRWithAIStream(
		appIdent: string,
		crIID: number,
		sourceBranch: string,
		targetBranch: string,
		prompt: string,
	): AsyncGenerator<string> {
		return analyzeCRWithAIStream(
			this.deps,
			appIdent,
			crIID,
			sourceBranch,
			targetBranch,
			prompt,
		);
	}
	searchRepos(
		provider: string,
		query: string,
		host?: string,
		signal?: AbortSignal,
	): Promise<RepoSearchResult[]> {
		return searchRepos(this.deps, provider, query, host, signal);
	}
	getRepoBranches(url: string, provider?: string): Promise<string[]> {
		return getRepoBranches(this.deps, url, provider);
	}
	createApp(request: CreateAppRequest): Promise<App> {
		return createApp(this.deps, request);
	}
	deleteApp(ident: string): Promise<void> {
		return deleteApp(this.deps, ident);
	}
	getProviders(): Promise<Provider[]> {
		return getProviders(this.deps);
	}
	getProvider(name: string): Promise<Provider> {
		return getProvider(this.deps, name);
	}
	createProvider(provider: ProviderCreateRequest): Promise<Provider> {
		return createProvider(this.deps, provider);
	}
	updateProvider(
		name: string,
		updates: ProviderUpdateRequest,
	): Promise<Provider> {
		return updateProvider(this.deps, name, updates);
	}
	deleteProvider(name: string): Promise<void> {
		return deleteProvider(this.deps, name);
	}
	startApp(
		appIdent: string,
		profile: string = "",
		targetId?: string,
	): Promise<StartAppResponse> {
		return startApp(this.deps, appIdent, profile, targetId);
	}
	createShellActionScript(
		request: import("@devenv/types").ShellActionScriptRequest,
	): Promise<import("@devenv/types").ShellActionScriptResponse> {
		return createShellActionScript(this.deps, request);
	}
	getKubernetesLogs(appIdent: string): Promise<string> {
		return getKubernetesLogs(this.deps, appIdent);
	}
	getKubernetesClusterStatus(): Promise<
		import("@devenv/types").KubernetesClusterStatus
	> {
		return getKubernetesClusterStatus(this.deps);
	}
	createKubernetesCluster(): Promise<
		import("@devenv/types").KubernetesClusterStatus | undefined
	> {
		return createKubernetesCluster(this.deps);
	}
	deleteKubernetesCluster(): Promise<
		import("@devenv/types").KubernetesClusterStatus | undefined
	> {
		return deleteKubernetesCluster(this.deps);
	}
	recreateKubernetesCluster(): Promise<
		import("@devenv/types").KubernetesClusterStatus | undefined
	> {
		return recreateKubernetesCluster(this.deps);
	}
	exportKubernetesKubeconfig(): Promise<void> {
		return exportKubernetesKubeconfig(this.deps);
	}
	refreshKubernetesCluster(): Promise<
		import("@devenv/types").KubernetesClusterStatus
	> {
		return refreshKubernetesCluster(this.deps);
	}
	getProfiles(
		appIdent: string,
	): Promise<{ profiles: string[]; hasDockerfile: boolean }> {
		return getProfiles(this.deps, appIdent);
	}
	getActionTargets(
		appIdent: string,
		action: import("@devenv/types").AppAction,
	): Promise<import("@devenv/types").ActionTarget[]> {
		return getActionTargets(this.deps, appIdent, action);
	}
	testApp(
		appIdent: string,
		targetId?: string,
		profile?: string,
		targetLabel?: string,
	): Promise<void> {
		return testApp(this.deps, appIdent, targetId, profile, targetLabel);
	}
	runApp(
		appIdent: string,
		profile: string = "",
		targetId?: string,
		targetLabel?: string,
	): Promise<void> {
		return runApp(this.deps, appIdent, profile, targetId, targetLabel);
	}
	stopApp(appIdent: string, targetId?: string): Promise<void> {
		return stopApp(this.deps, appIdent, targetId);
	}
	startContainer(containerID: string): Promise<void> {
		return startContainer(this.deps, containerID);
	}
	stopContainer(containerID: string, appIdent?: string): Promise<void> {
		return stopContainer(this.deps, containerID, appIdent);
	}
	restartContainer(containerID: string, appIdent?: string): Promise<void> {
		return restartContainer(this.deps, containerID, appIdent);
	}
	gitPull(appIdent: string): Promise<void> {
		return gitPull(this.deps, appIdent);
	}
	gitPush(appIdent: string): Promise<void> {
		return gitPush(this.deps, appIdent);
	}
	gitFetch(appIdent: string): Promise<void> {
		return gitFetch(this.deps, appIdent);
	}
	getBranches(appIdent: string): Promise<{
		appIdent: string;
		currentBranch: string;
		localBranches: string[];
		remoteBranches: string[];
	}> {
		return getBranches(this.deps, appIdent);
	}
	gitCheckout(appIdent: string, branch: string): Promise<void> {
		return gitCheckout(this.deps, appIdent, branch);
	}
	listWorktrees(
		appIdent: string,
	): Promise<import("@devenv/types").WorktreeInfo[]> {
		return listWorktrees(this.deps, appIdent);
	}
	removeWorktree(appIdent: string, branch: string): Promise<void> {
		return removeWorktree(this.deps, appIdent, branch);
	}
	createWorktree(appIdent: string, branch: string): Promise<void> {
		return createWorktree(this.deps, appIdent, branch);
	}
	switchWorktree(appIdent: string, branch: string): Promise<void> {
		return switchWorktree(this.deps, appIdent, branch);
	}
	gitCreateBranch(appIdent: string, branchName: string): Promise<void> {
		return gitCreateBranch(this.deps, appIdent, branchName);
	}
	cancelAction(appIdent: string): Promise<void> {
		return cancelAction(this.deps, appIdent);
	}
	buildApp(
		appIdent: string,
		targetId?: string,
		profile?: string,
		targetLabel?: string,
	): Promise<void> {
		return buildApp(this.deps, appIdent, targetId, profile, targetLabel);
	}
	retryJob(appIdent: string, jobId: number): Promise<void> {
		return retryJob(this.deps, appIdent, jobId);
	}
	cancelJob(appIdent: string, jobId: number): Promise<void> {
		return cancelJob(this.deps, appIdent, jobId);
	}
	reportActionEvent(
		type: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		return reportActionEvent(this.deps, type, properties);
	}
	getActionHistory(
		scope?: import("./events-client").ActionHistoryScope,
		limit?: number,
	): Promise<ServerEvent[]> {
		return getActionHistory(this.deps, scope, limit);
	}
	getActionLogs(runId: string, stepId?: string): Promise<ServerEvent[]> {
		return getActionLogs(this.deps, runId, stepId);
	}
	subscribeToEvents(signal?: AbortSignal): AsyncGenerator<ServerEvent> {
		return subscribeToEvents(this.deps, signal);
	}
	health(): Promise<boolean> {
		return health(this.deps);
	}
	getPiSessions(): Promise<import("@devenv/types").AgentGroup[]> {
		return getPiSessions(this.deps);
	}
}

export function createClient(
	baseUrl?: string,
	customFetch?: FetchFunction,
	onError?: (title: string, message: string) => void,
): DevEnvClient {
	return new DevEnvClient(baseUrl, customFetch, onError);
}

export * from "@devenv/types";
export * from "./clipboard";
export * from "./custom-fetch";
export * from "./diff-utils";
export * from "./logger";
export type { FetchFunction };
