import { basename, dirname, join } from "node:path";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type EnvironmentStreamEvent, errorMessage } from "../client.ts";
import type { EnvironmentMcpClient } from "./client.ts";
import {
	appsForTab,
	type ConfigurationMutationResult,
	type ConfigurationPreview,
	type ContainerStatsResult,
	defaultTarget,
	type EnvironmentApp,
	type EnvironmentService,
	type EnvironmentStatus,
	type EnvironmentTab,
	type EnvironmentTarget,
	type EnvironmentView,
	type ExecutionReceipt,
	filterApps,
	filterBranches,
	type GitActionOutcome,
	type GitActionRequest,
	type GitBranches,
	type GitChanges,
	type GitDiff,
	type GitDiffSide,
	type GitRemotes,
	type GitStashes,
	type GitStatus,
	type GitTags,
	type GitWorktrees,
	type GitWriteOutcome,
	type GitWriteRequest,
	type KubernetesClusterInfo,
	type KubernetesDescribe,
	type KubernetesEvents,
	type KubernetesPodLogs,
	type KubernetesResources,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSubject,
	type OperationSummary,
	type OwnedResource,
	ownedFor,
	type ProviderChange,
	type ProviderChangeDetail,
	type ProviderDiscussion,
	type ProviderFile,
	type ProviderFiles,
	type ProviderIssue,
	type ProviderIssueDetail,
	type ProviderJob,
	type ProviderJobLogs,
	type ProviderPipeline,
	type ProviderRepository,
	type ProviderRepositoryMatch,
	type ProviderSummary,
	type ProviderVersion,
	type ProviderWriteAction,
	type ProviderWriteReceipt,
	scopeLabel,
	shortId,
	TAB_ORDER,
	type TelemetrySnapshot,
	type TelemetryTrace,
	tabCounts,
	targetsFor,
} from "./model.ts";

export function createEnvironmentStore(client: EnvironmentMcpClient) {
	const [apps, setApps] = createSignal<readonly EnvironmentApp[]>([]);
	const [services, setServices] = createSignal<readonly EnvironmentService[]>(
		[],
	);
	const [repositories, setRepositories] = createSignal<readonly string[]>([]);
	const [status, setStatus] = createSignal<EnvironmentStatus>({});
	const [git, setGit] = createSignal<ReadonlyMap<string, GitStatus>>(new Map());
	const [branches, setBranches] = createSignal<GitBranches>();
	const [branchIndex, setBranchIndex] = createSignal(0);
	const [branchQuery, setBranchQueryValue] = createSignal("");
	const [branchSearchFocused, setBranchSearchFocused] = createSignal(false);
	const [worktrees, setWorktrees] = createSignal<GitWorktrees>();
	const [worktreeIndex, setWorktreeIndex] = createSignal(0);
	const [worktreePath, setWorktreePath] = createSignal("");
	const [worktreeBranch, setWorktreeBranch] = createSignal("");
	const [worktreeField, setWorktreeField] = createSignal(0);
	const [remotes, setRemotes] = createSignal<GitRemotes>();
	const [remoteIndex, setRemoteIndex] = createSignal(0);
	const [remoteName, setRemoteName] = createSignal("");
	const [remoteUrl, setRemoteUrl] = createSignal("");
	const [remoteField, setRemoteField] = createSignal(0);
	const [gitOutcome, setGitOutcome] = createSignal<GitActionOutcome>();
	const [gitWriteRequest, setGitWriteRequest] = createSignal<GitWriteRequest>();
	const [gitWriteBody, setGitWriteBody] = createSignal("");
	const [gitWriteRequestId, setGitWriteRequestId] = createSignal("");
	const [gitWriteDigest, setGitWriteDigest] = createSignal<string>();
	const [gitWriteTarget, setGitWriteTarget] = createSignal<string>();
	const [gitWriteStage, setGitWriteStage] = createSignal<
		"edit" | "confirm" | "completed"
	>("confirm");
	const [gitWriteOutcome, setGitWriteOutcome] = createSignal<GitWriteOutcome>();
	const [gitWriteOrigin, setGitWriteOrigin] =
		createSignal<EnvironmentView>("git");
	const [tags, setTags] = createSignal<GitTags>();
	const [tagIndex, setTagIndex] = createSignal(0);
	const [stashes, setStashes] = createSignal<GitStashes>();
	const [stashIndex, setStashIndex] = createSignal(0);
	const [tagName, setTagName] = createSignal("");
	const [tagMessage, setTagMessage] = createSignal("");
	const [tagField, setTagField] = createSignal(0);
	const [tagOrigin, setTagOrigin] = createSignal<EnvironmentView>("git");
	const [containerStats, setContainerStats] =
		createSignal<ContainerStatsResult>();
	const [clusters, setClusters] = createSignal<
		readonly KubernetesClusterInfo[]
	>([]);
	const [clusterIndex, setClusterIndex] = createSignal(0);
	const [clusterNamespace, setClusterNamespaceValue] = createSignal("default");
	const [clusterNamespaceFocused, setClusterNamespaceFocused] =
		createSignal(false);
	const [clusterResources, setClusterResources] =
		createSignal<KubernetesResources>();
	const [clusterResourceIndex, setClusterResourceIndex] = createSignal(0);
	const [clusterEvents, setClusterEvents] = createSignal<KubernetesEvents>();
	const [clusterDescribe, setClusterDescribe] =
		createSignal<KubernetesDescribe>();
	const [clusterPodLogs, setClusterPodLogs] = createSignal<KubernetesPodLogs>();
	const [configAction, setConfigAction] = createSignal<
		| "app-create"
		| "app-edit"
		| "app-delete"
		| "target-duplicate"
		| "target-shell"
		| "target-edit"
		| "target-delete"
	>();
	const [configStage, setConfigStage] = createSignal<
		"edit" | "confirm" | "completed"
	>("edit");
	const [configOrigin, setConfigOrigin] =
		createSignal<EnvironmentView>("table");
	const [configField, setConfigField] = createSignal(0);
	const [configId, setConfigId] = createSignal("");
	const [configKind, setConfigKind] = createSignal("app");
	const [configRepository, setConfigRepository] = createSignal("");
	const [configProfile, setConfigProfile] = createSignal("");
	const [configTargetAction, setConfigTargetAction] = createSignal("build");
	const [configCommand, setConfigCommand] = createSignal("");
	const [configTimeout, setConfigTimeout] = createSignal("");
	const [configDeleteTargets, setConfigDeleteTargets] = createSignal(false);
	const [configSource, setConfigSource] = createSignal<{
		app: string;
		target: string;
		runtime: string;
	}>();
	const [configPreview, setConfigPreview] =
		createSignal<ConfigurationPreview>();
	const [configResult, setConfigResult] =
		createSignal<ConfigurationMutationResult>();
	const [providers, setProviders] = createSignal<readonly ProviderSummary[]>(
		[],
	);
	const [providerIndex, setProviderIndex] = createSignal(0);
	const [providerFilter, setProviderFilterValue] = createSignal("");
	const [providerFilterFocused, setProviderFilterFocused] = createSignal(false);
	const [providerRepos, setProviderRepos] = createSignal<
		readonly ProviderRepository[]
	>([]);
	const [providerRepoIndex, setProviderRepoIndex] = createSignal(0);
	const [providerRepoQuery, setProviderRepoQueryValue] = createSignal("");
	const [providerRepoSearchFocused, setProviderRepoSearchFocused] =
		createSignal(false);
	const [providerRepo, setProviderRepo] = createSignal<ProviderRepository>();
	const [providerDirect, setProviderDirect] = createSignal(false);
	const [providerState, setProviderState] = createSignal<
		"open" | "closed" | "all"
	>("open");
	const [providerChanges, setProviderChanges] = createSignal<
		readonly ProviderChange[]
	>([]);
	const [providerIssues, setProviderIssues] = createSignal<
		readonly ProviderIssue[]
	>([]);
	const [providerPipelines, setProviderPipelines] = createSignal<
		readonly ProviderPipeline[]
	>([]);
	const [providerJobs, setProviderJobs] = createSignal<readonly ProviderJob[]>(
		[],
	);
	const [providerPipeline, setProviderPipeline] =
		createSignal<ProviderPipeline>();
	const [providerChangeDetail, setProviderChangeDetail] =
		createSignal<ProviderChangeDetail>();
	const [providerFiles, setProviderFiles] = createSignal<ProviderFiles>();
	const [providerDiscussions, setProviderDiscussions] = createSignal<
		readonly ProviderDiscussion[]
	>([]);
	const [providerIssueDetail, setProviderIssueDetail] =
		createSignal<ProviderIssueDetail>();
	const [providerJobLogs, setProviderJobLogs] = createSignal<ProviderJobLogs>();
	const [providerIssueComments, setProviderIssueComments] = createSignal<
		readonly ProviderDiscussion[]
	>([]);
	const [providerVersions, setProviderVersions] = createSignal<
		readonly ProviderVersion[]
	>([]);
	const [providerFile, setProviderFile] = createSignal<ProviderFile>();
	const [providerLogJob, setProviderLogJob] = createSignal<number>();
	const [providerWrites, setProviderWrites] = createSignal<
		readonly ProviderWriteReceipt[]
	>([]);
	const [providerWriteAction, setProviderWriteAction] =
		createSignal<ProviderWriteAction>();
	const [providerWriteBody, setProviderWriteBody] = createSignal("");
	const [providerWriteRequestId, setProviderWriteRequestId] = createSignal("");
	const [providerWriteDigest, setProviderWriteDigest] = createSignal<string>();
	const [providerWriteStage, setProviderWriteStage] = createSignal<
		"edit" | "confirm" | "completed"
	>("edit");
	const [providerWriteReceipt, setProviderWriteReceipt] =
		createSignal<ProviderWriteReceipt>();
	const [providerWriteOrigin, setProviderWriteOrigin] =
		createSignal<EnvironmentView>("provider-change");
	const [providerItemIndex, setProviderItemIndex] = createSignal(0);
	const [sessionApp, setSessionApp] = createSignal<EnvironmentApp>();
	const [sessionMode, setSessionMode] = createSignal(false);
	const [executionWorktree, setExecutionWorktree] = createSignal<{
		appId: string;
		path: string;
	}>();
	const [changes, setChanges] = createSignal<GitChanges>();
	const [changeIndex, setChangeIndex] = createSignal(0);
	const [diff, setDiff] = createSignal<GitDiff>();
	const [diffSide, setDiffSide] = createSignal<GitDiffSide>("all");
	const [operations, setOperations] = createSignal<readonly OperationSummary[]>(
		[],
	);
	const [operationTotal, setOperationTotal] = createSignal(0);
	const [operation, setOperation] = createSignal<OperationDetail>();
	const [progress, setProgress] = createSignal("");
	const [receipt, setReceipt] = createSignal<ExecutionReceipt | null>(null);
	const [logs, setLogs] = createSignal<LogsSnapshot>();
	const [telemetry, setTelemetry] = createSignal<TelemetrySnapshot>();
	const [traceId, setTraceId] = createSignal<string>();
	const [tab, setTab] = createSignal<EnvironmentTab>("applications");
	const [view, setView] = createSignal<EnvironmentView>("table");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [selectedAppId, setSelectedAppId] = createSignal<string>();
	const [targetAction, setTargetAction] = createSignal("run");
	const [targetIndex, setTargetIndex] = createSignal(0);
	const [historyIndex, setHistoryIndex] = createSignal(0);
	const [traceIndex, setTraceIndex] = createSignal(0);
	const [query, setQuery] = createSignal("");
	const [searchFocused, setSearchFocused] = createSignal(false);
	const [message, setMessage] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);
	const [operationOrigin, setOperationOrigin] = createSignal<
		"detail" | "history"
	>("detail");
	const subjects = new Map<string, OperationSubject>();

	const providerErrors: Record<string, string> = {
		"provider-not-configured": "Provider is not configured.",
		"provider-token-unavailable": "Provider token reference is unavailable.",
		"provider-unauthorized": "Provider rejected the credential.",
		"provider-forbidden": "Provider denied access.",
		"provider-not-found": "Provider resource was not found.",
		"provider-rate-limited": "Provider rate limit was reached.",
		"provider-unavailable": "Provider is unavailable.",
		"provider-invalid": "Provider request or response was invalid.",
		"provider-response-too-large": "Provider response exceeded the size limit.",
		"provider-write-unavailable": "Provider writes are unavailable.",
		"provider-write-in-progress": "This provider write is already in progress.",
		"provider-head-changed":
			"The provider head changed; re-read before approving.",
		"request-conflict":
			"This request ID was already used for a different action.",
		"operation-in-progress": "An operation is in progress.",
		"git-write-in-progress": "This git write is already in progress.",
		"repository-unauthorized": "Repository is not authorized.",
		"invalid-response": "The service returned an invalid response.",
	};
	const fail = (reason: unknown) => {
		const raw = errorMessage(reason);
		const text =
			raw === "worktree-unsupported"
				? "Only shell/process and Docker build targets can run from a worktree."
				: (providerErrors[raw] ?? raw);
		setError(text);
		setMessage(text);
	};
	const clearMessage = () => {
		setError(undefined);
		setMessage(undefined);
	};

	const counts = createMemo(() => tabCounts(apps()));
	const tabApps = createMemo(() => appsForTab(apps(), tab()));
	const filteredApps = createMemo(() => filterApps(tabApps(), query()));
	const selectedApp = createMemo(() => {
		const session = sessionApp();
		if (session) return session;
		const id = view() === "table" ? undefined : selectedAppId();
		return (
			(id ? filteredApps().find((app) => app.id === id) : undefined) ??
			filteredApps()[selectedIndex()] ??
			tabApps()[0]
		);
	});
	const targetList = createMemo(() =>
		targetsFor(selectedApp(), targetAction()),
	);
	const selectedTarget = createMemo(
		() => targetList()[targetIndex()] ?? targetList()[0],
	);
	const owned = createMemo(() => status().owned ?? []);
	const selectedOwned = createMemo(() => {
		const app = selectedApp();
		return app ? ownedFor(status(), app.id) : ([] as readonly OwnedResource[]);
	});
	const selectedOperation = createMemo(
		() => operations()[historyIndex()] ?? operations()[0],
	);
	const selectedChange = createMemo(
		() => changes()?.changes[changeIndex()] ?? changes()?.changes[0],
	);
	const filteredBranches = createMemo(() =>
		filterBranches(branches()?.branches ?? [], branchQuery()),
	);
	const selectedBranch = createMemo(
		() => filteredBranches()[branchIndex()] ?? filteredBranches()[0],
	);
	const selectedWorktree = createMemo(
		() => worktrees()?.worktrees[worktreeIndex()] ?? worktrees()?.worktrees[0],
	);
	const selectedRemote = createMemo(
		() => remotes()?.remotes[remoteIndex()] ?? remotes()?.remotes[0],
	);
	const matches = (query: string, values: readonly string[]) => {
		const needle = query.trim().toLowerCase();
		return (
			!needle || values.some((value) => value.toLowerCase().includes(needle))
		);
	};
	const visibleProviders = createMemo(() =>
		providers().filter((provider) =>
			matches(providerFilter(), [
				provider.name,
				provider.type,
				provider.baseUrl,
				provider.username,
			]),
		),
	);
	const selectedCluster = createMemo(
		() => clusters()[clusterIndex()] ?? clusters()[0],
	);
	const selectedClusterResource = createMemo(() => {
		const items = clusterResources()?.items ?? [];
		return items[clusterResourceIndex()] ?? items[0];
	});
	const selectedProvider = createMemo(
		() =>
			visibleProviders()[providerIndex()] ?? visibleProviders()[0] ?? undefined,
	);
	const selectedProviderRepository = createMemo(
		() => providerRepos()[providerRepoIndex()] ?? providerRepos()[0],
	);
	const visibleProviderChanges = createMemo(() =>
		providerChanges().filter((change) =>
			matches(providerFilter(), [
				String(change.number),
				change.title,
				change.author,
				change.sourceBranch,
				change.targetBranch,
				change.state,
			]),
		),
	);
	const visibleProviderIssues = createMemo(() =>
		providerIssues().filter((issue) =>
			matches(providerFilter(), [
				String(issue.number),
				issue.title,
				issue.author,
				issue.state,
				...issue.labels,
			]),
		),
	);
	const visibleProviderPipelines = createMemo(() =>
		providerPipelines().filter((pipeline) =>
			matches(providerFilter(), [
				String(pipeline.id),
				pipeline.name,
				pipeline.status,
				pipeline.conclusion ?? "",
				pipeline.ref ?? "",
			]),
		),
	);
	const visibleProviderJobs = createMemo(() =>
		providerJobs().filter((job) =>
			matches(providerFilter(), [
				String(job.id),
				job.name,
				job.status,
				job.conclusion ?? "",
				job.stage ?? "",
			]),
		),
	);
	const selectedProviderChange = createMemo(
		() =>
			visibleProviderChanges()[providerItemIndex()] ??
			visibleProviderChanges()[0],
	);
	const selectedProviderIssue = createMemo(
		() =>
			visibleProviderIssues()[providerItemIndex()] ??
			visibleProviderIssues()[0],
	);
	const selectedProviderPipeline = createMemo(
		() =>
			visibleProviderPipelines()[providerItemIndex()] ??
			visibleProviderPipelines()[0],
	);
	const selectedProviderJob = createMemo(
		() =>
			visibleProviderJobs()[providerItemIndex()] ?? visibleProviderJobs()[0],
	);
	const selectedProviderFile = createMemo(
		() =>
			providerFiles()?.files[providerItemIndex()] ?? providerFiles()?.files[0],
	);
	const selectedTag = createMemo(
		() => tags()?.tags[tagIndex()] ?? tags()?.tags[0],
	);
	const selectedStash = createMemo(
		() => stashes()?.stashes[stashIndex()] ?? stashes()?.stashes[0],
	);
	const selectedProviderDiscussion = createMemo(() => {
		const issueComments =
			view() === "provider-issue-comments" ||
			providerWriteOrigin() === "provider-issue-comments";
		const list = issueComments
			? providerIssueComments()
			: providerDiscussions();
		return list[providerItemIndex()] ?? list[0];
	});
	createEffect(() => {
		const count = filteredBranches().length;
		setBranchIndex((current) => Math.min(current, Math.max(0, count - 1)));
	});
	const activeApps = createMemo(() => {
		const map = new Map<string, { action?: string }>();
		const current = operation();
		const candidates = current ? [current, ...operations()] : operations();
		for (const candidate of candidates) {
			const app = candidate.subject?.app;
			if (!app || candidate.state !== "issued" || map.has(app)) continue;
			map.set(app, { action: candidate.subject?.action });
		}
		return map;
	});
	const selectedTrace = createMemo<TelemetryTrace | undefined>(
		() => telemetry()?.traces[traceIndex()] ?? telemetry()?.traces[0],
	);
	const scope = createMemo(() => scopeLabel(status()));
	const appTotal = createMemo(() => apps().length);

	createEffect(() => {
		const count = filteredApps().length;
		setSelectedIndex((current) => Math.min(current, Math.max(0, count - 1)));
	});

	const loadStatus = async () => {
		setStatus(await client.status());
	};
	const loadGit = async (repositories?: readonly string[]) => {
		try {
			const statuses = await client.git(repositories);
			if (repositories?.length) {
				const next = new Map(git());
				for (const entry of statuses) next.set(entry.repository, entry);
				setGit(next);
			} else {
				setGit(new Map(statuses.map((entry) => [entry.repository, entry])));
			}
		} catch {
			// Keep the last observation; the explicit refresh reports errors.
		}
	};
	const applyHistory = (result: Awaited<ReturnType<typeof client.history>>) => {
		setOperations(result.operations);
		setOperationTotal(result.total);
		setHistoryIndex((current) =>
			Math.min(current, Math.max(0, result.operations.length - 1)),
		);
	};
	const loadHistory = async () => {
		applyHistory(await client.history(0, 20));
	};
	const maxLiveOutput = 8 * 1024 * 1024;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollToken: object | undefined;
	let pollingId: string | undefined;
	const stopPolling = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		pollToken = undefined;
		pollingId = undefined;
	};
	const pollOperation = (id: string) => {
		stopPolling();
		const token = {};
		pollToken = token;
		pollingId = id;
		let offset = 0;
		let buffered = "";
		const tick = async () => {
			if (pollToken !== token) return;
			try {
				const detail = await client.operation(id, offset);
				if (pollToken !== token) return;
				setError(undefined);
				setOperation(detail);
				if (detail.progress) {
					buffered = detail.progress.reset
						? detail.progress.text
						: buffered + detail.progress.text;
					if (buffered.length > maxLiveOutput)
						buffered = buffered.slice(buffered.length - maxLiveOutput);
					offset = detail.progress.offset;
					setProgress(buffered);
				}
				if (detail.state !== "issued") {
					stopPolling();
					setMessage(
						detail.state === "completed"
							? "Operation completed"
							: `Operation ${detail.state}`,
					);
					await loadHistory();
					await loadStatus();
					await loadGit();
					return;
				}
			} catch (reason) {
				if (pollToken !== token) return;
				fail(reason);
				stopPolling();
				return;
			}
			pollTimer = setTimeout(() => void tick(), 1000);
		};
		pollTimer = setTimeout(() => void tick(), 250);
	};
	const liveStatusRefreshMs = 15_000;
	const liveGitRefreshMs = 30_000;
	let liveStatusTimer: ReturnType<typeof setInterval> | undefined;
	let liveGitTimer: ReturnType<typeof setInterval> | undefined;
	let liveToken: object | undefined;
	let stateRequest = 0;
	let stateGeneration = 0;
	const refreshState = async () => {
		const request = ++stateRequest;
		try {
			const [nextStatus, history] = await Promise.all([
				client.status(),
				client.history(0, 20),
			]);
			if (request !== stateRequest) return;
			setStatus(nextStatus);
			applyHistory(history);
		} catch {
			// Keep the last observation; manual refresh reports errors.
		}
	};
	const stopLiveRefresh = () => {
		if (liveStatusTimer) clearInterval(liveStatusTimer);
		if (liveGitTimer) clearInterval(liveGitTimer);
		liveStatusTimer = undefined;
		liveGitTimer = undefined;
		liveToken = undefined;
	};
	const startLiveRefresh = () => {
		if (liveToken) return;
		const token = {};
		liveToken = token;
		if (loadedOnce) {
			void refreshState();
			void loadGit();
		}
		liveStatusTimer = setInterval(
			() => void refreshState(),
			liveStatusRefreshMs,
		);
		liveGitTimer = setInterval(() => void loadGit(), liveGitRefreshMs);
	};
	let snapshotCount = 0;
	const handleEvent = (event: EnvironmentStreamEvent) => {
		if (
			event.type === "status" ||
			event.type === "operation" ||
			event.type === "git"
		)
			stateGeneration += 1;
		if (event.type === "status" || event.type === "operation") {
			if (view() === "table" || view() === "detail") void refreshState();
			return;
		}
		if (event.type === "git") {
			void loadGit(event.repository ? [event.repository] : undefined);
			return;
		}
		if (event.type === "services") {
			void client
				.services()
				.then(setServices)
				.catch(() => {});
			return;
		}
		if (event.type === "snapshot") {
			snapshotCount += 1;
			if (snapshotCount === 1) return;
			if (loadedOnce && !busy()) void load();
		}
	};
	onCleanup(() => {
		stopPolling();
		stopLiveRefresh();
	});

	let loadedOnce = false;
	const load = async () => {
		setBusy(true);
		setError(undefined);
		const generation = stateGeneration;
		try {
			const [list, nextStatus, history] = await Promise.all([
				client.list(),
				client.status(),
				client.history(0, 20),
			]);
			setApps(list.apps);
			setServices(list.services);
			setRepositories(list.repositories);
			setStatus(nextStatus);
			setOperations(history.operations);
			setOperationTotal(history.total);
			void loadGit();
			if (!selectedAppId() && list.apps[0]) setSelectedAppId(list.apps[0].id);
			setSelectedIndex((current) =>
				Math.min(current, Math.max(0, filteredApps().length - 1)),
			);
			if (stateGeneration !== generation) {
				await refreshState();
				await loadGit();
			}
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
			loadedOnce = true;
		}
	};

	const selectTab = (next: EnvironmentTab) => {
		endSessionGit();
		setTab(next);
		setQuery("");
		setSelectedIndex(0);
		setSearchFocused(false);
		clearMessage();
		if (next === "history") {
			setView("history");
			void loadHistory().catch(fail);
			return;
		}
		if (next === "services") {
			setView("services");
			void client.services().then(setServices).catch(fail);
			return;
		}
		setView("table");
	};

	const cycleTab = (delta: number) => {
		const index = TAB_ORDER.indexOf(tab());
		const next =
			TAB_ORDER[(index + delta + TAB_ORDER.length) % TAB_ORDER.length];
		if (next) selectTab(next);
	};

	const move = (delta: number) => {
		if (view() === "table") {
			const count = filteredApps().length;
			if (!count) return;
			setSelectedIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "targets") {
			const count = targetList().length;
			if (!count) return;
			setTargetIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "history") {
			const count = operations().length;
			if (!count) return;
			setHistoryIndex((current) => (current + delta + count) % count);
			return;
		}
		if (view() === "telemetry") {
			const count = telemetry()?.traces.length ?? 0;
			if (!count) return;
			setTraceIndex((current) => (current + delta + count) % count);
		}
	};

	const openApp = (app: EnvironmentApp) => {
		endSessionGit();
		if (executionWorktree()?.appId !== app.id) setExecutionWorktree(undefined);
		setSelectedAppId(app.id);
		setBranches(undefined);
		setWorktrees(undefined);
		setGitOutcome(undefined);
		setChanges(undefined);
		setDiff(undefined);
		setChangeIndex(0);
		setView("detail");
		clearMessage();
	};

	const executeTarget = async (action: string, target: EnvironmentTarget) => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const worktree = executionWorktree();
			const result = await client.execute(
				app.id,
				target.id,
				worktree?.appId === app.id ? worktree.path : undefined,
			);
			const next = result.operation;
			if (!next) throw new Error("invalid-operation-response");
			subjects.set(next.id, {
				app: app.id,
				target: target.id,
				action,
				repository: app.repository,
			});
			setOperation(next);
			setReceipt(result.receipt);
			setProgress("");
			setOperationOrigin("detail");
			setView("operation");
			setMessage(`Executing ${app.id} · ${action} · ${target.id}`);
			if (next.state === "issued") {
				setMessage(`Running ${app.id} · ${action}…`);
				pollOperation(next.id);
			} else if (result.receipt) {
				setMessage(`Completed: ${String(result.receipt.status ?? "done")}`);
			}
			await loadHistory();
			await loadStatus();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadBranches = async (
		app?: EnvironmentApp,
		session = sessionMode(),
	) => {
		const target = app ?? selectedApp();
		if (!target) return;
		const next = await client.gitBranches(target.repository, session);
		setBranches(next);
		setBranchIndex((current) =>
			Math.min(current, Math.max(0, next.branches.length - 1)),
		);
	};
	const loadWorktrees = async (
		app?: EnvironmentApp,
		session = sessionMode(),
	) => {
		const target = app ?? selectedApp();
		if (!target) return;
		const next = await client.gitWorktrees(target.repository, session);
		setWorktrees(next);
		setWorktreeIndex((current) =>
			Math.min(current, Math.max(0, next.worktrees.length - 1)),
		);
	};
	const loadRemotes = async (app?: EnvironmentApp, session = sessionMode()) => {
		const target = app ?? selectedApp();
		if (!target) return;
		const next = await client.gitRemotes(target.repository, session);
		setRemotes(next);
		setRemoteIndex((current) =>
			Math.min(current, Math.max(0, next.remotes.length - 1)),
		);
	};
	const gitReason = (reason: string | undefined, status: string) => {
		if (status === "completed") return "completed";
		const text: Record<string, string> = {
			"dirty-worktree": "Working tree has changes",
			"branch-not-found": "Branch not found",
			"branch-in-use": "Branch is checked out in another worktree",
			"branch-exists": "Branch already exists",
			"branch-invalid": "Invalid branch name",
			"path-exists": "Path already exists",
			"path-invalid": "Invalid worktree path",
			"worktree-not-found": "Worktree not found",
			"current-worktree": "Cannot remove the current worktree",
			"worktree-locked": "Worktree is locked",
			"operation-in-progress": "An operation is in progress",
			busy: "Another git action is in progress",
			"nothing-to-commit": "There are no changes to commit",
			"nothing-to-stash": "There are no changes to stash",
			"nothing-staged": "There are no staged changes to commit",
			"path-not-found": "Changed path was not found",
			"not-staged": "Path is not staged",
			"tag-invalid": "Invalid tag name",
			"tag-exists": "Tag already exists",
			"tag-not-found": "Tag not found",
			"stash-not-found": "Stash not found",
			"detached-head": "The repository is on a detached HEAD",
			"merge-conflict": "Merge stopped on conflicts",
			"rebase-conflict": "Rebase stopped on conflicts",
			"push-rejected": "Push was rejected; fetch and reconcile first",
			"force-lease-missing":
				"Force push requires an upstream and a fetched remote-tracking ref",
			"force-lease-stale": "The remote moved since the last fetch; fetch first",
			"no-rebase": "No rebase is in progress",
			"authentication-required": "The remote requires credentials",
			"remote-unavailable": "The remote is unavailable",
			"identity-missing": "Configure git user.name and user.email first",
			"git-failed": "Git command failed",
			"remote-not-found": "Remote not found",
			timeout: "Git action timed out",
			unavailable: "Git action unavailable",
		};
		return text[reason ?? ""] ?? reason ?? status;
	};
	const runAction = async (
		request: GitActionRequest,
	): Promise<GitActionOutcome | undefined> => {
		const app = selectedApp();
		if (!app) return undefined;
		setBusy(true);
		setError(undefined);
		setGitOutcome(undefined);
		try {
			const outcome = await client.gitAction(
				app.repository,
				request,
				sessionMode(),
			);
			setGitOutcome(outcome);
			if (outcome.status === "completed") {
				setMessage(`${request.action} completed`);
			} else {
				const text = gitReason(outcome.reason, outcome.status);
				setMessage(text);
				setError(text);
			}
			await Promise.all([
				loadBranches(app),
				loadWorktrees(app),
				loadRemotes(app),
				...(sessionMode() ? [] : [loadGit([app.repository])]),
			]);
			if (request.action === "checkout") {
				setChanges(undefined);
				setChangeIndex(0);
			}
			return outcome;
		} catch (reason) {
			fail(reason);
			return undefined;
		} finally {
			setBusy(false);
		}
	};
	const loadGitView = async (app: EnvironmentApp) => {
		setSessionApp(undefined);
		setSessionMode(false);
		setBranchQueryValue("");
		setBranchSearchFocused(false);
		setBusy(true);
		setError(undefined);
		setGitOutcome(undefined);
		try {
			await Promise.all([
				loadBranches(app),
				loadWorktrees(app),
				loadRemotes(app),
			]);
			await loadGit([app.repository]);
			setBranchIndex(0);
			setWorktreeIndex(0);
			setView("git");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadSessionGit = async (directory: string) => {
		const app: EnvironmentApp = {
			id: basename(directory) || directory,
			repository: directory,
			kind: "session",
			defaults: {},
			targets: [],
		};
		setSessionApp(app);
		setSessionMode(true);
		setBranchQueryValue("");
		setBranchSearchFocused(false);
		setBranches(undefined);
		setWorktrees(undefined);
		setGitOutcome(undefined);
		setChanges(undefined);
		setDiff(undefined);
		setChangeIndex(0);
		setBusy(true);
		setError(undefined);
		try {
			const [nextBranches, nextWorktrees, nextRemotes] = await Promise.all([
				client.gitBranches(directory, true),
				client.gitWorktrees(directory, true),
				client.gitRemotes(directory, true),
			]);
			setBranches(nextBranches);
			setWorktrees(nextWorktrees);
			setRemotes(nextRemotes);
			setBranchIndex(0);
			setWorktreeIndex(0);
			setRemoteIndex(0);
			setView("git");
			if (nextBranches.note === "unavailable")
				setMessage(`No git repository at ${directory}`);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const endSessionGit = () => {
		setSessionApp(undefined);
		setSessionMode(false);
		setBranchQueryValue("");
		setBranchSearchFocused(false);
		setBranches(undefined);
		setWorktrees(undefined);
		setGitOutcome(undefined);
	};
	const fetchGit = () => void runAction({ action: "fetch" });
	const pullGit = () => void runAction({ action: "pull" });
	const checkoutBranch = () => {
		const branch = selectedBranch();
		if (branch) void runAction({ action: "checkout", branch: branch.name });
	};
	const deleteSelectedBranch = () => {
		const branch = selectedBranch();
		if (branch)
			void runAction({ action: "branch-delete", branch: branch.name });
	};
	const beginRemoteAdd = () => {
		setRemoteName("");
		setRemoteUrl("");
		setRemoteField(0);
		setView("remote-add");
	};
	const submitRemoteAdd = async () => {
		if (!remoteName().trim() || !remoteUrl().trim()) return;
		const outcome = await runAction({
			action: "remote-add",
			name: remoteName().trim(),
			url: remoteUrl().trim(),
		});
		if (outcome?.status === "completed") setView("remotes");
	};
	const removeSelectedRemote = () => {
		const remote = selectedRemote();
		if (remote) void runAction({ action: "remote-remove", name: remote.name });
	};
	const cycleRemoteField = () => {
		setRemoteField((current) => (current + 1) % 2);
	};
	const setBranchQuery = (value: string) => {
		setBranchQueryValue(value);
		setBranchIndex(0);
	};
	const moveBranch = (delta: number) => {
		const count = filteredBranches().length;
		if (!count) return;
		setBranchIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const moveRemote = (delta: number) => {
		const count = remotes()?.remotes.length ?? 0;
		if (!count) return;
		setRemoteIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const cycleWorktreeField = () => {
		setWorktreeField((current) => (current + 1) % 2);
	};
	const cycleDiffSide = () => {
		const sides: GitDiffSide[] = ["all", "staged", "worktree"];
		const next = sides[(sides.indexOf(diffSide()) + 1) % sides.length];
		if (next) setDiffSide(next);
		void reloadDiff();
	};
	const moveWorktree = (delta: number) => {
		const count = worktrees()?.worktrees.length ?? 0;
		if (!count) return;
		setWorktreeIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const useSelectedWorktree = () => {
		const app = selectedApp();
		const worktree = selectedWorktree();
		if (!app || !worktree) return;
		if (app.kind === "session") {
			setMessage("Session Git has no environment targets.");
			return;
		}
		if (
			executionWorktree()?.appId === app.id &&
			executionWorktree()?.path === worktree.path
		) {
			setExecutionWorktree(undefined);
			setMessage("Worktree execution cleared");
			return;
		}
		setExecutionWorktree({ appId: app.id, path: worktree.path });
		setView("detail");
		setMessage(`Targets will run in ${worktree.path}`);
	};
	const clearWorktreeExecution = () => {
		setExecutionWorktree(undefined);
		setMessage("Worktree execution cleared");
	};
	const beginWorktreeAdd = () => {
		const app = selectedApp();
		if (!app) return;
		const branch = selectedBranch()?.name ?? branches()?.current ?? "";
		const root =
			worktrees()?.worktrees.find((entry) => entry.current)?.path ??
			app.repository;
		const suffix = branch.replace(/[^A-Za-z0-9._-]+/g, "-") || "worktree";
		setWorktreeBranch(branch);
		setWorktreePath(join(dirname(root), `${basename(root)}-${suffix}`));
		setWorktreeField(0);
		setView("worktree-add");
	};
	const updateWorktreeBranch = (value: string) => {
		const app = selectedApp();
		const previous = worktreeBranch();
		setWorktreeBranch(value);
		if (!app) return;
		const root =
			worktrees()?.worktrees.find((entry) => entry.current)?.path ??
			app.repository;
		const sanitize = (branch: string) =>
			branch.replace(/[^A-Za-z0-9._-]+/g, "-") || "worktree";
		const prefix = join(dirname(root), basename(root));
		if (worktreePath() === `${prefix}-${sanitize(previous)}`)
			setWorktreePath(`${prefix}-${sanitize(value)}`);
	};
	const submitWorktreeAdd = async () => {
		const path = worktreePath().trim();
		const branch = worktreeBranch();
		if (!path || !branch) return;
		const create = !branches()?.branches.some((entry) => entry.name === branch);
		const outcome = await runAction({
			action: "worktree-add",
			path,
			branch,
			create,
		});
		if (outcome?.status === "completed") setView("worktrees");
	};
	const removeSelectedWorktree = async () => {
		const app = selectedApp();
		const worktree = selectedWorktree();
		if (!worktree) return;
		const outcome = await runAction({
			action: "worktree-remove",
			path: worktree.path,
		});
		if (
			outcome?.status === "completed" &&
			app &&
			executionWorktree()?.appId === app.id &&
			executionWorktree()?.path === worktree.path
		)
			setExecutionWorktree(undefined);
	};

	const refreshTags = async () => {
		const app = selectedApp();
		if (!app) return;
		const next = await client.gitTags(app.repository, sessionMode());
		setTags(next);
		setTagIndex((current) =>
			Math.min(current, Math.max(0, next.tags.length - 1)),
		);
	};
	const refreshStashes = async () => {
		const app = selectedApp();
		if (!app) return;
		const next = await client.gitStashes(app.repository, sessionMode());
		setStashes(next);
		setStashIndex((current) =>
			Math.min(current, Math.max(0, next.stashes.length - 1)),
		);
	};
	const loadTags = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			await refreshTags();
			setTagIndex(0);
			setView("tags");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadStashes = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			await refreshStashes();
			setStashIndex(0);
			setView("stashes");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const moveTag = (delta: number) => {
		const count = tags()?.tags.length ?? 0;
		if (!count) return;
		setTagIndex((current) => Math.min(count - 1, Math.max(0, current + delta)));
	};
	const moveStash = (delta: number) => {
		const count = stashes()?.stashes.length ?? 0;
		if (!count) return;
		setStashIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const runStageAction = async (request: GitActionRequest) => {
		const outcome = await runAction(request);
		if (outcome) await refreshChanges();
	};
	const toggleStageSelectedChange = () => {
		const change = selectedChange();
		if (!change) return;
		void runStageAction({
			action: change.staged ? "unstage" : "stage",
			path: change.path,
		});
	};
	const stageAllChanges = () => {
		void runStageAction({ action: "stage-all" });
	};
	const unstageAllChanges = () => {
		void runStageAction({ action: "unstage-all" });
	};

	const currentGitWriteRequest = (): GitWriteRequest | undefined => {
		const request = gitWriteRequest();
		if (!request) return undefined;
		const body = gitWriteBody().trim();
		if (request.action === "tag") return request;
		if (request.action === "branch-rename")
			return body
				? { action: "branch-rename", branch: request.branch, name: body }
				: undefined;
		if (request.action === "remote-set-url")
			return body
				? { action: "remote-set-url", name: request.name, url: body }
				: undefined;
		if (request.action === "commit")
			return body ? { action: "commit", message: body } : undefined;
		if (request.action === "commit-all")
			return body ? { action: "commit-all", message: body } : undefined;
		if (request.action === "stash")
			return { action: "stash", ...(body ? { message: body } : {}) };
		return request;
	};
	const gitWriteCall = async (confirm?: string) => {
		const app = selectedApp();
		const request = currentGitWriteRequest();
		if (!app || !request) return undefined;
		return client.gitWrite(
			app.repository,
			request,
			sessionMode(),
			gitWriteRequestId(),
			confirm,
		);
	};
	const startGitWrite = async (
		request: GitWriteRequest,
		origin: EnvironmentView,
		editable = false,
		body = "",
	) => {
		setGitWriteRequest(request);
		setGitWriteBody(body);
		setGitWriteRequestId(crypto.randomUUID());
		setGitWriteDigest(undefined);
		setGitWriteTarget(undefined);
		setGitWriteOutcome(undefined);
		setGitWriteOrigin(origin);
		setGitWriteStage(editable ? "edit" : "confirm");
		setView("git-write");
		if (!editable) await previewGitWrite();
	};
	const beginTagAdd = (origin: EnvironmentView) => {
		setTagOrigin(origin);
		setTagName("");
		setTagMessage("");
		setTagField(0);
		setView("tag-add");
	};
	const cycleTagField = () => {
		setTagField((current) => (current + 1) % 2);
	};
	const submitTagAdd = async () => {
		const name = tagName().trim();
		if (!name) {
			setMessage("Tag name is required.");
			return;
		}
		const message = tagMessage().trim();
		await startGitWrite(
			{ action: "tag", name, ...(message ? { message } : {}) },
			tagOrigin() === "tags" ? "tags" : "git",
		);
	};
	const deleteSelectedTag = () => {
		const tag = selectedTag();
		if (!tag) return;
		void startGitWrite({ action: "tag-delete", name: tag.name }, "tags");
	};
	const beginStashWrite = (
		action: "stash-pop" | "stash-apply" | "stash-drop",
	) => {
		const stash = selectedStash();
		if (!stash) return;
		void startGitWrite({ action, index: stash.index }, "stashes");
	};
	const beginGitWrite = async (
		action: GitWriteRequest["action"],
		origin: EnvironmentView,
	) => {
		const app = selectedApp();
		if (!app) return;
		clearMessage();
		const branch = selectedBranch();
		const remoteList = remotes()?.remotes ?? [];
		let request: GitWriteRequest | undefined;
		let body = "";
		let editable = false;
		if (action === "tag") {
			beginTagAdd(origin);
			return;
		}
		if (action === "push" || action === "push-force") {
			if (!branch) return;
			const upstreamRemote = branch.upstream?.split("/")[0];
			const remote = [upstreamRemote, "origin", remoteList[0]?.name].find(
				(name) => name && remoteList.some((entry) => entry.name === name),
			);
			if (!remote) {
				setMessage("No git remote is configured.");
				setError("No git remote is configured.");
				return;
			}
			if (action === "push-force") {
				if (!branch.upstream) {
					setMessage("Force push requires an upstream branch.");
					setError("Force push requires an upstream branch.");
					return;
				}
				request = { action, branch: branch.name, remote };
			} else {
				request = {
					action,
					branch: branch.name,
					remote,
					setUpstream: !branch.upstream,
				};
			}
		} else if (action === "rebase-abort") {
			request = { action };
		} else if (action === "tag-delete") {
			const tag = selectedTag();
			if (!tag) return;
			request = { action, name: tag.name };
		} else if (
			action === "stash-pop" ||
			action === "stash-apply" ||
			action === "stash-drop"
		) {
			const stash = selectedStash();
			if (!stash) return;
			request = { action, index: stash.index };
		} else if (action === "branch-rename") {
			if (!branch) return;
			request = { action, branch: branch.name, name: branch.name };
			body = branch.name;
			editable = true;
		} else if (action === "remote-set-url") {
			const remote = selectedRemote();
			if (!remote) return;
			request = { action, name: remote.name, url: remote.fetchUrl };
			body = remote.fetchUrl;
			editable = true;
		} else if (action === "commit" || action === "commit-all") {
			request = { action, message: "" };
			editable = true;
		} else if (action === "stash") {
			request = { action };
			editable = true;
		} else {
			if (!branch) return;
			if (branch.current) {
				setMessage("Select a different branch first.");
				setError("Select a different branch first.");
				return;
			}
			request = { action, branch: branch.name };
		}
		if (!request) return;
		await startGitWrite(request, origin, editable, body);
	};
	const previewGitWrite = async () => {
		const request = gitWriteRequest();
		const body = gitWriteBody().trim();
		if (!request) return;
		if (request.action === "tag" && !request.name) {
			setMessage("Tag name is required.");
			return;
		}
		if (
			(request.action === "commit" || request.action === "commit-all") &&
			!body
		) {
			setMessage("Commit message is required.");
			return;
		}
		if (
			request.action === "branch-rename" &&
			(!body || body === request.branch)
		) {
			setMessage("Enter a different branch name.");
			return;
		}
		if (request.action === "remote-set-url" && !body) {
			setMessage("Remote URL is required.");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const outcome = await gitWriteCall();
			if (!outcome || outcome.status !== "confirmation-required")
				throw new Error("invalid-response");
			clearMessage();
			setGitWriteDigest(outcome.digest);
			setGitWriteTarget(outcome.intent.target);
			setGitWriteStage("confirm");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const confirmGitWrite = async () => {
		const digest = gitWriteDigest();
		const app = selectedApp();
		if (!digest || !app) return;
		setBusy(true);
		setError(undefined);
		try {
			const outcome = await gitWriteCall(digest);
			if (!outcome || outcome.status === "confirmation-required")
				throw new Error("invalid-response");
			setGitWriteOutcome(outcome);
			setGitWriteStage("completed");
			if (outcome.outcome.status === "completed") {
				setMessage(`${outcome.outcome.action} completed`);
			} else {
				const text = gitReason(outcome.outcome.reason, outcome.outcome.status);
				setMessage(text);
				setError(text);
			}
			await Promise.all([
				loadBranches(app),
				loadWorktrees(app),
				loadRemotes(app),
			]);
			if (!sessionMode()) void loadGit([app.repository]);
			if (changes()) void refreshChanges();
			const action = gitWriteRequest()?.action;
			if (action === "tag" || action === "tag-delete") void refreshTags();
			if (
				action === "stash" ||
				action === "stash-pop" ||
				action === "stash-apply" ||
				action === "stash-drop"
			)
				void refreshStashes();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadChanges = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setChanges(await client.gitChanges(app.repository, sessionMode()));
			setChangeIndex(0);
			setDiff(undefined);
			setDiffSide("all");
			setView("changes");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const refreshChanges = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.gitChanges(app.repository, sessionMode());
			setChanges(next);
			setChangeIndex((current) =>
				Math.min(current, Math.max(0, next.changes.length - 1)),
			);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const openSelectedChange = async () => {
		const app = selectedApp();
		const change = selectedChange();
		if (!app || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			setDiff(
				await client.gitDiff(
					app.repository,
					change.path,
					diffSide(),
					sessionMode(),
				),
			);
			setView("diff");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const reloadDiff = async () => {
		const app = selectedApp();
		const current = diff();
		if (!app || !current) return;
		setBusy(true);
		setError(undefined);
		try {
			setDiff(
				await client.gitDiff(
					app.repository,
					current.path,
					diffSide(),
					sessionMode(),
				),
			);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const moveChange = (delta: number) => {
		const count = changes()?.changes.length ?? 0;
		if (!count) return;
		setChangeIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};

	const openTargets = (action: string) => {
		const app = selectedApp();
		if (!app) return;
		const targets = targetsFor(app, action);
		if (!targets.length) {
			setMessage(`No ${action} target configured for ${app.id}.`);
			return;
		}
		setTargetAction(action);
		setTargetIndex(0);
		if (targets.length === 1) {
			const target = targets[0];
			if (target) void executeTarget(action, target);
			return;
		}
		setView("targets");
	};

	const refreshOperation = async () => {
		const current = operation();
		if (!current) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.operation(current.id);
			setOperation(next);
			setMessage(`Operation ${next.state}`);
			if (next.state === "issued" && pollingId !== next.id)
				pollOperation(next.id);
			await loadHistory();
			await loadStatus();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			const result = await client.stop(app.id);
			setMessage(
				`Stopped ${result.stopped.length} resource${result.stopped.length === 1 ? "" : "s"}; ${result.remaining} remaining`,
			);
			await loadStatus();
			await loadHistory();
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadLogs = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setLogs(await client.logs(app.id, 200));
			setView("logs");
		} catch (reason) {
			const code = errorMessage(reason);
			const text =
				code === "operation-unavailable"
					? `No owned logs or retained output for ${app.id}.`
					: code;
			setError(text);
			setMessage(text);
		} finally {
			setBusy(false);
		}
	};

	const loadTelemetry = async (app: EnvironmentApp) => {
		setBusy(true);
		setError(undefined);
		try {
			setTelemetry(await client.telemetry(app.id));
			setTraceId(undefined);
			setTraceIndex(0);
			setView("telemetry");
		} catch (reason) {
			const code = errorMessage(reason);
			const text =
				code === "operation-unavailable"
					? `No telemetry captured for ${app.id}.`
					: code;
			setError(text);
			setMessage(text);
		} finally {
			setBusy(false);
		}
	};

	const openTrace = async (id: string) => {
		const app = selectedApp();
		if (!app) return;
		setBusy(true);
		setError(undefined);
		try {
			setTelemetry(await client.telemetry(app.id, id));
			setTraceId(id);
			setView("telemetry");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const openOperation = (
		next: OperationSummary,
		origin: "detail" | "history",
	) => {
		stopPolling();
		clearMessage();
		setProgress("");
		setOperationOrigin(origin);
		setOperation(next);
		setReceipt(null);
		setView("operation");
		if (next.hasResult || next.state === "issued") {
			void (async () => {
				try {
					const detail = await client.operation(next.id);
					setOperation(detail);
					if (detail.state === "issued") pollOperation(next.id);
				} catch (reason) {
					fail(reason);
				}
			})();
		}
	};

	const loadClusters = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.clusters();
			setClusters(next);
			setClusterIndex(0);
			setView("clusters");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const moveCluster = (delta: number) => {
		const count = clusters().length;
		if (!count) return;
		setClusterIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const setClusterNamespace = (value: string) => {
		setClusterNamespaceValue(value);
	};
	const beginClusterNamespace = () => {
		if (!selectedCluster()) return;
		if (!clusterNamespace().trim()) setClusterNamespaceValue("default");
		setClusterNamespaceFocused(true);
		setView("cluster-namespace");
	};
	const loadClusterResources = async (
		cluster = selectedCluster()?.id,
		namespace = clusterNamespace().trim(),
	) => {
		if (!cluster || !namespace) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.clusterResources(cluster, namespace);
			setClusterResources(next);
			setClusterResourceIndex(0);
			setClusterNamespaceFocused(false);
			setView("cluster-resources");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const moveClusterResource = (delta: number) => {
		const count = clusterResources()?.items.length ?? 0;
		if (!count) return;
		setClusterResourceIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const openClusterEvents = async () => {
		const current = clusterResources();
		if (!current) return;
		setBusy(true);
		setError(undefined);
		try {
			setClusterEvents(
				await client.clusterEvents(current.cluster, current.namespace),
			);
			setView("cluster-events");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openClusterDescribe = async (resource = selectedClusterResource()) => {
		const current = clusterResources();
		if (!current || !resource) return;
		setBusy(true);
		setError(undefined);
		try {
			setClusterDescribe(
				await client.clusterDescribe(
					current.cluster,
					current.namespace,
					resource.kind.toLowerCase(),
					resource.name,
				),
			);
			setView("cluster-describe");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openClusterPodLogs = async (resource = selectedClusterResource()) => {
		const current = clusterResources();
		if (!current || !resource) return;
		if (resource.kind !== "Pod") {
			setMessage("Pod logs are only available for pods.");
			setError("Pod logs are only available for pods.");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			setClusterPodLogs(
				await client.podLogs(
					current.cluster,
					current.namespace,
					resource.name,
					resource.containers?.[0],
				),
			);
			setView("cluster-pod-logs");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};

	const loadContainerStats = async () => {
		setBusy(true);
		setError(undefined);
		try {
			setContainerStats(await client.containerStats());
			setView("container-stats");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadProviders = async () => {
		setBusy(true);
		clearMessage();
		try {
			const next = await client.providers();
			setProviders(next);
			setProviderIndex(0);
			setProviderFilter("");
			setProviderDirect(false);
			setView("providers");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const moveProvider = (delta: number) => {
		const count = visibleProviders().length;
		if (!count) return;
		setProviderIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const setProviderFilter = (value: string) => {
		setProviderFilterValue(value);
		setProviderIndex(0);
		setProviderItemIndex(0);
	};
	const clearProviderFilter = () => {
		setProviderFilterValue("");
		setProviderItemIndex(0);
	};
	const beginProviderRepos = () => {
		const provider = selectedProvider();
		if (!provider) return;
		setProviderRepoQueryValue("");
		setProviderRepos([]);
		setProviderRepoIndex(0);
		setProviderRepo(undefined);
		setProviderDirect(false);
		setProviderRepoSearchFocused(false);
		setView("provider-repos");
		setMessage("Press / to search repositories.");
	};
	const searchProviderRepos = async () => {
		const provider = selectedProvider();
		const query = providerRepoQuery().trim();
		if (!provider || !query) return;
		setBusy(true);
		setError(undefined);
		try {
			const next = await client.providerRepositories(provider.name, query);
			setProviderRepos(next);
			setProviderRepoIndex(0);
			setProviderRepoSearchFocused(false);
			setView("provider-repos");
			setMessage(`${next.length} repositories`);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const moveProviderRepo = (delta: number) => {
		const count = providerRepos().length;
		if (!count) return;
		setProviderRepoIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
	};
	const selectProviderMatch = async (
		match: ProviderRepositoryMatch,
		kind: "changes" | "issues",
		label: string,
	) => {
		let list = providers();
		if (!list.length) {
			list = await client.providers();
			setProviders(list);
		}
		const index = list.findIndex(
			(provider) => provider.name === match.provider,
		);
		if (index < 0) {
			setMessage(`Provider ${match.provider} is not configured.`);
			return;
		}
		clearProviderFilter();
		setProviderIndex(index);
		setProviderState("open");
		const repository: ProviderRepository = {
			reference: match.reference,
			name: match.reference.split("/").at(-1) ?? match.reference,
			description: "",
			url: match.url,
		};
		setProviderRepo(repository);
		setProviderRepos([repository]);
		setProviderRepoIndex(0);
		setProviderDirect(true);
		if (kind === "changes") {
			setProviderChanges(
				await client.providerChanges(match.provider, match.reference, "open"),
			);
			setView("provider-changes");
		} else {
			setProviderIssues(
				await client.providerIssues(match.provider, match.reference, "open"),
			);
			setView("provider-issues");
		}
		setProviderItemIndex(0);
		setMessage(`${label} → ${match.provider} · ${match.reference}`);
	};
	const openAppProvider = async (kind: "changes" | "issues") => {
		const app = filteredApps()[selectedIndex()] ?? selectedApp();
		if (!app) return;
		setBusy(true);
		clearMessage();
		try {
			const matches = await client.providerRepository(app.repository);
			const match = matches[0];
			if (!match) {
				setMessage(`No configured provider matches ${app.id}'s git remotes.`);
				return;
			}
			await selectProviderMatch(match, kind, app.id);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadSessionProvider = async (
		directory: string,
		kind: "changes" | "issues",
	) => {
		setBusy(true);
		clearMessage();
		try {
			const matches = await client.providerRepository(directory, true);
			const match = matches[0];
			if (!match) {
				setView("table");
				setMessage("No configured provider matches this repository's remotes.");
				return;
			}
			await selectProviderMatch(match, kind, basename(directory) || directory);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderRepo = async (
		repository = selectedProviderRepository(),
	) => {
		const provider = selectedProvider();
		if (!provider || !repository) return;
		setProviderRepo(repository);
		setProviderDirect(false);
		setProviderState("open");
		await loadProviderChanges("open");
	};
	const loadProviderChanges = async (
		state: "open" | "closed" | "all" = providerState(),
	) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderChanges(
				await client.providerChanges(
					provider.name,
					repository.reference,
					state,
				),
			);
			setProviderChangeDetail(undefined);
			setProviderState(state);
			setProviderItemIndex(0);
			clearProviderFilter();
			setView("provider-changes");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadProviderIssues = async (
		state: "open" | "closed" | "all" = providerState(),
	) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderIssues(
				await client.providerIssues(provider.name, repository.reference, state),
			);
			setProviderIssueDetail(undefined);
			setProviderState(state);
			setProviderItemIndex(0);
			clearProviderFilter();
			setView("provider-issues");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadProviderPipelines = async () => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderPipelines(
				await client.providerPipelines(provider.name, repository.reference),
			);
			setProviderItemIndex(0);
			clearProviderFilter();
			setView("provider-pipelines");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderJobs = async (pipeline = selectedProviderPipeline()) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository || !pipeline) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderPipeline(pipeline);
			setProviderJobs(
				await client.providerJobs(
					provider.name,
					repository.reference,
					pipeline.id,
				),
			);
			setProviderItemIndex(0);
			clearProviderFilter();
			setView("provider-jobs");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const cycleProviderState = () => {
		const next =
			providerState() === "open"
				? "closed"
				: providerState() === "closed"
					? "all"
					: "open";
		if (view() === "provider-changes") void loadProviderChanges(next);
		else if (view() === "provider-issues") void loadProviderIssues(next);
		else setProviderState(next);
	};
	const moveProviderItem = (delta: number) => {
		const count =
			view() === "provider-changes"
				? visibleProviderChanges().length
				: view() === "provider-issues"
					? visibleProviderIssues().length
					: view() === "provider-pipelines"
						? visibleProviderPipelines().length
						: view() === "provider-jobs"
							? visibleProviderJobs().length
							: view() === "provider-change-files"
								? (providerFiles()?.files.length ?? 0)
								: view() === "provider-change-discussions"
									? providerDiscussions().length
									: view() === "provider-versions"
										? providerVersions().length
										: view() === "provider-issue-comments"
											? providerIssueComments().length
											: 0;
		if (!count) return;
		setProviderItemIndex((current) =>
			Math.min(count - 1, Math.max(0, current + delta)),
		);
		if (view() === "provider-changes") setProviderChangeDetail(undefined);
		if (view() === "provider-issues") setProviderIssueDetail(undefined);
	};
	const openProviderChange = async (change = selectedProviderChange()) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			const detail = await client.providerChange(
				provider.name,
				repository.reference,
				change.number,
			);
			if (!detail) throw new Error("provider-invalid");
			setProviderChangeDetail(detail);
			setView("provider-change");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderIssue = async (issue = selectedProviderIssue()) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository || !issue) return;
		setBusy(true);
		setError(undefined);
		try {
			const detail = await client.providerIssue(
				provider.name,
				repository.reference,
				issue.number,
			);
			if (!detail) throw new Error("provider-invalid");
			setProviderIssueDetail(detail);
			setView("provider-issue");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderIssueComments = async () => {
		const provider = selectedProvider();
		const repository = providerRepo();
		const issue = providerIssueDetail() ?? selectedProviderIssue();
		if (!provider || !repository || !issue) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderIssueComments(
				await client.providerIssueComments(
					provider.name,
					repository.reference,
					issue.number,
				),
			);
			setProviderItemIndex(0);
			setView("provider-issue-comments");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderVersions = async () => {
		const provider = selectedProvider();
		const repository = providerRepo();
		const change = providerChangeDetail() ?? selectedProviderChange();
		if (!provider || !repository || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderVersions(
				await client.providerChangeVersions(
					provider.name,
					repository.reference,
					change.number,
				),
			);
			setProviderItemIndex(0);
			setView("provider-versions");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderChangeFiles = async () => {
		const provider = selectedProvider();
		const repository = providerRepo();
		const change = providerChangeDetail() ?? selectedProviderChange();
		if (!provider || !repository || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderFiles(
				await client.providerChangeFiles(
					provider.name,
					repository.reference,
					change.number,
				),
			);
			setProviderItemIndex(0);
			clearProviderFilter();
			setView("provider-change-files");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderDiscussions = async () => {
		const provider = selectedProvider();
		const repository = providerRepo();
		const change = providerChangeDetail() ?? selectedProviderChange();
		if (!provider || !repository || !change) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderDiscussions(
				await client.providerDiscussions(
					provider.name,
					repository.reference,
					change.number,
				),
			);
			setProviderItemIndex(0);
			setView("provider-change-discussions");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openProviderFile = (file = selectedProviderFile()) => {
		if (!file) return;
		setProviderFile(file);
		setView("provider-file");
	};
	const openProviderJobLogs = async (job = selectedProviderJob()) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		if (!provider || !repository || !job) return;
		setBusy(true);
		setError(undefined);
		try {
			setProviderJobLogs(
				await client.providerJobLogs(
					provider.name,
					repository.reference,
					job.id,
				),
			);
			setProviderLogJob(job.id);
			setView("provider-job-logs");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const providerWriteCall = async (confirm?: string) => {
		const provider = selectedProvider();
		const repository = providerRepo();
		const action = providerWriteAction();
		if (!provider || !repository || !action) return undefined;
		const requestId = providerWriteRequestId();
		if (action === "comment-change" || action === "comment-issue") {
			const change = providerChangeDetail();
			const issue = providerIssueDetail();
			const number =
				action === "comment-change" ? change?.number : issue?.number;
			if (!number) return undefined;
			return action === "comment-change"
				? await client.providerCommentChange(
						provider.name,
						repository.reference,
						number,
						providerWriteBody(),
						requestId,
						confirm,
					)
				: await client.providerCommentIssue(
						provider.name,
						repository.reference,
						number,
						providerWriteBody(),
						requestId,
						confirm,
					);
		}
		const writeScope = providerWriteOrigin().includes("issue")
			? ("issue" as const)
			: ("change" as const);
		const writeNumber = () =>
			writeScope === "issue"
				? (providerIssueDetail()?.number ?? selectedProviderIssue()?.number)
				: (providerChangeDetail()?.number ?? selectedProviderChange()?.number);
		const writeList = () =>
			providerWriteBody()
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
		if (action === "unapprove-change") {
			const change = providerChangeDetail();
			if (!change?.number || !change.headSha) return undefined;
			return await client.providerUnapproveChange(
				provider.name,
				repository.reference,
				change.number,
				change.headSha,
				requestId,
				confirm,
			);
		}
		if (action === "reply-discussion") {
			const number = writeNumber();
			const discussion = selectedProviderDiscussion();
			const discussionId = discussion?.threadId ?? discussion?.id;
			if (!number || !discussionId) return undefined;
			return await client.providerReplyDiscussion(
				provider.name,
				repository.reference,
				number,
				writeScope,
				discussionId,
				providerWriteBody(),
				requestId,
				confirm,
			);
		}
		if (action === "set-discussion-resolved") {
			const number = writeNumber();
			const discussion = selectedProviderDiscussion();
			const discussionId = discussion?.threadId ?? discussion?.id;
			if (!number || !discussionId) return undefined;
			return await client.providerSetDiscussionResolved(
				provider.name,
				repository.reference,
				number,
				discussionId,
				!discussion.resolved,
				requestId,
				confirm,
			);
		}
		if (action === "add-labels" || action === "set-assignees") {
			const number = writeNumber();
			if (!number) return undefined;
			return action === "add-labels"
				? await client.providerAddLabels(
						provider.name,
						repository.reference,
						number,
						writeScope,
						writeList(),
						requestId,
						confirm,
					)
				: await client.providerSetAssignees(
						provider.name,
						repository.reference,
						number,
						writeScope,
						writeList(),
						requestId,
						confirm,
					);
		}
		if (action === "retry-job") {
			const job = selectedProviderJob()?.id;
			if (!job) return undefined;
			return await client.providerRetryJob(
				provider.name,
				repository.reference,
				job,
				requestId,
				confirm,
			);
		}
		if (action === "approve-change" || action === "merge-change") {
			const change = providerChangeDetail();
			if (!change?.number || !change.headSha) return undefined;
			return action === "approve-change"
				? await client.providerApproveChange(
						provider.name,
						repository.reference,
						change.number,
						change.headSha,
						requestId,
						confirm,
					)
				: await client.providerMergeChange(
						provider.name,
						repository.reference,
						change.number,
						change.headSha,
						"merge",
						requestId,
						confirm,
					);
		}
		if (action === "set-issue-state") {
			const issue = providerIssueDetail() ?? selectedProviderIssue();
			if (!issue) return undefined;
			return await client.providerSetIssueState(
				provider.name,
				repository.reference,
				issue.number,
				issue.state === "closed" ? "open" : "closed",
				requestId,
				confirm,
			);
		}
		if (action === "rebase-change") {
			const change = providerChangeDetail();
			if (!change?.number) return undefined;
			return await client.providerRebaseChange(
				provider.name,
				repository.reference,
				change.number,
				requestId,
				confirm,
			);
		}
		const pipeline = providerPipeline()?.id ?? selectedProviderPipeline()?.id;
		if (!pipeline) return undefined;
		return action === "retry-pipeline"
			? await client.providerRetryPipeline(
					provider.name,
					repository.reference,
					pipeline,
					requestId,
					confirm,
				)
			: await client.providerCancelPipeline(
					provider.name,
					repository.reference,
					pipeline,
					requestId,
					confirm,
				);
	};
	const beginProviderWrite = async (
		action: ProviderWriteAction,
		origin: EnvironmentView,
	) => {
		if (!selectedProvider() || !providerRepo()) return;
		clearMessage();
		setProviderWriteAction(action);
		setProviderWriteOrigin(origin);
		setProviderWriteBody("");
		setProviderWriteRequestId(crypto.randomUUID());
		setProviderWriteDigest(undefined);
		setProviderWriteReceipt(undefined);
		const needsBody =
			action === "comment-change" ||
			action === "comment-issue" ||
			action === "reply-discussion" ||
			action === "add-labels" ||
			action === "set-assignees";
		setProviderWriteStage(needsBody ? "edit" : "confirm");
		setView("provider-write");
		if (needsBody) return;
		if (
			(action === "approve-change" ||
				action === "merge-change" ||
				action === "unapprove-change") &&
			!providerChangeDetail()?.headSha
		) {
			fail("provider-head-changed");
			return;
		}
		await previewProviderWrite();
	};
	const previewProviderWrite = async () => {
		const action = providerWriteAction();
		if (
			(action === "comment-change" ||
				action === "comment-issue" ||
				action === "reply-discussion") &&
			!providerWriteBody().trim()
		) {
			setMessage("Comment body is required.");
			return;
		}
		if (
			(action === "add-labels" || action === "set-assignees") &&
			providerWriteBody()
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean).length === 0
		) {
			setMessage("At least one comma-separated value is required.");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const outcome = await providerWriteCall();
			if (!outcome) throw new Error("provider-invalid");
			if (outcome.status !== "confirmation-required")
				throw new Error("provider-invalid");
			clearMessage();
			setProviderWriteDigest(outcome.digest);
			setProviderWriteStage("confirm");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const confirmProviderWrite = async () => {
		const digest = providerWriteDigest();
		if (!digest) return;
		setBusy(true);
		setError(undefined);
		try {
			const outcome = await providerWriteCall(digest);
			if (!outcome || outcome.status === "confirmation-required")
				throw new Error("provider-write-unavailable");
			setProviderWriteReceipt(outcome.receipt);
			setProviderWriteStage("completed");
			setMessage(`${outcome.receipt.action} ${outcome.receipt.state}`);
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const loadProviderWrites = async () => {
		setBusy(true);
		setError(undefined);
		try {
			setProviderWrites(await client.providerWrites(selectedProvider()?.name));
			setView("provider-writes");
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const openSelectedProviderRepo = () => {
		if (providerRepoSearchFocused()) void searchProviderRepos();
		else void openProviderRepo();
	};

	const configFieldCount = () => {
		const action = configAction();
		if (action === "app-create") return 3;
		if (action === "app-edit") return 2;
		if (action === "target-duplicate") return 2;
		if (action === "target-shell") return 5;
		if (action === "target-edit")
			return configSource()?.runtime === "shell" ||
				configSource()?.runtime === "systemshell"
				? 4
				: 2;
		return 0;
	};
	const cycleConfigField = () => {
		const count = configFieldCount();
		if (count) setConfigField((current) => (current + 1) % count);
	};
	const beginAppCreate = () => {
		setConfigAction("app-create");
		setConfigStage("edit");
		setConfigOrigin("table");
		setConfigField(0);
		setConfigId("");
		setConfigKind("app");
		setConfigRepository(repositories()[0] ?? selectedApp()?.repository ?? "");
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
	};
	const beginAppEdit = () => {
		const app = selectedApp();
		if (!app) return;
		setConfigAction("app-edit");
		setConfigStage("edit");
		setConfigOrigin("detail");
		setConfigField(0);
		setConfigId(app.id);
		setConfigKind(
			app.kind === "library" || app.kind === "infrastructure"
				? app.kind
				: "app",
		);
		setConfigRepository(app.repository);
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
	};
	const beginAppDelete = () => {
		const app = selectedApp();
		if (!app) return;
		setConfigAction("app-delete");
		setConfigStage("confirm");
		setConfigOrigin("table");
		setConfigField(0);
		setConfigId(app.id);
		setConfigDeleteTargets(false);
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
		void previewConfigWrite();
	};
	const beginTargetDuplicate = () => {
		const app = selectedApp();
		const target = selectedTarget();
		if (!app || !target) return;
		setConfigAction("target-duplicate");
		setConfigStage("edit");
		setConfigOrigin("targets");
		setConfigField(0);
		setConfigId(`${target.id}-copy`);
		setConfigProfile(target.profile ?? "");
		setConfigSource({
			app: app.id,
			target: target.id,
			runtime: target.runtime,
		});
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
	};
	const beginTargetShellCreate = () => {
		const app = selectedApp();
		if (!app) return;
		setConfigAction("target-shell");
		setConfigStage("edit");
		setConfigOrigin("targets");
		setConfigField(0);
		setConfigId("");
		setConfigProfile("");
		setConfigTargetAction("build");
		setConfigCommand("");
		setConfigTimeout("");
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
	};
	const beginTargetEdit = () => {
		const app = selectedApp();
		const target = selectedTarget();
		if (!app || !target) return;
		setConfigAction("target-edit");
		setConfigStage("edit");
		setConfigOrigin("targets");
		setConfigField(0);
		setConfigId(target.id);
		setConfigProfile(target.profile ?? "");
		setConfigTargetAction(target.action);
		setConfigCommand("");
		setConfigTimeout("");
		setConfigSource({
			app: app.id,
			target: target.id,
			runtime: target.runtime,
		});
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
	};
	const beginTargetDelete = () => {
		const app = selectedApp();
		const target = selectedTarget();
		if (!app || !target) return;
		setConfigAction("target-delete");
		setConfigStage("confirm");
		setConfigOrigin("targets");
		setConfigField(0);
		setConfigId(target.id);
		setConfigSource({
			app: app.id,
			target: target.id,
			runtime: target.runtime,
		});
		setConfigPreview(undefined);
		setConfigResult(undefined);
		setView("config-write");
		void previewConfigWrite();
	};
	const configMutationCall = async (
		expectedDigest?: string,
		confirm?: string,
	) => {
		const action = configAction();
		const kind = configKind() as "app" | "library" | "infrastructure";
		const repository = configRepository().trim();
		const id = configId().trim();
		const profile = configProfile().trim();
		const targetAction = configTargetAction() as "build" | "test" | "run";
		const command = configCommand();
		const timeout = Number(configTimeout());
		const timeoutSec =
			configTimeout().trim() && Number.isFinite(timeout) && timeout > 0
				? Math.floor(timeout)
				: undefined;
		const source = configSource();
		if (action === "app-create")
			return await client.appCreate(
				{ id, kind, repository },
				expectedDigest,
				confirm,
			);
		if (action === "app-edit")
			return await client.appUpdate(
				{ id, kind, repository },
				expectedDigest,
				confirm,
			);
		if (action === "app-delete")
			return await client.appDelete(
				{ id, deleteTargets: configDeleteTargets() },
				expectedDigest,
				confirm,
			);
		if (action === "target-duplicate") {
			if (!source) return undefined;
			return await client.targetDuplicate(
				{
					app: source.app,
					sourceApp: source.app,
					sourceTarget: source.target,
					id,
					...(profile ? { profile } : {}),
				},
				expectedDigest,
				confirm,
			);
		}
		if (action === "target-shell") {
			const app = selectedApp();
			if (!app) return undefined;
			return await client.targetShellCreate(
				{
					app: app.id,
					id,
					action: targetAction,
					command,
					...(profile ? { profile } : {}),
					...(timeoutSec ? { timeoutSec } : {}),
				},
				expectedDigest,
				confirm,
			);
		}
		if (!source) return undefined;
		if (action === "target-edit") {
			return await client.targetUpdate(
				{
					app: source.app,
					id: source.target,
					profile: profile || null,
					action: targetAction,
					...(command.trim() ? { command } : {}),
					...(timeoutSec ? { timeoutSec } : {}),
				},
				expectedDigest,
				confirm,
			);
		}
		return await client.targetDelete(
			{ app: source.app, id: source.target },
			expectedDigest,
			confirm,
		);
	};
	const previewConfigWrite = async () => {
		setBusy(true);
		clearMessage();
		try {
			const result = await configMutationCall();
			if (!result) throw new Error("config-invalid");
			if (result.status === "confirmation-required") {
				setConfigPreview(result);
				setConfigStage("confirm");
			} else {
				setConfigResult(result);
				setConfigStage("completed");
			}
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const confirmConfigWrite = async () => {
		const preview = configPreview();
		if (!preview) return;
		setBusy(true);
		clearMessage();
		try {
			const result = await configMutationCall(
				preview.expectedDigest,
				preview.confirm,
			);
			if (!result) throw new Error("config-invalid");
			if (result.status === "confirmation-required") {
				setConfigPreview(result);
				setConfigStage("confirm");
			} else {
				setConfigResult(result);
				setConfigStage("completed");
				setMessage(result.summary);
				void load();
			}
		} catch (reason) {
			fail(reason);
		} finally {
			setBusy(false);
		}
	};
	const toggleConfigDeleteTargets = () =>
		setConfigDeleteTargets((current) => !current);

	const openSelected = () => {
		if (view() === "table") {
			const app = filteredApps()[selectedIndex()];
			if (app) openApp(app);
			return;
		}
		if (view() === "targets") {
			const target = selectedTarget();
			if (target) void executeTarget(targetAction(), target);
			return;
		}
		if (view() === "history") {
			const next = selectedOperation();
			if (next) openOperation(next, "history");
			return;
		}
		if (view() === "telemetry") {
			const trace = selectedTrace();
			if (trace) void openTrace(trace.traceId);
		}
	};

	const back = () => {
		if (view() === "table") return false;
		if (view() === "detail") {
			setView("table");
			return true;
		}
		if (view() === "targets" || view() === "logs" || view() === "telemetry") {
			setView("detail");
			return true;
		}
		if (view() === "changes") {
			setView(sessionMode() ? "git" : "detail");
			return true;
		}
		if (view() === "diff") {
			setView("changes");
			return true;
		}
		if (view() === "git") {
			setView("detail");
			return true;
		}
		if (view() === "git-write") {
			setView(gitWriteOrigin());
			return true;
		}
		if (view() === "tag-add") {
			setView(tagOrigin());
			return true;
		}
		if (view() === "tags" || view() === "stashes") {
			setView("git");
			return true;
		}
		if (view() === "worktrees") {
			setView("git");
			return true;
		}
		if (view() === "worktree-add") {
			setView("worktrees");
			return true;
		}
		if (view() === "remotes") {
			setView("git");
			return true;
		}
		if (view() === "remote-add") {
			setView("remotes");
			return true;
		}
		if (view() === "container-stats") {
			setView("detail");
			return true;
		}
		if (view() === "config-write") {
			setView(configOrigin());
			return true;
		}
		if (view() === "clusters") {
			setView("table");
			return true;
		}
		if (view() === "cluster-namespace") {
			setClusterNamespaceFocused(false);
			setView("clusters");
			return true;
		}
		if (view() === "cluster-resources") {
			setView("clusters");
			return true;
		}
		if (
			view() === "cluster-events" ||
			view() === "cluster-describe" ||
			view() === "cluster-pod-logs"
		) {
			setView("cluster-resources");
			return true;
		}
		if (view() === "providers") {
			setView("table");
			return true;
		}
		if (view() === "provider-repos") {
			setView("providers");
			return true;
		}
		if (view() === "provider-changes" || view() === "provider-issues") {
			setView(providerDirect() ? "table" : "provider-repos");
			return true;
		}
		if (view() === "provider-pipelines") {
			setView("provider-repos");
			return true;
		}
		if (view() === "provider-jobs") {
			setView("provider-pipelines");
			return true;
		}
		if (view() === "provider-change") {
			setView("provider-changes");
			return true;
		}
		if (view() === "provider-change-files") {
			setView("provider-change");
			return true;
		}
		if (view() === "provider-file") {
			setView("provider-change-files");
			return true;
		}
		if (view() === "provider-change-discussions") {
			setView("provider-change");
			return true;
		}
		if (view() === "provider-versions") {
			setView("provider-change");
			return true;
		}
		if (view() === "provider-issue") {
			setView("provider-issues");
			return true;
		}
		if (view() === "provider-issue-comments") {
			setView("provider-issue");
			return true;
		}
		if (view() === "provider-job-logs") {
			setView("provider-jobs");
			return true;
		}
		if (view() === "provider-write") {
			setView(providerWriteOrigin());
			return true;
		}
		if (view() === "provider-writes") {
			setView("providers");
			return true;
		}
		if (view() === "operation") {
			stopPolling();
			setView(operationOrigin() === "history" ? "history" : "detail");
			return true;
		}
		if (view() === "history" || view() === "services") {
			setTab("applications");
			setView("table");
			return true;
		}
		return false;
	};

	const refresh = async () => {
		if (view() === "clusters") {
			await loadClusters();
			return;
		}
		if (view() === "cluster-resources") {
			const current = clusterResources();
			if (current)
				await loadClusterResources(current.cluster, current.namespace);
			return;
		}
		if (view() === "cluster-events") {
			await openClusterEvents();
			return;
		}
		if (view() === "cluster-describe") {
			const current = clusterDescribe();
			const resource = selectedClusterResource();
			if (current && resource)
				await openClusterDescribe({
					...resource,
					kind: current.kind,
					name: current.name,
				});
			return;
		}
		if (view() === "cluster-pod-logs") {
			const current = clusterPodLogs();
			if (current) {
				setBusy(true);
				setError(undefined);
				try {
					setClusterPodLogs(
						await client.podLogs(
							current.cluster,
							current.namespace,
							current.pod,
							current.container,
						),
					);
				} catch (reason) {
					fail(reason);
				} finally {
					setBusy(false);
				}
			}
			return;
		}
		if (view() === "tags") {
			await loadTags();
			return;
		}
		if (view() === "stashes") {
			await loadStashes();
			return;
		}
		if (view() === "container-stats") {
			await loadContainerStats();
			return;
		}
		if (view() === "providers") {
			await loadProviders();
			return;
		}
		if (view() === "provider-repos") {
			if (providerRepoQuery().trim()) await searchProviderRepos();
			return;
		}
		if (view() === "provider-changes") {
			await loadProviderChanges();
			return;
		}
		if (view() === "provider-issues") {
			await loadProviderIssues();
			return;
		}
		if (view() === "provider-pipelines") {
			await loadProviderPipelines();
			return;
		}
		if (view() === "provider-jobs") {
			const pipeline = providerPipeline();
			if (pipeline) await openProviderJobs(pipeline);
			return;
		}
		if (view() === "provider-change") {
			const current = providerChangeDetail();
			if (current) await openProviderChange(current);
			return;
		}
		if (view() === "provider-change-files") {
			await openProviderChangeFiles();
			return;
		}
		if (view() === "provider-change-discussions") {
			await openProviderDiscussions();
			return;
		}
		if (view() === "provider-versions") {
			await openProviderVersions();
			return;
		}
		if (view() === "provider-issue") {
			const current = providerIssueDetail();
			if (current) await openProviderIssue(current);
			return;
		}
		if (view() === "provider-issue-comments") {
			await openProviderIssueComments();
			return;
		}
		if (view() === "provider-writes") {
			await loadProviderWrites();
			return;
		}
		if (view() === "provider-job-logs") {
			const job = providerLogJob();
			const current = selectedProviderJob();
			if (current && current.id === job) await openProviderJobLogs(current);
			else if (job)
				await openProviderJobLogs({
					id: job,
					name: "",
					status: "",
					url: "",
				});
			return;
		}
		if (view() === "changes") {
			await refreshChanges();
			return;
		}
		if (view() === "diff") {
			await reloadDiff();
			return;
		}
		if (view() === "git" || view() === "worktrees" || view() === "remotes") {
			const app = selectedApp();
			if (app) {
				await Promise.all([
					loadBranches(app),
					loadWorktrees(app),
					loadRemotes(app),
					...(sessionMode() ? [] : [loadGit([app.repository])]),
				]);
			}
			return;
		}
		if (view() === "logs") {
			const app = selectedApp();
			if (app) await loadLogs(app);
			return;
		}
		if (view() === "telemetry") {
			const app = selectedApp();
			if (app) await loadTelemetry(app);
			return;
		}
		if (view() === "operation") {
			await refreshOperation();
			return;
		}
		await load();
	};

	const subjectFor = (next: OperationSummary | undefined) =>
		next?.subject ?? (next ? subjects.get(next.id) : undefined);
	const operationSubject = () => subjectFor(operation());

	return {
		apps,
		services,
		containerStats,
		clusters,
		clusterIndex,
		configAction,
		configStage,
		configField,
		configId,
		configKind,
		configRepository,
		configProfile,
		configTargetAction,
		configCommand,
		configTimeout,
		configDeleteTargets,
		configSource,
		configPreview,
		configResult,
		beginAppCreate,
		beginAppEdit,
		beginAppDelete,
		beginTargetDuplicate,
		beginTargetShellCreate,
		beginTargetEdit,
		beginTargetDelete,
		previewConfigWrite,
		confirmConfigWrite,
		cycleConfigField,
		toggleConfigDeleteTargets,
		setConfigId,
		setConfigKind,
		setConfigRepository,
		setConfigProfile,
		setConfigTargetAction,
		setConfigCommand,
		setConfigTimeout,
		setConfigField,
		setConfigStage,
		clusterNamespace,
		clusterNamespaceFocused,
		clusterResources,
		clusterResourceIndex,
		setClusterResourceIndex,
		selectedClusterResource,
		clusterEvents,
		clusterDescribe,
		clusterPodLogs,
		selectedCluster,
		repositories,
		status,
		git,
		branches,
		branchIndex,
		branchQuery,
		branchSearchFocused,
		filteredBranches,
		setBranchQuery,
		setBranchSearchFocused,
		worktrees,
		worktreeIndex,
		worktreePath,
		setWorktreePath,
		worktreeBranch,
		setWorktreeBranch,
		updateWorktreeBranch,
		worktreeField,
		remotes,
		remoteIndex,
		remoteName,
		remoteUrl,
		remoteField,
		selectedRemote,
		diffSide,
		gitOutcome,
		gitWriteRequest,
		gitWriteBody,
		gitWriteStage,
		gitWriteDigest,
		gitWriteTarget,
		gitWriteOutcome,
		tags,
		tagIndex,
		setTagIndex,
		selectedTag,
		stashes,
		stashIndex,
		setStashIndex,
		selectedStash,
		tagName,
		tagMessage,
		tagField,
		setTagName,
		setTagMessage,
		setTagField,
		setGitWriteBody,
		beginGitWrite,
		beginTagAdd,
		cycleTagField,
		submitTagAdd,
		deleteSelectedTag,
		beginStashWrite,
		loadTags,
		loadStashes,
		moveTag,
		moveStash,
		toggleStageSelectedChange,
		stageAllChanges,
		unstageAllChanges,
		previewGitWrite,
		confirmGitWrite,
		sessionMode,
		executionWorktree,
		providers,
		providerIndex,
		providerFilter,
		providerFilterFocused,
		providerRepoQuery,
		providerRepoSearchFocused,
		providerRepos,
		providerRepoIndex,
		providerRepo,
		providerState,
		providerChanges,
		providerIssues,
		providerPipelines,
		providerJobs,
		providerPipeline,
		providerItemIndex,
		visibleProviders,
		visibleProviderChanges,
		visibleProviderIssues,
		visibleProviderPipelines,
		visibleProviderJobs,
		selectedProvider,
		selectedProviderRepository,
		selectedProviderChange,
		selectedProviderIssue,
		selectedProviderPipeline,
		selectedProviderJob,
		selectedProviderFile,
		selectedProviderDiscussion,
		providerChangeDetail,
		providerFiles,
		providerDiscussions,
		providerIssueDetail,
		providerJobLogs,
		providerIssueComments,
		providerVersions,
		providerFile,
		providerLogJob,
		providerWrites,
		providerWriteAction,
		providerWriteBody,
		providerWriteRequestId,
		providerWriteDigest,
		providerWriteStage,
		providerWriteReceipt,
		providerWriteOrigin,
		selectedBranch,
		selectedWorktree,
		changes,
		changeIndex,
		diff,
		selectedChange,
		activeApps,
		operations,
		operationTotal,
		operation,
		progress,
		receipt,
		logs,
		telemetry,
		traceId,
		tab,
		view,
		selectedIndex,
		selectedAppId,
		targetAction,
		targetIndex,
		historyIndex,
		traceIndex,
		query,
		searchFocused,
		message,
		error,
		busy,
		counts,
		tabApps,
		filteredApps,
		selectedApp,
		targetList,
		selectedTarget,
		owned,
		selectedOwned,
		selectedOperation,
		selectedTrace,
		scope,
		appTotal,
		load,
		loadClusters,
		moveCluster,
		beginClusterNamespace,
		loadClusterResources,
		moveClusterResource,
		openClusterEvents,
		openClusterDescribe,
		openClusterPodLogs,
		setClusterNamespace,
		setClusterNamespaceFocused,
		setClusterIndex,
		loadContainerStats,
		loadProviders,
		moveProvider,
		setProviderFilter,
		setProviderFilterFocused,
		beginProviderRepos,
		searchProviderRepos,
		moveProviderRepo,
		openProviderRepo,
		openAppProvider,
		loadSessionProvider,
		loadProviderChanges,
		loadProviderIssues,
		loadProviderPipelines,
		openProviderJobs,
		openProviderChange,
		openProviderIssue,
		openProviderChangeFiles,
		openProviderDiscussions,
		openProviderIssueComments,
		openProviderVersions,
		openProviderFile,
		openProviderJobLogs,
		beginProviderWrite,
		previewProviderWrite,
		confirmProviderWrite,
		loadProviderWrites,
		setProviderWriteBody,
		cycleProviderState,
		moveProviderItem,
		openSelectedProviderRepo,
		setProviderIndex,
		setProviderRepoIndex,
		setProviderRepoQuery: setProviderRepoQueryValue,
		setProviderRepoSearchFocused,
		setProviderItemIndex,
		startLiveRefresh,
		stopLiveRefresh,
		handleEvent,
		loadStatus,
		loadHistory,
		selectTab,
		cycleTab,
		move,
		openApp,
		loadGitView,
		loadSessionGit,
		endSessionGit,
		fetchGit,
		pullGit,
		checkoutBranch,
		deleteSelectedBranch,
		beginRemoteAdd,
		submitRemoteAdd,
		removeSelectedRemote,
		cycleRemoteField,
		moveRemote,
		moveBranch,
		moveWorktree,
		useSelectedWorktree,
		clearWorktreeExecution,
		beginWorktreeAdd,
		submitWorktreeAdd,
		cycleWorktreeField,
		cycleDiffSide,
		removeSelectedWorktree,
		loadChanges,
		refreshChanges,
		openSelectedChange,
		reloadDiff,
		moveChange,
		setChangeIndex,
		setBranchIndex,
		setWorktreeIndex,
		setRemoteIndex,
		setRemoteName,
		setRemoteUrl,
		openTargets,
		executeTarget,
		refreshOperation,
		stop,
		loadLogs,
		loadTelemetry,
		openTrace,
		openOperation,
		openSelected,
		back,
		refresh,
		subjectFor,
		operationSubject,
		setSelectedIndex,
		setSelectedAppId,
		setHistoryIndex,
		setTargetIndex,
		setTraceIndex,
		setQuery,
		setSearchFocused,
		setMessage,
		setError,
		setView,
		defaultTarget,
		shortId,
	};
}

export type EnvironmentStore = ReturnType<typeof createEnvironmentStore>;
