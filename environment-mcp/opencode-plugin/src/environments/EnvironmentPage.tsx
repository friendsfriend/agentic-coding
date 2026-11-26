/** @jsxImportSource @opentui/solid */
import type { InputRenderable } from "@opentui/core";
import {
	createEffect,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	createEnvironmentApi,
	createEnvironmentEvents,
	errorMessage,
	failingApi,
} from "../client.ts";
import type { Context, PanelInput, Theme } from "../opencode-types.ts";
import { EnvironmentMcpClient } from "./client.ts";
import { type EnvironmentTab, TAB_LABELS, TAB_ORDER } from "./model.ts";
import {
	takeSessionGitRequest,
	takeSessionProviderRequest,
} from "./session.ts";
import { createEnvironmentStore } from "./store.ts";
import {
	AppDetail,
	AppTable,
	ChangesView,
	ClusterDescribeView,
	ClusterEventsView,
	ClusterNamespaceView,
	ClusterPodContainersView,
	ClusterPodLogsView,
	ClusterResourcesView,
	ClustersView,
	ConfigWriteView,
	ContainerStatsView,
	DiffView,
	GitCommitView,
	GitLogView,
	GitView,
	GitWriteView,
	HelpDialog,
	HistoryView,
	LogsView,
	OperationView,
	ProviderChangesView,
	ProviderChangeView,
	ProviderDiscussionsView,
	ProviderFilesView,
	ProviderFileView,
	ProviderIssuesView,
	ProviderIssueView,
	ProviderJobLogsView,
	ProviderJobsView,
	ProviderMergeView,
	ProviderPipelinesView,
	ProviderReposView,
	ProvidersView,
	ProviderVersionsView,
	ProviderWritesView,
	ProviderWriteView,
	RemoteAddView,
	RemotesView,
	ServicesView,
	StashesView,
	StatusBar,
	TagAddView,
	TagsView,
	TargetPicker,
	TelemetryView,
	WorktreeAddView,
	WorktreesView,
} from "./views.tsx";

function Header(props: {
	theme: Theme;
	tab: EnvironmentTab;
	counts: Readonly<Record<EnvironmentTab, number>>;
	historyCount: number;
	serviceCount: number;
	scope: string;
	apps: number;
	owned: number;
	compact: boolean;
	onSelect(tab: EnvironmentTab): void;
}) {
	const count = (tab: EnvironmentTab) =>
		tab === "history"
			? props.historyCount
			: tab === "services"
				? props.serviceCount
				: props.counts[tab];
	const label = (tab: EnvironmentTab) =>
		props.compact
			? (
					{
						applications: "Apps",
						libraries: "Libs",
						infrastructure: "Infra",
						history: "Hist",
						services: "Svc",
					} as const
				)[tab]
			: TAB_LABELS[tab];
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={props.compact ? 1 : 2}
			paddingRight={props.compact ? 1 : 2}
			paddingTop={1}
			paddingBottom={1}
			gap={1}
		>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>environments</b>
				</text>
				<text fg={props.theme.text.feedback.success.base}>●</text>
				<text fg={props.theme.text.feedback.success.base} wrapMode="none">
					{props.scope}
				</text>
				<box flexGrow={1} />
				<Show when={!props.compact}>
					<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
						{props.apps} apps · {props.owned} owned
					</text>
				</Show>
			</box>
			<box flexDirection="row" gap={2} flexWrap="wrap">
				<For each={TAB_ORDER}>
					{(tab, index) => {
						const selected = () => tab === props.tab;
						return (
							<box
								flexShrink={0}
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={
									selected()
										? props.theme.background.action.primary.focused
										: undefined
								}
								onMouseUp={() => props.onSelect(tab)}
							>
								<text
									wrapMode="none"
									fg={
										selected()
											? props.theme.text.action.primary.focused
											: props.theme.text.muted
									}
								>
									{index() + 1} {label(tab)}
									{props.compact ? ` ${count(tab)}` : ` (${count(tab)})`}
								</text>
							</box>
						);
					}}
				</For>
			</box>
		</box>
	);
}

function GitHeader(props: {
	theme: Theme;
	appId: string;
	current?: string;
	total: number;
	visible: number;
	worktrees: number;
	remotes: number;
	query: string;
	searchFocused: boolean;
	compact: boolean;
	onQuery(value: string): void;
	onSearchRef(input: InputRenderable | undefined): void;
	onSearchSubmit(): void;
	onFocusSearch(): void;
	onBlurSearch(): void;
}) {
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={props.compact ? 1 : 2}
			paddingRight={props.compact ? 1 : 2}
			paddingTop={1}
			paddingBottom={1}
			gap={1}
		>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none">
					<b>git</b>
				</text>
				<text
					fg={
						props.current
							? props.theme.text.feedback.success.base
							: props.theme.text.muted
					}
				>
					●
				</text>
				<text
					fg={props.theme.text.feedback.success.base}
					wrapMode="none"
					truncate
				>
					{props.current ?? "detached"}
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" truncate flexGrow={1}>
					{props.appId}
				</text>
				<Show when={!props.compact}>
					<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
						{props.total} branches · {props.worktrees} worktrees ·{" "}
						{props.remotes} remotes
					</text>
				</Show>
			</box>
			<box flexDirection="row" gap={1} height={1} minWidth={0}>
				<text fg={props.theme.text.muted} flexShrink={0}>
					/
				</text>
				<input
					ref={(value: InputRenderable) => props.onSearchRef(value)}
					value={props.query}
					placeholder="filter branches"
					focused={props.searchFocused}
					backgroundColor={props.theme.background.raised.base}
					focusedBackgroundColor={props.theme.background.raised.high}
					textColor={props.theme.text.base}
					focusedTextColor={props.theme.text.base}
					placeholderColor={props.theme.text.muted}
					cursorColor={props.theme.text.base}
					onInput={props.onQuery}
					onSubmit={props.onSearchSubmit}
					on:focus={props.onFocusSearch}
					on:blur={props.onBlurSearch}
					flexGrow={1}
				/>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.visible} of {props.total}
				</text>
			</box>
		</box>
	);
}

export function EnvironmentPage(props: {
	context: Context;
	onClose: () => void;
	panel?: PanelInput;
}) {
	const theme = props.context.theme;
	const compact = () => Boolean(props.panel) && (props.panel?.width ?? 0) < 96;
	const active = () => !props.panel || props.panel.focused;
	const filtering = () =>
		store.searchFocused() ||
		(store.view() === "git" && store.branchSearchFocused()) ||
		((store.view() === "providers" ||
			store.view() === "provider-changes" ||
			store.view() === "provider-issues" ||
			store.view() === "provider-pipelines" ||
			store.view() === "provider-jobs") &&
			store.providerFilterFocused()) ||
		(store.view() === "provider-repos" && store.providerRepoSearchFocused()) ||
		(store.view() === "cluster-namespace" && store.clusterNamespaceFocused()) ||
		(store.view() === "cluster-events" && store.clusterEventFilterFocused()) ||
		(store.view() === "provider-write" &&
			store.providerWriteStage() === "edit") ||
		(store.view() === "git-write" && store.gitWriteStage() === "edit") ||
		store.view() === "tag-add" ||
		(store.view() === "config-write" && store.configStage() === "edit");
	const api = (() => {
		try {
			return createEnvironmentApi(props.context.options);
		} catch (error) {
			return failingApi(errorMessage(error));
		}
	})();
	const client = new EnvironmentMcpClient(api);
	const events = (() => {
		try {
			return createEnvironmentEvents(props.context.options);
		} catch {
			return undefined;
		}
	})();
	const eventsController = new AbortController();
	const store = createEnvironmentStore(client);
	createEffect(() => {
		const gitRequest = takeSessionGitRequest();
		if (gitRequest) void store.loadSessionGit(gitRequest.directory);
		const providerRequest = takeSessionProviderRequest();
		if (providerRequest)
			void store.loadSessionProvider(
				providerRequest.directory,
				providerRequest.kind,
			);
	});
	onCleanup(() => eventsController.abort());
	createEffect(() => {
		if (store.view() === "table" || store.view() === "detail") {
			store.startLiveRefresh();
		} else {
			store.stopLiveRefresh();
		}
	});
	createEffect(() => {
		if (store.view() !== "container-stats") return;
		const timer = setInterval(() => void store.refreshContainerStats(), 2000);
		onCleanup(() => clearInterval(timer));
	});
	let searchInput: InputRenderable | undefined;
	let branchSearchInput: InputRenderable | undefined;
	let providerSearchInput: InputRenderable | undefined;
	let providerRepoInput: InputRenderable | undefined;
	let clusterEventInput: InputRenderable | undefined;

	const focusSearch = () => {
		if (store.view() !== "table") return;
		store.setSearchFocused(true);
		queueMicrotask(() => searchInput?.focus());
	};
	const blurSearch = () => {
		store.setSearchFocused(false);
		searchInput?.blur();
	};
	const finishSearch = () => {
		blurSearch();
	};
	const focusBranchSearch = () => {
		if (store.view() !== "git") return;
		store.setBranchSearchFocused(true);
		if (branchSearchInput) branchSearchInput.focus();
		else queueMicrotask(() => branchSearchInput?.focus());
	};
	const blurBranchSearch = () => {
		store.setBranchSearchFocused(false);
		branchSearchInput?.blur();
	};
	const clearBranchSearch = () => {
		store.setBranchQuery("");
		store.setBranchIndex(0);
		blurBranchSearch();
	};
	const focusProviderFilter = () => {
		store.setProviderFilterFocused(true);
		queueMicrotask(() => providerSearchInput?.focus());
	};
	const blurProviderFilter = () => {
		store.setProviderFilterFocused(false);
		providerSearchInput?.blur();
	};
	const clearProviderFilter = () => {
		store.setProviderFilter("");
		blurProviderFilter();
	};
	const focusProviderRepoSearch = () => {
		store.setProviderRepoSearchFocused(true);
		queueMicrotask(() => providerRepoInput?.focus());
	};
	const blurProviderRepoSearch = () => {
		store.setProviderRepoSearchFocused(false);
		providerRepoInput?.blur();
	};
	const focusClusterEventFilter = () => {
		store.setClusterEventFilterFocused(true);
		queueMicrotask(() => clusterEventInput?.focus());
	};
	const blurClusterEventFilter = () => {
		store.setClusterEventFilterFocused(false);
		clusterEventInput?.blur();
	};
	const clearClusterEventFilter = () => {
		store.setClusterEventQuery("");
		blurClusterEventFilter();
	};
	const clearSearch = () => {
		blurSearch();
		store.setQuery("");
		store.setSelectedIndex(0);
	};
	const back = () => {
		if (store.searchFocused()) {
			clearSearch();
			return;
		}
		if (store.view() === "git" && store.branchSearchFocused()) {
			clearBranchSearch();
			return;
		}
		if (store.providerFilterFocused()) {
			clearProviderFilter();
			return;
		}
		if (store.providerRepoSearchFocused()) {
			blurProviderRepoSearch();
			return;
		}
		if (store.sessionMode() && store.view() === "git") {
			store.endSessionGit();
			props.onClose();
			return;
		}
		if (store.view() === "table") {
			props.onClose();
			return;
		}
		store.back();
	};
	const openHelp = () => {
		props.context.ui.dialog.set({ size: "large" });
		props.context.ui.dialog.show(() => (
			<HelpDialog context={props.context} theme={theme} panel={props.panel} />
		));
	};
	const refresh = () => {
		void store.refresh();
	};
	const selectedApp = () => store.selectedApp();
	const message = () => {
		if (store.error()) return store.error();
		if (store.message()) return store.message();
		if (store.busy()) return "Working…";
		if (store.view() === "table")
			return `${store.filteredApps().length} of ${store.tabApps().length} applications`;
		if (store.view() === "detail" && selectedApp())
			return `${selectedApp()?.id} · ${selectedApp()?.kind}`;
		if (store.view() === "operation" && store.operation())
			return `operation ${store.operation()?.state}`;
		if (store.view() === "history")
			return `${store.operations().length} of ${store.operationTotal()} receipts`;
		if (store.view() === "services")
			return `${store.services().length} configured services`;
		if (store.view() === "container-stats")
			return `${store.containerStats()?.containers.length ?? 0} containers`;
		if (store.view() === "clusters")
			return `${store.clusters().length} clusters`;
		if (store.view() === "cluster-namespace")
			return `${store.clusterNamespace()} · ${store.clusterNamespaces()?.namespaces.length ?? 0} namespaces`;
		if (store.view() === "cluster-resources")
			return `${store.clusterResources()?.items.length ?? 0} resources · ${store.clusterResources()?.namespace ?? ""}`;
		if (store.view() === "cluster-events")
			return `${store.clusterEvents()?.events.length ?? 0} events · ${store.clusterEvents()?.namespace ?? ""}`;
		if (store.view() === "cluster-describe")
			return `${store.clusterDescribe()?.cluster ?? ""} · ${store.clusterDescribe()?.namespace ?? ""}`;
		if (store.view() === "cluster-pod-containers")
			return `${store.selectedClusterResource()?.name ?? ""} · ${store.selectedClusterResource()?.containers?.length ?? 0} containers`;
		if (store.view() === "cluster-pod-logs")
			return `${store.clusterPodLogs()?.pod ?? ""} · ${store.clusterPodLogs()?.namespace ?? ""}${store.clusterPodLogs()?.previous ? " · previous" : ""}`;
		if (store.view() === "providers")
			return `${store.visibleProviders().length} of ${store.providers().length} providers`;
		if (store.view() === "provider-repos")
			return `${store.providerRepos().length} repositories`;
		if (store.view() === "provider-changes")
			return `${store.visibleProviderChanges().length} of ${store.providerChanges().length} changes · ${store.providerState()}`;
		if (store.view() === "provider-issues")
			return `${store.visibleProviderIssues().length} of ${store.providerIssues().length} issues · ${store.providerState()}`;
		if (store.view() === "provider-pipelines")
			return `${store.visibleProviderPipelines().length} of ${store.providerPipelines().length} pipelines`;
		if (store.view() === "provider-jobs")
			return `${store.visibleProviderJobs().length} of ${store.providerJobs().length} jobs`;
		if (store.view() === "provider-change" && store.providerChangeDetail())
			return `change #${store.providerChangeDetail()?.number}`;
		if (store.view() === "provider-change-files")
			return `${store.providerFiles()?.files.length ?? 0} files`;
		if (store.view() === "provider-file")
			return store.providerFile()?.path ?? "";
		if (store.view() === "provider-change-discussions")
			return `${store.providerDiscussions().length} discussions`;
		if (store.view() === "provider-versions")
			return `${store.providerVersions().length} versions`;
		if (store.view() === "provider-issue-comments")
			return `${store.providerIssueComments().length} comments`;
		if (store.view() === "provider-issue" && store.providerIssueDetail())
			return `issue #${store.providerIssueDetail()?.number}`;
		if (store.view() === "provider-job-logs")
			return `job #${store.providerLogJob() ?? 0} log`;
		if (store.view() === "provider-merge")
			return `merge #${store.providerChangeDetail()?.number ?? 0}`;
		if (store.view() === "provider-write")
			return `${store.providerWriteAction() ?? "write"} · ${store.providerWriteStage()}`;
		if (store.view() === "git-write")
			return `${store.gitWriteRequest()?.action ?? "git"} · ${store.gitWriteStage()}`;
		if (store.view() === "git-log")
			return `${store.gitLog()?.commits.length ?? 0} commits`;
		if (store.view() === "git-commit")
			return `commit ${store.gitCommitDetail()?.shortSha ?? ""}`;
		if (store.view() === "tags")
			return `${store.tags()?.tags.length ?? 0} tags`;
		if (store.view() === "stashes")
			return `${store.stashes()?.stashes.length ?? 0} stashes`;
		if (store.view() === "tag-add")
			return store.tagField() === 0 ? "tag name" : "tag message";
		if (store.view() === "provider-writes")
			return `${store.providerWrites().length} write receipts`;
		if (store.view() === "config-write")
			return `${store.configAction() ?? "configuration"} · ${store.configStage()}`;
		return "";
	};
	const tone = () => {
		if (store.error()) return "error" as const;
		if (store.busy()) return "warning" as const;
		if (store.operation()?.state === "completed") return "success" as const;
		return "normal" as const;
	};
	const right = () => {
		if (store.view() === "table")
			return `${store.filteredApps().length}/${store.tabApps().length}`;
		if (store.view() === "detail" && selectedApp()) return selectedApp()?.id;
		if (store.view() === "changes" && selectedApp()) return selectedApp()?.id;
		if (store.view() === "diff" && selectedApp()) return selectedApp()?.id;
		if (
			(store.view() === "git" ||
				store.view() === "git-write" ||
				store.view() === "git-log" ||
				store.view() === "git-commit" ||
				store.view() === "tags" ||
				store.view() === "tag-add" ||
				store.view() === "stashes" ||
				store.view() === "worktrees" ||
				store.view() === "worktree-add" ||
				store.view() === "remotes" ||
				store.view() === "remote-add") &&
			selectedApp()
		)
			return selectedApp()?.id;
		if (store.view() === "operation" && store.operation())
			return store.operation()?.id.slice(0, 12);
		if (store.view() === "history")
			return `${store.operations().length}/${store.operationTotal()}`;
		if (store.view() === "telemetry")
			return `${store.telemetry()?.traces.length ?? 0} traces`;
		if (store.view() === "container-stats")
			return `${store.containerStats()?.containers.length ?? 0}`;
		if (store.view() === "clusters" || store.view() === "cluster-namespace")
			return store.selectedCluster()?.id;
		if (
			store.view() === "cluster-resources" ||
			store.view() === "cluster-events" ||
			store.view() === "cluster-describe" ||
			store.view() === "cluster-pod-logs" ||
			store.view() === "cluster-pod-containers"
		)
			return store.clusterResources()?.cluster ?? store.selectedCluster()?.id;
		if (store.view() === "providers") return store.selectedProvider()?.name;
		if (
			store.view() === "provider-repos" ||
			store.view() === "provider-changes" ||
			store.view() === "provider-issues" ||
			store.view() === "provider-pipelines" ||
			store.view() === "provider-jobs" ||
			store.view() === "provider-change" ||
			store.view() === "provider-change-files" ||
			store.view() === "provider-file" ||
			store.view() === "provider-change-discussions" ||
			store.view() === "provider-versions" ||
			store.view() === "provider-issue" ||
			store.view() === "provider-issue-comments" ||
			store.view() === "provider-job-logs" ||
			store.view() === "provider-merge" ||
			store.view() === "provider-write" ||
			store.view() === "provider-writes"
		)
			return store.selectedProvider()?.name;
		if (store.view() === "config-write")
			return store.configSource()?.app ?? store.configId();
		return undefined;
	};

	onMount(() => {
		if (props.panel) queueMicrotask(() => props.panel?.focus());
		void events?.subscribe(eventsController.signal, store.handleEvent);
		void store.load();
	});

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: active,
		commands: [
			{ bind: "escape", title: "Back", group: "Environments", run: back },
			{
				bind: "?",
				title: "Environment help",
				group: "Environments",
				enabled: () => !filtering(),
				run: openHelp,
			},
			{
				bind: "r",
				title: "Refresh",
				group: "Environments",
				enabled: () => !filtering(),
				run: refresh,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && !filtering() && store.view() !== "operation",
		commands: [
			{
				bind: "tab",
				title: "Next tab",
				group: "Environments",
				run: () => store.cycleTab(1),
			},
			{
				bind: "shift+tab",
				title: "Previous tab",
				group: "Environments",
				run: () => store.cycleTab(-1),
			},
			{
				bind: "1",
				title: "Applications",
				group: "Environments",
				run: () => store.selectTab("applications"),
			},
			{
				bind: "2",
				title: "Libraries",
				group: "Environments",
				run: () => store.selectTab("libraries"),
			},
			{
				bind: "3",
				title: "Infrastructure",
				group: "Environments",
				run: () => store.selectTab("infrastructure"),
			},
			{
				bind: "4",
				title: "History",
				group: "Environments",
				run: () => store.selectTab("history"),
			},
			{
				bind: "5",
				title: "Services",
				group: "Environments",
				run: () => store.selectTab("services"),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			!filtering() &&
			(store.view() === "table" ||
				store.view() === "targets" ||
				store.view() === "history" ||
				store.view() === "telemetry"),
		commands: [
			{
				bind: "up,k",
				title: "Previous",
				group: "Environments",
				run: () => store.move(-1),
			},
			{
				bind: "down,j",
				title: "Next",
				group: "Environments",
				run: () => store.move(1),
			},
			{
				bind: "return",
				title: "Open",
				group: "Environments",
				run: store.openSelected,
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "table" && store.searchFocused(),
		commands: [
			{
				bind: "up",
				title: "Previous filtered result",
				group: "Environments",
				run: () => store.move(-1),
			},
			{
				bind: "down",
				title: "Next filtered result",
				group: "Environments",
				run: () => store.move(1),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "table" && !store.searchFocused(),
		commands: [
			{ bind: "/", title: "Filter", group: "Environments", run: focusSearch },
			{
				bind: "n",
				title: "New application",
				group: "Environments",
				run: () => store.beginAppCreate(),
			},
			{
				bind: "p",
				title: "Providers",
				group: "Environments",
				run: () => void store.loadProviders(),
			},
			{
				bind: "shift+k",
				title: "Kubernetes clusters",
				group: "Environments",
				run: () => void store.loadClusters(),
			},
			{
				bind: "i",
				title: "Provider issues",
				group: "Environments",
				run: () => void store.openAppProvider("issues"),
			},
			{
				bind: "c",
				title: "Change requests",
				group: "Environments",
				run: () => void store.openAppProvider("changes"),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.providerFilterFocused(),
		commands: [
			{
				bind: "escape",
				title: "Clear provider filter",
				group: "Environments",
				run: clearProviderFilter,
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.providerRepoSearchFocused(),
		commands: [
			{
				bind: "escape",
				title: "Blur repository search",
				group: "Environments",
				run: blurProviderRepoSearch,
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "providers",
		commands: [
			{
				bind: "/",
				title: "Filter providers",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: focusProviderFilter,
			},
			{
				bind: "up,k",
				title: "Previous provider",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProvider(-1),
			},
			{
				bind: "down,j",
				title: "Next provider",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProvider(1),
			},
			{
				bind: "return",
				title: "Search repositories",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.beginProviderRepos(),
			},
			{
				bind: "w",
				title: "Write receipts",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderWrites(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-repos",
		commands: [
			{
				bind: "/",
				title: "Search repositories",
				group: "Environments",
				enabled: () => !store.providerRepoSearchFocused(),
				run: focusProviderRepoSearch,
			},
			{
				bind: "up,k",
				title: "Previous repository",
				group: "Environments",
				enabled: () => !store.providerRepoSearchFocused(),
				run: () => store.moveProviderRepo(-1),
			},
			{
				bind: "down,j",
				title: "Next repository",
				group: "Environments",
				enabled: () => !store.providerRepoSearchFocused(),
				run: () => store.moveProviderRepo(1),
			},
			{
				bind: "return",
				title: "Open repository",
				group: "Environments",
				enabled: () => !store.providerRepoSearchFocused(),
				run: () => store.openSelectedProviderRepo(),
			},
			{
				bind: "r",
				title: "Repeat search",
				group: "Environments",
				enabled: () => !store.providerRepoSearchFocused(),
				run: () => void store.searchProviderRepos(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			(store.view() === "provider-changes" ||
				store.view() === "provider-issues"),
		commands: [
			{
				bind: "/",
				title: "Filter provider list",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: focusProviderFilter,
			},
			{
				bind: "up,k",
				title: "Previous item",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next item",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "return",
				title: "Open detail",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => {
					if (store.view() === "provider-changes") {
						const change = store.selectedProviderChange();
						if (change) void store.openProviderChange(change);
					} else {
						const issue = store.selectedProviderIssue();
						if (issue) void store.openProviderIssue(issue);
					}
				},
			},
			{
				bind: "c",
				title: "Changes",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderChanges(),
			},
			{
				bind: "i",
				title: "Issues",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderIssues(),
			},
			{
				bind: "l",
				title: "Pipelines",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderPipelines(),
			},
			{
				bind: "s",
				title: "Cycle state",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.cycleProviderState(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-pipelines",
		commands: [
			{
				bind: "/",
				title: "Filter pipelines",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: focusProviderFilter,
			},
			{
				bind: "up,k",
				title: "Previous pipeline",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next pipeline",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "return",
				title: "Open jobs",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.openProviderJobs(),
			},
			{
				bind: "c",
				title: "Changes",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderChanges(),
			},
			{
				bind: "i",
				title: "Issues",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.loadProviderIssues(),
			},
			{
				bind: "t",
				title: "Retry pipeline",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () =>
					void store.beginProviderWrite("retry-pipeline", "provider-pipelines"),
			},
			{
				bind: "x",
				title: "Cancel pipeline",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () =>
					void store.beginProviderWrite(
						"cancel-pipeline",
						"provider-pipelines",
					),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-jobs",
		commands: [
			{
				bind: "/",
				title: "Filter jobs",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: focusProviderFilter,
			},
			{
				bind: "up,k",
				title: "Previous job",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next job",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "return",
				title: "Open job log",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.openProviderJobLogs(),
			},
			{
				bind: "t",
				title: "Retry job",
				group: "Environments",
				enabled: () => !store.providerFilterFocused(),
				run: () => void store.beginProviderWrite("retry-job", "provider-jobs"),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-change",
		commands: [
			{
				bind: "d",
				title: "Diff and changed files",
				group: "Environments",
				run: () => void store.openProviderChangeFiles(),
			},
			{
				bind: "h",
				title: "Discussion history",
				group: "Environments",
				run: () => void store.openProviderDiscussions(),
			},
			{
				bind: "v",
				title: "Version history",
				group: "Environments",
				run: () => void store.openProviderVersions(),
			},
			{
				bind: "c",
				title: "Comment",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("comment-change", "provider-change"),
			},
			{
				bind: "a",
				title: "Approve exact head",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("approve-change", "provider-change"),
			},
			{
				bind: "shift+m",
				title: "Merge change",
				group: "Environments",
				run: () => store.beginProviderMerge(),
			},
			{
				bind: "shift+b",
				title: "Rebase change",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("rebase-change", "provider-change"),
			},
			{
				bind: "u",
				title: "Withdraw approval",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("unapprove-change", "provider-change"),
			},
			{
				bind: "l",
				title: "Add labels",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("add-labels", "provider-change"),
			},
			{
				bind: "shift+a",
				title: "Set assignees",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("set-assignees", "provider-change"),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-issue",
		commands: [
			{
				bind: "c",
				title: "Comment",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("comment-issue", "provider-issue"),
			},
			{
				bind: "h",
				title: "Comment history",
				group: "Environments",
				run: () => void store.openProviderIssueComments(),
			},
			{
				bind: "o",
				title: "Open / close issue",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("set-issue-state", "provider-issue"),
			},
			{
				bind: "l",
				title: "Add labels",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("add-labels", "provider-issue"),
			},
			{
				bind: "shift+a",
				title: "Set assignees",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite("set-assignees", "provider-issue"),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-versions",
		commands: [
			{
				bind: "up,k",
				title: "Previous version",
				group: "Environments",
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next version",
				group: "Environments",
				run: () => store.moveProviderItem(1),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-issue-comments",
		commands: [
			{
				bind: "up,k",
				title: "Previous comment",
				group: "Environments",
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next comment",
				group: "Environments",
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "c",
				title: "Reply",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite(
						"reply-discussion",
						"provider-issue-comments",
					),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-change-files",
		commands: [
			{
				bind: "up,k",
				title: "Previous file",
				group: "Environments",
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next file",
				group: "Environments",
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "return",
				title: "Open patch",
				group: "Environments",
				run: () => store.openProviderFile(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-change-discussions",
		commands: [
			{
				bind: "up,k",
				title: "Previous discussion",
				group: "Environments",
				run: () => store.moveProviderItem(-1),
			},
			{
				bind: "down,j",
				title: "Next discussion",
				group: "Environments",
				run: () => store.moveProviderItem(1),
			},
			{
				bind: "c",
				title: "Reply",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite(
						"reply-discussion",
						"provider-change-discussions",
					),
			},
			{
				bind: "x",
				title: "Resolve / unresolve",
				group: "Environments",
				run: () =>
					void store.beginProviderWrite(
						"set-discussion-resolved",
						"provider-change-discussions",
					),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "clusters",
		commands: [
			{
				bind: "up,k",
				title: "Previous cluster",
				group: "Environments",
				run: () => store.moveCluster(-1),
			},
			{
				bind: "down,j",
				title: "Next cluster",
				group: "Environments",
				run: () => store.moveCluster(1),
			},
			{
				bind: "return",
				title: "Choose namespace",
				group: "Environments",
				run: () => store.beginClusterNamespace(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "cluster-namespace",
		commands: [
			{
				bind: "/",
				title: "Type namespace",
				group: "Environments",
				enabled: () => !store.clusterNamespaceFocused(),
				run: () => store.setClusterNamespaceFocused(true),
			},
			{
				bind: "up,k",
				title: "Previous namespace",
				group: "Environments",
				enabled: () => !store.clusterNamespaceFocused(),
				run: () => store.moveClusterNamespace(-1),
			},
			{
				bind: "down,j",
				title: "Next namespace",
				group: "Environments",
				enabled: () => !store.clusterNamespaceFocused(),
				run: () => store.moveClusterNamespace(1),
			},
			{
				bind: "return",
				title: "Inspect namespace",
				group: "Environments",
				enabled: () => !store.clusterNamespaceFocused(),
				run: () => void store.loadClusterResources(),
			},
			{
				bind: "escape",
				title: store.clusterNamespaceFocused()
					? "Leave namespace input"
					: "Back to clusters",
				group: "Environments",
				run: () => {
					if (store.clusterNamespaceFocused())
						store.setClusterNamespaceFocused(false);
					else store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "cluster-resources",
		commands: [
			{
				bind: "up,k",
				title: "Previous resource",
				group: "Environments",
				run: () => store.moveClusterResource(-1),
			},
			{
				bind: "down,j",
				title: "Next resource",
				group: "Environments",
				run: () => store.moveClusterResource(1),
			},
			{
				bind: "return",
				title: "Describe resource",
				group: "Environments",
				run: () => void store.openClusterDescribe(),
			},
			{
				bind: "e",
				title: "Namespace events",
				group: "Environments",
				run: () => void store.openClusterEvents(),
			},
			{
				bind: "l",
				title: "Pod logs",
				group: "Environments",
				run: () => void store.openClusterPodLogs(),
			},
			{
				bind: "escape",
				title: "Back to clusters",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "cluster-events",
		commands: [
			{
				bind: "/",
				title: "Filter events",
				group: "Environments",
				enabled: () => !store.clusterEventFilterFocused(),
				run: focusClusterEventFilter,
			},
			{
				bind: "r",
				title: "Refresh events",
				group: "Environments",
				run: () => void store.refresh(),
			},
			{
				bind: "escape",
				title: store.clusterEventFilterFocused()
					? "Clear event filter"
					: "Back to resources",
				group: "Environments",
				run: () => {
					if (store.clusterEventFilterFocused()) clearClusterEventFilter();
					else store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			(store.view() === "cluster-describe" ||
				store.view() === "cluster-pod-logs"),
		commands: [
			...(store.view() === "cluster-pod-logs"
				? [
						{
							bind: "p",
							title: "Toggle previous container logs",
							group: "Environments",
							run: () => void store.togglePodLogPrevious(),
						},
					]
				: []),
			{
				bind: "r",
				title: "Refresh cluster view",
				group: "Environments",
				run: () => void store.refresh(),
			},
			{
				bind: "escape",
				title: "Back",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "cluster-pod-containers",
		commands: [
			{
				bind: "up,k",
				title: "Previous container",
				group: "Environments",
				run: () =>
					store.setClusterContainerIndex(
						Math.max(0, store.clusterContainerIndex() - 1),
					),
			},
			{
				bind: "down,j",
				title: "Next container",
				group: "Environments",
				run: () =>
					store.setClusterContainerIndex(store.clusterContainerIndex() + 1),
			},
			{
				bind: "return",
				title: "Open container logs",
				group: "Environments",
				run: () => void store.openSelectedPodContainerLogs(),
			},
			{
				bind: "escape",
				title: "Back to resources",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "provider-merge",
		commands: [
			{
				bind: "up,k",
				title: "Previous merge method",
				group: "Environments",
				run: () => store.moveProviderMerge(-1),
			},
			{
				bind: "down,j",
				title: "Next merge method",
				group: "Environments",
				run: () => store.moveProviderMerge(1),
			},
			{
				bind: "return",
				title: "Choose merge method",
				group: "Environments",
				run: () => void store.chooseProviderMerge(),
			},
			{
				bind: "escape",
				title: "Back to change",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			store.view() === "provider-write" &&
			store.providerWriteStage() === "edit",
		commands: [
			{
				bind: "return",
				title: "Preview write",
				group: "Environments",
				run: () => void store.previewProviderWrite(),
			},
			{
				bind: "escape",
				title: "Cancel write",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			store.view() === "provider-write" &&
			store.providerWriteStage() === "confirm",
		commands: [
			{
				bind: "y",
				title: "Confirm write",
				group: "Environments",
				run: () => void store.confirmProviderWrite(),
			},
			{
				bind: "escape",
				title: "Cancel write",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "targets",
		commands: [
			{
				bind: "n",
				title: "New shell target",
				group: "Environments",
				run: () => store.beginTargetShellCreate(),
			},
			{
				bind: "d",
				title: "Duplicate target",
				group: "Environments",
				run: () => store.beginTargetDuplicate(),
			},
			{
				bind: "e",
				title: "Edit target",
				group: "Environments",
				run: () => store.beginTargetEdit(),
			},
			{
				bind: "x",
				title: "Delete target",
				group: "Environments",
				run: () => store.beginTargetDelete(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "config-write",
		commands: [
			{
				bind: "tab",
				title: "Next field",
				group: "Environments",
				enabled: () => store.configStage() === "edit",
				run: () => store.cycleConfigField(),
			},
			{
				bind: "y",
				title: "Confirm write",
				group: "Environments",
				enabled: () => store.configStage() === "confirm",
				run: () => void store.confirmConfigWrite(),
			},
			{
				bind: "t",
				title: "Toggle target cascade",
				group: "Environments",
				enabled: () =>
					store.configAction() === "app-delete" &&
					store.configStage() === "confirm",
				run: () => {
					store.toggleConfigDeleteTargets();
					void store.previewConfigWrite();
				},
			},
			{
				bind: "escape",
				title: "Cancel configuration write",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "detail",
		commands: [
			{
				bind: "b",
				title: "Build",
				group: "Environments",
				run: () => store.openTargets("build"),
			},
			{
				bind: "s",
				title: "Start / run",
				group: "Environments",
				run: () => store.openTargets("run"),
			},
			{
				bind: "t",
				title: "Test",
				group: "Environments",
				run: () => store.openTargets("test"),
			},
			{
				bind: "shift+s",
				title: "Stop owned resources",
				group: "Environments",
				run: () => void store.stop(),
			},
			{
				bind: "g",
				title: "Git",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadGitView(app);
				},
			},
			{
				bind: "c",
				title: "Changes",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadChanges(app);
				},
			},
			{
				bind: "l",
				title: "Logs",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadLogs(app);
				},
			},
			{
				bind: "shift+l",
				title: "History",
				group: "Environments",
				run: () => store.selectTab("history"),
			},
			{
				bind: "e",
				title: "Telemetry",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadTelemetry(app);
				},
			},
			{
				bind: "m",
				title: "Container stats",
				group: "Environments",
				run: () => void store.loadContainerStats(),
			},
			{
				bind: "shift+e",
				title: "Edit application",
				group: "Environments",
				run: () => store.beginAppEdit(),
			},
			{
				bind: "shift+x",
				title: "Delete application",
				group: "Environments",
				run: () => store.beginAppDelete(),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "operation",
		commands: [
			{
				bind: "r",
				title: "Refresh operation",
				group: "Environments",
				run: () => void store.refreshOperation(),
			},
		],
	}));

	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "git" && !store.branchSearchFocused(),
		commands: [
			{
				bind: "/",
				title: "Filter branches",
				group: "Environments",
				run: focusBranchSearch,
			},
			{
				bind: "up,k",
				title: "Previous branch",
				group: "Environments",
				run: () => store.moveBranch(-1),
			},
			{
				bind: "down,j",
				title: "Next branch",
				group: "Environments",
				run: () => store.moveBranch(1),
			},
			{
				bind: "enter",
				title: "Switch branch",
				group: "Environments",
				run: () => store.checkoutBranch(),
			},
			{
				bind: "f",
				title: "Fetch",
				group: "Environments",
				run: () => store.fetchGit(),
			},
			{
				bind: "p",
				title: "Pull fast-forward",
				group: "Environments",
				run: () => store.pullGit(),
			},
			{
				bind: "shift+p",
				title: "Push branch",
				group: "Environments",
				run: () => void store.beginGitWrite("push", "git"),
			},
			{
				bind: "shift+f",
				title: "Force push with lease",
				group: "Environments",
				run: () => void store.beginGitWrite("push-force", "git"),
			},
			{
				bind: "shift+x",
				title: "Abort rebase",
				group: "Environments",
				run: () => void store.beginGitWrite("rebase-abort", "git"),
			},
			{
				bind: "t",
				title: "Create tag",
				group: "Environments",
				run: () => void store.beginGitWrite("tag", "git"),
			},
			{
				bind: "shift+r",
				title: "Rename branch",
				group: "Environments",
				run: () => void store.beginGitWrite("branch-rename", "git"),
			},
			{
				bind: "shift+c",
				title: "Commit staged changes",
				group: "Environments",
				run: () => void store.beginGitWrite("commit", "git"),
			},
			{
				bind: "shift+a",
				title: "Commit all changes",
				group: "Environments",
				run: () => void store.beginGitWrite("commit-all", "git"),
			},
			{
				bind: "shift+t",
				title: "Tags",
				group: "Environments",
				run: () => void store.loadTags(),
			},
			{
				bind: "shift+l",
				title: "Commit history",
				group: "Environments",
				run: () => void store.loadGitLog(),
			},
			{
				bind: "shift+s",
				title: "Stashes",
				group: "Environments",
				run: () => void store.loadStashes(),
			},
			{
				bind: "s",
				title: "Stash changes",
				group: "Environments",
				run: () => void store.beginGitWrite("stash", "git"),
			},
			{
				bind: "shift+m",
				title: "Merge branch into current",
				group: "Environments",
				run: () => void store.beginGitWrite("merge", "git"),
			},
			{
				bind: "shift+b",
				title: "Rebase current onto branch",
				group: "Environments",
				run: () => void store.beginGitWrite("rebase", "git"),
			},
			{
				bind: "w",
				title: "Worktrees",
				group: "Environments",
				run: () => store.setView("worktrees"),
			},
			{
				bind: "m",
				title: "Remotes",
				group: "Environments",
				run: () => store.setView("remotes"),
			},
			{
				bind: "d",
				title: "Delete branch",
				group: "Environments",
				run: () => store.deleteSelectedBranch(),
			},
			{
				bind: "c",
				title: "Changes",
				group: "Environments",
				run: () => {
					const app = selectedApp();
					if (app) void store.loadChanges(app);
				},
			},
			{
				bind: "r",
				title: "Refresh git",
				group: "Environments",
				run: () => void store.refresh(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "worktrees",
		commands: [
			{
				bind: "up,k",
				title: "Previous worktree",
				group: "Environments",
				run: () => store.moveWorktree(-1),
			},
			{
				bind: "down,j",
				title: "Next worktree",
				group: "Environments",
				run: () => store.moveWorktree(1),
			},
			{
				bind: "a",
				title: "Add worktree",
				group: "Environments",
				run: () => store.beginWorktreeAdd(),
			},
			{
				bind: "u",
				title: "Run targets in worktree",
				group: "Environments",
				run: () => store.useSelectedWorktree(),
			},
			{
				bind: "x",
				title: "Remove worktree",
				group: "Environments",
				run: () => store.removeSelectedWorktree(),
			},
			{
				bind: "r",
				title: "Refresh worktrees",
				group: "Environments",
				run: () => void store.refresh(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() && store.view() === "git" && store.branchSearchFocused(),
		commands: [
			{
				bind: "enter",
				title: "Focus filtered branches",
				group: "Environments",
				run: blurBranchSearch,
			},
			{
				bind: "up",
				title: "Previous filtered branch",
				group: "Environments",
				run: () => store.moveBranch(-1),
			},
			{
				bind: "down",
				title: "Next filtered branch",
				group: "Environments",
				run: () => store.moveBranch(1),
			},
			{
				bind: "escape",
				title: "Clear branch filter",
				group: "Environments",
				run: clearBranchSearch,
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "remotes",
		commands: [
			{
				bind: "up,k",
				title: "Previous remote",
				group: "Environments",
				run: () => store.moveRemote(-1),
			},
			{
				bind: "down,j",
				title: "Next remote",
				group: "Environments",
				run: () => store.moveRemote(1),
			},
			{
				bind: "a",
				title: "Add remote",
				group: "Environments",
				run: () => store.beginRemoteAdd(),
			},
			{
				bind: "e",
				title: "Edit remote URL",
				group: "Environments",
				run: () => void store.beginGitWrite("remote-set-url", "remotes"),
			},
			{
				bind: "x",
				title: "Remove remote",
				group: "Environments",
				run: () => store.removeSelectedRemote(),
			},
			{
				bind: "r",
				title: "Refresh remotes",
				group: "Environments",
				run: () => void store.refresh(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			store.view() === "git-write" &&
			store.gitWriteStage() === "edit",
		commands: [
			{
				bind: "return",
				title: "Preview write",
				group: "Environments",
				run: () => void store.previewGitWrite(),
			},
			{
				bind: "escape",
				title: "Cancel write",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () =>
			active() &&
			store.view() === "git-write" &&
			store.gitWriteStage() === "confirm",
		commands: [
			{
				bind: "y",
				title: "Confirm write",
				group: "Environments",
				run: () => void store.confirmGitWrite(),
			},
			{
				bind: "escape",
				title: "Cancel write",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "git-commit",
		commands: [
			{
				bind: "r",
				title: "Refresh commit",
				group: "Environments",
				run: () => void store.openGitCommit(),
			},
			{
				bind: "escape",
				title: "Back to history",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "git-log",
		commands: [
			{
				bind: "up,k",
				title: "Previous commit",
				group: "Environments",
				run: () => store.moveGitLog(-1),
			},
			{
				bind: "down,j",
				title: "Next commit",
				group: "Environments",
				run: () => store.moveGitLog(1),
			},
			{
				bind: "return",
				title: "Open commit",
				group: "Environments",
				run: () => void store.openGitCommit(),
			},
			{
				bind: "r",
				title: "Refresh history",
				group: "Environments",
				run: () => void store.loadGitLog(),
			},
			{
				bind: "escape",
				title: "Back to git",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "tags",
		commands: [
			{
				bind: "up,k",
				title: "Previous tag",
				group: "Environments",
				run: () => store.moveTag(-1),
			},
			{
				bind: "down,j",
				title: "Next tag",
				group: "Environments",
				run: () => store.moveTag(1),
			},
			{
				bind: "t",
				title: "Create tag",
				group: "Environments",
				run: () => store.beginTagAdd("tags"),
			},
			{
				bind: "d",
				title: "Delete tag",
				group: "Environments",
				run: () => store.deleteSelectedTag(),
			},
			{
				bind: "r",
				title: "Refresh tags",
				group: "Environments",
				run: () => void store.loadTags(),
			},
			{
				bind: "escape",
				title: "Back to git",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "tag-add",
		commands: [
			{
				bind: "tab",
				title: "Next tag field",
				group: "Environments",
				run: () => store.cycleTagField(),
			},
			{
				bind: "escape",
				title: "Cancel tag",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "stashes",
		commands: [
			{
				bind: "up,k",
				title: "Previous stash",
				group: "Environments",
				run: () => store.moveStash(-1),
			},
			{
				bind: "down,j",
				title: "Next stash",
				group: "Environments",
				run: () => store.moveStash(1),
			},
			{
				bind: "p",
				title: "Pop stash",
				group: "Environments",
				run: () => store.beginStashWrite("stash-pop"),
			},
			{
				bind: "a",
				title: "Apply stash",
				group: "Environments",
				run: () => store.beginStashWrite("stash-apply"),
			},
			{
				bind: "d",
				title: "Drop stash",
				group: "Environments",
				run: () => store.beginStashWrite("stash-drop"),
			},
			{
				bind: "r",
				title: "Refresh stashes",
				group: "Environments",
				run: () => void store.loadStashes(),
			},
			{
				bind: "escape",
				title: "Back to git",
				group: "Environments",
				run: () => {
					store.back();
				},
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "remote-add",
		commands: [
			{
				bind: "tab",
				title: "Next remote field",
				group: "Environments",
				run: () => store.cycleRemoteField(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "worktree-add",
		commands: [
			{
				bind: "tab",
				title: "Next worktree field",
				group: "Environments",
				run: () => store.cycleWorktreeField(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "changes",
		commands: [
			{
				bind: "up,k",
				title: "Previous change",
				group: "Environments",
				run: () => store.moveChange(-1),
			},
			{
				bind: "down,j",
				title: "Next change",
				group: "Environments",
				run: () => store.moveChange(1),
			},
			{
				bind: "enter",
				title: "Open diff",
				group: "Environments",
				run: () => void store.openSelectedChange(),
			},
			{
				bind: "s",
				title: "Stage / unstage path",
				group: "Environments",
				run: () => store.toggleStageSelectedChange(),
			},
			{
				bind: "a",
				title: "Stage all",
				group: "Environments",
				run: () => store.stageAllChanges(),
			},
			{
				bind: "u",
				title: "Unstage all",
				group: "Environments",
				run: () => store.unstageAllChanges(),
			},
			{
				bind: "r",
				title: "Refresh changes",
				group: "Environments",
				run: () => void store.refreshChanges(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => active() && store.view() === "diff",
		commands: [
			{
				bind: "s",
				title: "Cycle diff side",
				group: "Environments",
				run: () => store.cycleDiffSide(),
			},
			{
				bind: "r",
				title: "Reload diff",
				group: "Environments",
				run: () => void store.reloadDiff(),
			},
		],
	}));
	props.context.keymap.layer(() => ({
		priority: 1000,
		enabled: () => Boolean(props.panel?.focused) && !filtering(),
		commands: [
			{
				bind: "f",
				title: "Toggle fullscreen",
				group: "Environments",
				run: () => props.panel?.toggleFullscreen(),
			},
		],
	}));

	return (
		<box
			width="100%"
			height="100%"
			flexDirection="column"
			backgroundColor={theme.background.base}
		>
			<Show when={!store.sessionMode()}>
				<Header
					theme={theme}
					tab={store.tab()}
					counts={store.counts()}
					historyCount={store.operationTotal()}
					serviceCount={store.services().length}
					scope={store.scope()}
					apps={store.appTotal()}
					owned={store.owned().length}
					compact={compact()}
					onSelect={store.selectTab}
				/>
			</Show>
			<Show when={store.view() === "git"}>
				<GitHeader
					theme={theme}
					appId={store.selectedApp()?.id ?? ""}
					current={store.branches()?.current}
					total={store.branches()?.branches.length ?? 0}
					visible={store.filteredBranches().length}
					worktrees={store.worktrees()?.worktrees.length ?? 0}
					remotes={store.remotes()?.remotes.length ?? 0}
					query={store.branchQuery()}
					searchFocused={store.branchSearchFocused()}
					compact={compact()}
					onQuery={(value) => {
						store.setBranchQuery(value);
						store.setBranchIndex(0);
					}}
					onSearchRef={(input) => {
						branchSearchInput = input;
					}}
					onSearchSubmit={blurBranchSearch}
					onFocusSearch={() => store.setBranchSearchFocused(true)}
					onBlurSearch={() => store.setBranchSearchFocused(false)}
				/>
			</Show>
			<box
				flexGrow={1}
				flexDirection="column"
				minHeight={0}
				paddingLeft={compact() ? 1 : 2}
				paddingRight={compact() ? 1 : 2}
				paddingTop={1}
			>
				<Switch>
					<Match when={store.view() === "table"}>
						<AppTable
							theme={theme}
							apps={store.tabApps()}
							owned={store.owned()}
							git={store.git()}
							active={store.activeApps()}
							selected={store.selectedIndex()}
							query={store.query()}
							searchFocused={
								store.view() === "git"
									? store.branchSearchFocused()
									: store.searchFocused()
							}
							compact={compact()}
							onQuery={(value) => {
								store.setQuery(value);
								store.setSelectedIndex(0);
							}}
							onSelect={store.setSelectedIndex}
							onOpen={store.openSelected}
							onSearchSubmit={finishSearch}
							onSearchRef={(input) => {
								searchInput = input;
							}}
							onFocusSearch={() => store.setSearchFocused(true)}
							onBlurSearch={() => store.setSearchFocused(false)}
						/>
					</Match>
					<Match when={store.view() === "providers"}>
						<ProvidersView
							theme={theme}
							providers={store.visibleProviders()}
							selected={store.providerIndex()}
							query={store.providerFilter()}
							focused={store.providerFilterFocused()}
							onQuery={store.setProviderFilter}
							onSubmit={blurProviderFilter}
							onRef={(input) => {
								providerSearchInput = input;
							}}
							onFocus={() => store.setProviderFilterFocused(true)}
							onBlur={() => store.setProviderFilterFocused(false)}
							onSelect={store.setProviderIndex}
							onOpen={() => store.beginProviderRepos()}
						/>
					</Match>
					<Match when={store.view() === "provider-repos"}>
						<Show when={store.selectedProvider()}>
							{(provider) => (
								<ProviderReposView
									theme={theme}
									provider={provider()}
									repositories={store.providerRepos()}
									selected={store.providerRepoIndex()}
									query={store.providerRepoQuery()}
									focused={store.providerRepoSearchFocused()}
									onQuery={store.setProviderRepoQuery}
									onSubmit={() => void store.searchProviderRepos()}
									onRef={(input) => {
										providerRepoInput = input;
									}}
									onFocus={() => store.setProviderRepoSearchFocused(true)}
									onBlur={() => store.setProviderRepoSearchFocused(false)}
									onSelect={store.setProviderRepoIndex}
									onOpen={() => void store.openProviderRepo()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "provider-changes"}>
						<Show when={store.providerRepo() && store.selectedProvider()}>
							{
								<ProviderChangesView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									state={store.providerState()}
									changes={store.visibleProviderChanges()}
									selected={store.providerItemIndex()}
									query={store.providerFilter()}
									focused={store.providerFilterFocused()}
									onQuery={store.setProviderFilter}
									onSubmit={blurProviderFilter}
									onRef={(input) => {
										providerSearchInput = input;
									}}
									onFocus={() => store.setProviderFilterFocused(true)}
									onBlur={() => store.setProviderFilterFocused(false)}
									onSelect={store.setProviderItemIndex}
								/>
							}
						</Show>
					</Match>
					<Match when={store.view() === "provider-issues"}>
						<Show when={store.providerRepo() && store.selectedProvider()}>
							{
								<ProviderIssuesView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									state={store.providerState()}
									issues={store.visibleProviderIssues()}
									selected={store.providerItemIndex()}
									query={store.providerFilter()}
									focused={store.providerFilterFocused()}
									onQuery={store.setProviderFilter}
									onSubmit={blurProviderFilter}
									onRef={(input) => {
										providerSearchInput = input;
									}}
									onFocus={() => store.setProviderFilterFocused(true)}
									onBlur={() => store.setProviderFilterFocused(false)}
									onSelect={store.setProviderItemIndex}
								/>
							}
						</Show>
					</Match>
					<Match when={store.view() === "provider-pipelines"}>
						<Show when={store.providerRepo() && store.selectedProvider()}>
							{
								<ProviderPipelinesView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									pipelines={store.visibleProviderPipelines()}
									selected={store.providerItemIndex()}
									query={store.providerFilter()}
									focused={store.providerFilterFocused()}
									onQuery={store.setProviderFilter}
									onSubmit={blurProviderFilter}
									onRef={(input) => {
										providerSearchInput = input;
									}}
									onFocus={() => store.setProviderFilterFocused(true)}
									onBlur={() => store.setProviderFilterFocused(false)}
									onSelect={store.setProviderItemIndex}
									onOpen={() => void store.openProviderJobs()}
								/>
							}
						</Show>
					</Match>
					<Match when={store.view() === "provider-jobs"}>
						<Show
							when={
								store.providerRepo() &&
								store.selectedProvider() &&
								store.providerPipeline()
							}
						>
							{
								<ProviderJobsView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									pipeline={
										store.providerPipeline() ?? {
											id: 0,
											name: "",
											status: "",
											url: "",
										}
									}
									jobs={store.visibleProviderJobs()}
									selected={store.providerItemIndex()}
									query={store.providerFilter()}
									focused={store.providerFilterFocused()}
									onQuery={store.setProviderFilter}
									onSubmit={blurProviderFilter}
									onRef={(input) => {
										providerSearchInput = input;
									}}
									onFocus={() => store.setProviderFilterFocused(true)}
									onBlur={() => store.setProviderFilterFocused(false)}
									onSelect={store.setProviderItemIndex}
								/>
							}
						</Show>
					</Match>
					<Match when={store.view() === "provider-change"}>
						<Show when={store.providerChangeDetail()}>
							{(change) => (
								<ProviderChangeView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									change={change()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "provider-change-files"}>
						<Show when={store.providerFiles()}>
							{(files) => (
								<ProviderFilesView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									number={store.providerChangeDetail()?.number ?? 0}
									files={files()}
									selected={store.providerItemIndex()}
									onSelect={store.setProviderItemIndex}
									onOpen={() => store.openProviderFile()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "provider-file"}>
						<Show when={store.providerFile()}>
							{(file) => (
								<ProviderFileView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									file={file()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "provider-change-discussions"}>
						<ProviderDiscussionsView
							theme={theme}
							provider={store.selectedProvider()?.name ?? ""}
							repository={store.providerRepo()?.reference ?? ""}
							number={store.providerChangeDetail()?.number ?? 0}
							discussions={store.providerDiscussions()}
							selected={store.providerItemIndex()}
							onSelect={store.setProviderItemIndex}
						/>
					</Match>
					<Match when={store.view() === "provider-versions"}>
						<ProviderVersionsView
							theme={theme}
							provider={store.selectedProvider()?.name ?? ""}
							repository={store.providerRepo()?.reference ?? ""}
							number={store.providerChangeDetail()?.number ?? 0}
							versions={store.providerVersions()}
							selected={store.providerItemIndex()}
							onSelect={store.setProviderItemIndex}
						/>
					</Match>
					<Match when={store.view() === "provider-issue-comments"}>
						<ProviderDiscussionsView
							theme={theme}
							provider={store.selectedProvider()?.name ?? ""}
							repository={store.providerRepo()?.reference ?? ""}
							number={store.providerIssueDetail()?.number ?? 0}
							discussions={store.providerIssueComments()}
							selected={store.providerItemIndex()}
							onSelect={store.setProviderItemIndex}
						/>
					</Match>
					<Match when={store.view() === "provider-issue"}>
						<Show when={store.providerIssueDetail()}>
							{(issue) => (
								<ProviderIssueView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									issue={issue()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "provider-job-logs"}>
						<Show when={store.providerJobLogs()}>
							{(logs) => (
								<ProviderJobLogsView
									theme={theme}
									provider={store.selectedProvider()?.name ?? ""}
									repository={store.providerRepo()?.reference ?? ""}
									job={store.providerLogJob() ?? 0}
									logs={logs()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "container-stats"}>
						<Show when={store.containerStats()}>
							{(stats) => (
								<ContainerStatsView
									theme={theme}
									stats={stats()}
									history={store.containerHistory()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "clusters"}>
						<ClustersView
							theme={theme}
							clusters={store.clusters()}
							selected={store.clusterIndex()}
							onSelect={store.setClusterIndex}
							onOpen={() => store.beginClusterNamespace()}
						/>
					</Match>
					<Match when={store.view() === "cluster-namespace"}>
						<Show when={store.selectedCluster()}>
							{(cluster) => (
								<ClusterNamespaceView
									theme={theme}
									cluster={cluster()}
									namespace={store.clusterNamespace()}
									namespaces={store.clusterNamespaces()?.namespaces ?? []}
									selected={store.clusterNamespaceIndex()}
									focused={store.clusterNamespaceFocused()}
									onNamespace={store.setClusterNamespace}
									onSelect={store.selectClusterNamespace}
									onSubmit={() => void store.loadClusterResources()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "cluster-resources"}>
						<Show when={store.clusterResources()}>
							{(resources) => (
								<ClusterResourcesView
									theme={theme}
									resources={resources()}
									selected={store.clusterResourceIndex()}
									onSelect={store.setClusterResourceIndex}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "cluster-events"}>
						<Show when={store.clusterEvents()}>
							{(events) => (
								<ClusterEventsView
									theme={theme}
									events={events()}
									visible={store.visibleClusterEvents()}
									query={store.clusterEventQuery()}
									focused={store.clusterEventFilterFocused()}
									onQuery={store.setClusterEventQuery}
									onRef={(input) => {
										clusterEventInput = input;
									}}
									onSubmit={blurClusterEventFilter}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "cluster-describe"}>
						<Show when={store.clusterDescribe()}>
							{(describe) => (
								<ClusterDescribeView theme={theme} describe={describe()} />
							)}
						</Show>
					</Match>
					<Match when={store.view() === "cluster-pod-containers"}>
						<Show when={store.selectedClusterResource()}>
							{(resource) => (
								<ClusterPodContainersView
									theme={theme}
									resource={resource()}
									containers={resource().containers ?? []}
									selected={store.clusterContainerIndex()}
									onSelect={store.setClusterContainerIndex}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "cluster-pod-logs"}>
						<Show when={store.clusterPodLogs()}>
							{(logs) => <ClusterPodLogsView theme={theme} logs={logs()} />}
						</Show>
					</Match>
					<Match when={store.view() === "provider-merge"}>
						<ProviderMergeView
							theme={theme}
							provider={store.selectedProvider()?.name ?? ""}
							repository={store.providerRepo()?.reference ?? ""}
							number={store.providerChangeDetail()?.number ?? 0}
							selected={store.providerMergeIndex()}
							onSelect={store.selectProviderMerge}
						/>
					</Match>
					<Match when={store.view() === "provider-write"}>
						<ProviderWriteView
							theme={theme}
							action={store.providerWriteAction()}
							stage={store.providerWriteStage()}
							body={store.providerWriteBody()}
							digest={store.providerWriteDigest()}
							target={store.providerWriteTarget()}
							receipt={store.providerWriteReceipt()}
							onBody={store.setProviderWriteBody}
							onPreview={() => void store.previewProviderWrite()}
						/>
					</Match>
					<Match when={store.view() === "provider-writes"}>
						<ProviderWritesView theme={theme} writes={store.providerWrites()} />
					</Match>
					<Match when={store.view() === "config-write"}>
						<ConfigWriteView
							theme={theme}
							action={store.configAction()}
							stage={store.configStage()}
							field={store.configField()}
							id={store.configId()}
							kind={store.configKind()}
							repository={store.configRepository()}
							profile={store.configProfile()}
							targetAction={store.configTargetAction()}
							command={store.configCommand()}
							timeout={store.configTimeout()}
							defaultsBuild={store.configDefaultsBuild()}
							defaultsTest={store.configDefaultsTest()}
							defaultsRun={store.configDefaultsRun()}
							environment={store.configEnvironment()}
							secretRefs={store.configSecretRefs()}
							readyText={store.configReadyText()}
							endpoints={store.configEndpoints()}
							endpointServices={store.configEndpointServices()}
							prerequisites={store.configPrerequisites()}
							deleteTargets={store.configDeleteTargets()}
							source={store.configSource()}
							preview={store.configPreview()}
							result={store.configResult()}
							onId={store.setConfigId}
							onKind={store.setConfigKind}
							onRepository={store.setConfigRepository}
							onProfile={store.setConfigProfile}
							onTargetAction={store.setConfigTargetAction}
							onCommand={store.setConfigCommand}
							onTimeout={store.setConfigTimeout}
							onDefaultsBuild={store.setConfigDefaultsBuild}
							onDefaultsTest={store.setConfigDefaultsTest}
							onDefaultsRun={store.setConfigDefaultsRun}
							onEnvironment={store.setConfigEnvironment}
							onSecretRefs={store.setConfigSecretRefs}
							onReadyText={store.setConfigReadyText}
							onEndpoints={store.setConfigEndpoints}
							onEndpointServices={store.setConfigEndpointServices}
							onPrerequisites={store.setConfigPrerequisites}
							onPreview={() => void store.previewConfigWrite()}
						/>
					</Match>
					<Match when={store.view() === "detail"}>
						<Show
							when={selectedApp()}
							fallback={
								<text fg={theme.text.muted}>No application selected.</text>
							}
						>
							{(app) => (
								<AppDetail
									theme={theme}
									app={app()}
									status={store.status()}
									owned={store.owned()}
									git={store.git()}
									active={store.activeApps()}
									operations={store.operations()}
									subjects={store.subjectFor}
									worktree={
										store.executionWorktree()?.appId === app().id
											? store.executionWorktree()?.path
											: undefined
									}
									onExecute={(action, target) =>
										void store.executeTarget(action, target)
									}
									onStop={() => void store.stop()}
									onLogs={() => void store.loadLogs(app())}
									onHistory={() => store.selectTab("history")}
									onTelemetry={() => void store.loadTelemetry(app())}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "targets"}>
						<Show when={selectedApp()}>
							{(app) => (
								<TargetPicker
									theme={theme}
									app={app()}
									action={store.targetAction()}
									targets={store.targetList()}
									selected={store.targetIndex()}
									onSelect={store.setTargetIndex}
									onOpen={store.openSelected}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "history"}>
						<HistoryView
							theme={theme}
							operations={store.operations()}
							total={store.operationTotal()}
							selected={store.historyIndex()}
							subjects={store.subjectFor}
							onSelect={store.setHistoryIndex}
							onOpen={store.openSelected}
						/>
					</Match>
					<Match when={store.view() === "operation"}>
						<Show when={store.operation()}>
							{(operation) => (
								<OperationView
									theme={theme}
									context={props.context}
									active={active}
									operation={operation()}
									progress={store.progress()}
									receipt={store.receipt()}
									subject={store.operationSubject()}
									onRefresh={() => void store.refreshOperation()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "changes"}>
						<Show when={store.changes()}>
							{(changes) => (
								<Show when={selectedApp()}>
									{(app) => (
										<ChangesView
											theme={theme}
											app={app()}
											changes={changes()}
											selected={store.changeIndex()}
											onSelect={store.setChangeIndex}
											onOpen={() => void store.openSelectedChange()}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "diff"}>
						<Show when={store.diff()}>
							{(diff) => (
								<Show when={selectedApp()}>
									{(app) => (
										<DiffView theme={theme} app={app()} diff={diff()} />
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "git"}>
						<GitView
							theme={theme}
							visible={store.filteredBranches()}
							selected={store.branchIndex()}
							query={store.branchQuery()}
							note={store.branches()?.note}
							outcome={store.gitOutcome()}
							onSelect={store.setBranchIndex}
							onOpen={store.checkoutBranch}
						/>
					</Match>
					<Match when={store.view() === "worktrees"}>
						<Show when={store.worktrees()}>
							{(worktrees) => (
								<Show when={selectedApp()}>
									{(app) => (
										<WorktreesView
											theme={theme}
											app={app()}
											worktrees={worktrees()}
											selected={store.worktreeIndex()}
											executionWorktree={
												store.executionWorktree()?.appId === app().id
													? store.executionWorktree()?.path
													: undefined
											}
											onSelect={store.setWorktreeIndex}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "git-write"}>
						<GitWriteView
							theme={theme}
							action={store.gitWriteRequest()?.action}
							stage={store.gitWriteStage()}
							body={store.gitWriteBody()}
							digest={store.gitWriteDigest()}
							target={store.gitWriteTarget()}
							outcome={store.gitWriteOutcome()}
							onBody={store.setGitWriteBody}
							onPreview={() => void store.previewGitWrite()}
						/>
					</Match>
					<Match when={store.view() === "git-commit"}>
						<Show when={store.gitCommitDetail()}>
							{(detail) => <GitCommitView theme={theme} detail={detail()} />}
						</Show>
					</Match>
					<Match when={store.view() === "git-log"}>
						<Show when={store.gitLog()}>
							{(log) => (
								<GitLogView
									theme={theme}
									log={log()}
									selected={store.gitLogIndex()}
									onSelect={store.moveGitLog}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "tags"}>
						<Show when={store.tags()}>
							{(tags) => (
								<TagsView
									theme={theme}
									tags={tags()}
									selected={store.tagIndex()}
									onSelect={store.setTagIndex}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "tag-add"}>
						<TagAddView
							theme={theme}
							name={store.tagName()}
							message={store.tagMessage()}
							field={store.tagField()}
							onName={store.setTagName}
							onMessage={store.setTagMessage}
							onField={store.setTagField}
							onSubmit={() => void store.submitTagAdd()}
						/>
					</Match>
					<Match when={store.view() === "stashes"}>
						<Show when={store.stashes()}>
							{(stashes) => (
								<StashesView
									theme={theme}
									stashes={stashes()}
									selected={store.stashIndex()}
									onSelect={store.setStashIndex}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "worktree-add"}>
						<Show when={selectedApp()}>
							{(app) => (
								<WorktreeAddView
									theme={theme}
									app={app()}
									branch={store.worktreeBranch()}
									path={store.worktreePath()}
									field={store.worktreeField()}
									newBranch={
										!store
											.branches()
											?.branches.some(
												(entry) => entry.name === store.worktreeBranch(),
											)
									}
									onPathInput={store.setWorktreePath}
									onBranchInput={store.updateWorktreeBranch}
									onSubmit={() => void store.submitWorktreeAdd()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "remotes"}>
						<Show when={store.remotes()}>
							{(remotes) => (
								<Show when={selectedApp()}>
									{(app) => (
										<RemotesView
											theme={theme}
											app={app()}
											remotes={remotes()}
											selected={store.remoteIndex()}
											onSelect={store.setRemoteIndex}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "remote-add"}>
						<Show when={selectedApp()}>
							{(app) => (
								<RemoteAddView
									theme={theme}
									app={app()}
									name={store.remoteName()}
									url={store.remoteUrl()}
									field={store.remoteField()}
									onNameInput={store.setRemoteName}
									onUrlInput={store.setRemoteUrl}
									onSubmit={() => void store.submitRemoteAdd()}
								/>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "logs"}>
						<Show when={selectedApp()}>
							{(app) => (
								<Show when={store.logs()}>
									{(logs) => (
										<LogsView
											theme={theme}
											app={app()}
											logs={logs()}
											onReload={() => void store.loadLogs(app())}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "telemetry"}>
						<Show when={selectedApp()}>
							{(app) => (
								<Show when={store.telemetry()}>
									{(telemetry) => (
										<TelemetryView
											theme={theme}
											app={app()}
											telemetry={telemetry()}
											traceId={store.traceId()}
											selectedTraceIndex={store.traceIndex()}
											onSelectTrace={store.setTraceIndex}
											onOpenTrace={(trace) =>
												void store.openTrace(trace.traceId)
											}
										/>
									)}
								</Show>
							)}
						</Show>
					</Match>
					<Match when={store.view() === "services"}>
						<ServicesView theme={theme} services={store.services()} />
					</Match>
				</Switch>
			</box>
			<box height={1} flexShrink={0} />
			<StatusBar
				theme={theme}
				view={store.view()}
				message={message()}
				tone={tone()}
				right={right()}
				searchFocused={
					store.view() === "git"
						? store.branchSearchFocused()
						: store.view() === "provider-repos"
							? store.providerRepoSearchFocused()
							: store.view() === "providers" ||
									store.view() === "provider-changes" ||
									store.view() === "provider-issues" ||
									store.view() === "provider-pipelines" ||
									store.view() === "provider-jobs"
								? store.providerFilterFocused()
								: store.view() === "cluster-namespace"
									? store.clusterNamespaceFocused()
									: store.view() === "provider-write" &&
											store.providerWriteStage() === "edit"
										? true
										: store.searchFocused()
				}
				busy={store.busy()}
				panel={props.panel}
			/>
		</box>
	);
}
