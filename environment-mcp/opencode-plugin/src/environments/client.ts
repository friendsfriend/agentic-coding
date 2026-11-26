import type { UiCapabilityApi } from "../../../src/ui/capability-api.ts";
import {
	type EnvironmentService,
	type EnvironmentStatus,
	type ExecutionReceipt,
	type GitActionOutcome,
	type GitActionRequest,
	type GitBranches,
	type GitChanges,
	type GitDiff,
	type GitDiffSide,
	type GitRemotes,
	type GitStatus,
	type GitWorktrees,
	type GitWriteOutcome,
	type GitWriteRequest,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSummary,
	parseConfigurationMutation,
	parseConfigurationRevision,
	parseContainerStats,
	parseExecution,
	parseGitAction,
	parseGitBranches,
	parseGitChanges,
	parseGitDiff,
	parseGitRemotes,
	parseGitStashes,
	parseGitStatuses,
	parseGitTags,
	parseGitWorktrees,
	parseGitWriteOutcome,
	parseHistory,
	parseKubernetesClusters,
	parseKubernetesDescribe,
	parseKubernetesEvents,
	parseKubernetesPodLogs,
	parseKubernetesResources,
	parseList,
	parseLogs,
	parseOperationDetail,
	parseProviderChangeDetail,
	parseProviderChanges,
	parseProviderDiscussions,
	parseProviderFiles,
	parseProviderIssueComments,
	parseProviderIssueDetail,
	parseProviderIssues,
	parseProviderJobLogs,
	parseProviderJobs,
	parseProviderPipelines,
	parseProviderRepositories,
	parseProviderRepositoryMatches,
	parseProviders,
	parseProviderVersions,
	parseProviderWriteOutcome,
	parseProviderWrites,
	parseService,
	parseStatus,
	parseStop,
	parseTelemetry,
	type TelemetrySnapshot,
} from "./model.ts";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export class EnvironmentMcpClient {
	constructor(private readonly api: UiCapabilityApi) {}

	private async invoke(
		name: string,
		input: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return record(await this.api.invoke(name, input));
	}

	async list(): Promise<{
		apps: ReturnType<typeof parseList>["apps"];
		services: readonly EnvironmentService[];
		repositories: readonly string[];
		total: number;
	}> {
		const apps: ReturnType<typeof parseList>["apps"] = [];
		let services: readonly EnvironmentService[] = [];
		let repositories: readonly string[] = [];
		let total = 0;
		let offset = 0;
		for (let page = 0; page < 8; page += 1) {
			const result = parseList(
				await this.invoke("env_list", { offset, limit: 10 }),
			);
			if (page === 0) {
				services = result.services;
				repositories = result.repositories;
				total = result.total;
			}
			apps.push(...result.apps);
			if (result.nextOffset === null || result.nextOffset <= offset) break;
			offset = result.nextOffset;
		}
		return { apps, services, repositories, total };
	}

	async status(): Promise<EnvironmentStatus> {
		return parseStatus(await this.invoke("env_status"));
	}

	async services(): Promise<readonly EnvironmentService[]> {
		const result = await this.invoke("env_services");
		const list = result.services;
		if (!Array.isArray(list)) return [];
		return list.flatMap((item) => {
			const parsed = parseService(item);
			return parsed ? [parsed] : [];
		});
	}

	async history(
		offset = 0,
		limit = 20,
	): Promise<ReturnType<typeof parseHistory>> {
		return parseHistory(await this.invoke("env_history", { offset, limit }));
	}

	async operation(id: string, progressOffset = 0): Promise<OperationDetail> {
		return parseOperationDetail(
			await this.invoke("env_operation", {
				operationId: id,
				...(progressOffset > 0 ? { progressOffset } : {}),
			}),
		);
	}

	async execute(
		app: string,
		target: string,
		worktree?: string,
	): Promise<{
		operation?: OperationSummary;
		receipt: ExecutionReceipt | null;
	}> {
		return parseExecution(
			await this.invoke("env_execute", {
				app,
				target,
				...(worktree ? { worktree } : {}),
				requestId: crypto.randomUUID(),
			}),
		);
	}

	async wait(
		id: string,
		waitSec = 30,
	): Promise<{
		operation?: OperationSummary;
		receipt: ExecutionReceipt | null;
	}> {
		const result = parseExecution(
			await this.invoke("env_wait", { operationId: id, waitSec }),
		);
		return result;
	}

	async gitBranches(repository: string, session = false): Promise<GitBranches> {
		return parseGitBranches(
			await this.invoke("env_git_branches", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async configRevision() {
		return parseConfigurationRevision(
			await this.invoke("env_config_revision", {}),
		);
	}

	private async configMutation(name: string, input: Record<string, unknown>) {
		const result = parseConfigurationMutation(await this.invoke(name, input));
		if (!result) throw new Error("config-invalid");
		return result;
	}

	async appCreate(
		input: {
			id: string;
			kind: "app" | "library" | "infrastructure";
			repository: string;
		},
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_app_create", {
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async appUpdate(
		input: {
			id: string;
			kind?: "app" | "library" | "infrastructure";
			repository?: string;
		},
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_app_update", {
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async appDelete(
		input: { id: string; deleteTargets: boolean },
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_app_delete", {
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async targetDuplicate(
		input: {
			app: string;
			sourceApp: string;
			sourceTarget: string;
			id: string;
			profile?: string;
		},
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_target_create", {
			mode: "duplicate",
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async targetShellCreate(
		input: {
			app: string;
			id: string;
			action: "build" | "test" | "run";
			profile?: string;
			command: string;
			timeoutSec?: number;
		},
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_target_create", {
			mode: "shell",
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async targetUpdate(
		input: {
			app: string;
			id: string;
			profile?: string | null;
			action?: "build" | "test" | "run";
			command?: string;
			timeoutSec?: number;
		},
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_target_update", {
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async targetDelete(
		input: { app: string; id: string },
		expectedDigest?: string,
		confirm?: string,
	) {
		return this.configMutation("env_target_delete", {
			...input,
			...(expectedDigest ? { expectedDigest } : {}),
			...(confirm ? { confirm } : {}),
		});
	}

	async clusters() {
		return parseKubernetesClusters(await this.invoke("env_clusters", {}));
	}

	async clusterResources(cluster: string, namespace: string) {
		return parseKubernetesResources(
			await this.invoke("env_cluster_resources", { cluster, namespace }),
		);
	}

	async clusterEvents(cluster: string, namespace: string) {
		return parseKubernetesEvents(
			await this.invoke("env_cluster_events", { cluster, namespace }),
		);
	}

	async clusterDescribe(
		cluster: string,
		namespace: string,
		kind: string,
		name: string,
	) {
		return parseKubernetesDescribe(
			await this.invoke("env_cluster_describe", {
				cluster,
				namespace,
				kind,
				name,
			}),
		);
	}

	async podLogs(
		cluster: string,
		namespace: string,
		pod: string,
		container?: string,
		tail = 200,
	) {
		return parseKubernetesPodLogs(
			await this.invoke("env_pod_logs", {
				cluster,
				namespace,
				pod,
				...(container ? { container } : {}),
				tail,
			}),
		);
	}

	async containerStats() {
		return parseContainerStats(await this.invoke("env_container_stats", {}));
	}

	async providers() {
		return parseProviders(await this.invoke("env_providers", {}));
	}

	async providerRepository(repository: string, session = false) {
		return parseProviderRepositoryMatches(
			await this.invoke("env_provider_repository", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async providerRepositories(provider: string, query: string) {
		return parseProviderRepositories(
			await this.invoke("env_provider_repos", { provider, query }),
		);
	}

	async providerChanges(
		provider: string,
		repository: string,
		state: "open" | "closed" | "all",
	) {
		return parseProviderChanges(
			await this.invoke("env_provider_changes", {
				provider,
				repository,
				state,
			}),
		);
	}

	async providerIssues(
		provider: string,
		repository: string,
		state: "open" | "closed" | "all",
	) {
		return parseProviderIssues(
			await this.invoke("env_provider_issues", {
				provider,
				repository,
				state,
			}),
		);
	}

	async providerPipelines(provider: string, repository: string) {
		return parseProviderPipelines(
			await this.invoke("env_provider_pipelines", { provider, repository }),
		);
	}

	async providerCommentChange(
		provider: string,
		repository: string,
		number: number,
		body: string,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_comment_change", {
				provider,
				repository,
				number,
				body,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerCommentIssue(
		provider: string,
		repository: string,
		number: number,
		body: string,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_comment_issue", {
				provider,
				repository,
				number,
				body,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerApproveChange(
		provider: string,
		repository: string,
		number: number,
		sha: string,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_approve_change", {
				provider,
				repository,
				number,
				sha,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerMergeChange(
		provider: string,
		repository: string,
		number: number,
		sha: string,
		mergeMethod: "merge" | "squash" | "rebase",
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_merge_change", {
				provider,
				repository,
				number,
				sha,
				mergeMethod,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerSetIssueState(
		provider: string,
		repository: string,
		number: number,
		state: "open" | "closed",
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_set_issue_state", {
				provider,
				repository,
				number,
				state,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerRebaseChange(
		provider: string,
		repository: string,
		number: number,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_rebase_change", {
				provider,
				repository,
				number,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerUnapproveChange(
		provider: string,
		repository: string,
		number: number,
		sha: string,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_unapprove_change", {
				provider,
				repository,
				number,
				sha,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerReplyDiscussion(
		provider: string,
		repository: string,
		number: number,
		scope: "change" | "issue",
		discussionId: string,
		body: string,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_reply_discussion", {
				provider,
				repository,
				number,
				scope,
				discussionId,
				body,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerSetDiscussionResolved(
		provider: string,
		repository: string,
		number: number,
		discussionId: string,
		resolved: boolean,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_set_discussion_resolved", {
				provider,
				repository,
				number,
				discussionId,
				resolved,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerAddLabels(
		provider: string,
		repository: string,
		number: number,
		scope: "change" | "issue",
		labels: readonly string[],
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_add_labels", {
				provider,
				repository,
				number,
				scope,
				labels: [...labels],
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerSetAssignees(
		provider: string,
		repository: string,
		number: number,
		scope: "change" | "issue",
		assignees: readonly string[],
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_set_assignees", {
				provider,
				repository,
				number,
				scope,
				assignees: [...assignees],
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerRetryJob(
		provider: string,
		repository: string,
		job: number,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_retry_job", {
				provider,
				repository,
				job,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerRetryPipeline(
		provider: string,
		repository: string,
		pipeline: number,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_retry_pipeline", {
				provider,
				repository,
				pipeline,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerCancelPipeline(
		provider: string,
		repository: string,
		pipeline: number,
		requestId: string,
		confirm?: string,
	) {
		return parseProviderWriteOutcome(
			await this.invoke("env_provider_cancel_pipeline", {
				provider,
				repository,
				pipeline,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async providerWrites(provider?: string) {
		return parseProviderWrites(
			await this.invoke("env_provider_writes", {
				...(provider ? { provider } : {}),
			}),
		);
	}

	async providerChange(provider: string, repository: string, number: number) {
		return parseProviderChangeDetail(
			await this.invoke("env_provider_change", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerChangeFiles(
		provider: string,
		repository: string,
		number: number,
	) {
		return parseProviderFiles(
			await this.invoke("env_provider_change_files", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerChangeVersions(
		provider: string,
		repository: string,
		number: number,
	) {
		return parseProviderVersions(
			await this.invoke("env_provider_change_versions", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerIssue(provider: string, repository: string, number: number) {
		return parseProviderIssueDetail(
			await this.invoke("env_provider_issue", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerIssueComments(
		provider: string,
		repository: string,
		number: number,
	) {
		return parseProviderIssueComments(
			await this.invoke("env_provider_issue_comments", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerDiscussions(
		provider: string,
		repository: string,
		number: number,
	) {
		return parseProviderDiscussions(
			await this.invoke("env_provider_discussions", {
				provider,
				repository,
				number,
			}),
		);
	}

	async providerJobLogs(provider: string, repository: string, job: number) {
		return parseProviderJobLogs(
			await this.invoke("env_provider_job_logs", {
				provider,
				repository,
				job,
			}),
		);
	}

	async providerJobs(provider: string, repository: string, pipeline: number) {
		return parseProviderJobs(
			await this.invoke("env_provider_jobs", {
				provider,
				repository,
				pipeline,
			}),
		);
	}

	async gitRemotes(repository: string, session = false): Promise<GitRemotes> {
		return parseGitRemotes(
			await this.invoke("env_git_remotes", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async gitWorktrees(
		repository: string,
		session = false,
	): Promise<GitWorktrees> {
		return parseGitWorktrees(
			await this.invoke("env_git_worktrees", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async gitAction(
		repository: string,
		request: GitActionRequest,
		session = false,
	): Promise<GitActionOutcome> {
		return parseGitAction(
			await this.invoke("env_git_action", {
				repository,
				...(session ? { session: true } : {}),
				...request,
			}),
		);
	}

	async gitTags(repository: string, session = false) {
		return parseGitTags(
			await this.invoke("env_git_tags", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async gitStashes(repository: string, session = false) {
		return parseGitStashes(
			await this.invoke("env_git_stashes", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async gitWrite(
		repository: string,
		request: GitWriteRequest,
		session: boolean,
		requestId: string,
		confirm?: string,
	): Promise<GitWriteOutcome | undefined> {
		return parseGitWriteOutcome(
			await this.invoke("env_git_write", {
				repository,
				...(session ? { session: true } : {}),
				...request,
				requestId,
				...(confirm ? { confirm } : {}),
			}),
		);
	}

	async gitChanges(repository: string, session = false): Promise<GitChanges> {
		return parseGitChanges(
			await this.invoke("env_git_changes", {
				repository,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async gitDiff(
		repository: string,
		path: string,
		side: GitDiffSide = "all",
		session = false,
	): Promise<GitDiff> {
		return parseGitDiff(
			await this.invoke("env_git_diff", {
				repository,
				path,
				side,
				...(session ? { session: true } : {}),
			}),
		);
	}

	async git(repositories?: readonly string[]): Promise<readonly GitStatus[]> {
		return parseGitStatuses(
			await this.invoke(
				"env_git",
				repositories?.length ? { repositories } : {},
			),
		);
	}

	async stop(app: string): Promise<ReturnType<typeof parseStop>> {
		return parseStop(await this.invoke("env_stop", { app }));
	}

	async logs(app: string, tail = 200, grep?: string): Promise<LogsSnapshot> {
		return parseLogs(
			await this.invoke("env_logs", {
				app,
				tail,
				...(grep ? { grep } : {}),
			}),
		);
	}

	async telemetry(app: string, traceId?: string): Promise<TelemetrySnapshot> {
		return parseTelemetry(
			await this.invoke("env_telemetry", {
				app,
				...(traceId ? { traceId } : {}),
			}),
		);
	}
}
