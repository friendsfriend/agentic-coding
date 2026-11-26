import type { EnvironmentView } from "./model.ts";

export type Keybind = {
	readonly key: string;
	readonly action: string;
	readonly short?: string;
	readonly standard?: boolean;
};

const HELP: Keybind = { key: "?", action: "help", short: "help" };

const SEARCH: readonly Keybind[] = [
	{ key: "Enter", action: "focus the filtered list", short: "list" },
	{ key: "↑/↓", action: "move filtered results", standard: true },
	{ key: "Esc", action: "clear filter", short: "clear" },
];

const TABLE: readonly Keybind[] = [
	{ key: "↑/↓", action: "move selection", standard: true },
	{ key: "j/k", action: "move selection", standard: true },
	{ key: "Enter", action: "open application", short: "open" },
	{ key: "/", action: "filter", short: "filter" },
	{ key: "Tab", action: "next tab", short: "next" },
	{ key: "1–5", action: "switch tab", standard: true },
	{ key: "n", action: "new application", short: "new app" },
	{ key: "p", action: "providers", short: "providers" },
	{ key: "c", action: "change requests", short: "changes" },
	{ key: "i", action: "provider issues", short: "issues" },
	{ key: "K", action: "kubernetes clusters", short: "clusters" },
	{ key: "r", action: "refresh", short: "refresh" },
	{ key: "Esc", action: "close environments", short: "close" },
	HELP,
];

const DETAIL: readonly Keybind[] = [
	{ key: "b", action: "build", short: "build" },
	{ key: "s", action: "start / run", short: "run" },
	{ key: "t", action: "test", short: "test" },
	{ key: "S", action: "stop owned resources", short: "stop" },
	{ key: "g", action: "git", short: "git" },
	{ key: "c", action: "changes", short: "changes" },
	{ key: "l", action: "logs", short: "logs" },
	{ key: "L", action: "history", short: "history" },
	{ key: "e", action: "telemetry", short: "telemetry" },
	{ key: "E", action: "edit application", short: "edit" },
	{ key: "X", action: "delete application", short: "delete" },
	{ key: "m", action: "container stats", short: "stats" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const TARGETS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move target", standard: true },
	{ key: "j/k", action: "move target", standard: true },
	{ key: "Enter", action: "execute target", short: "execute" },
	{ key: "n", action: "new shell target", short: "new" },
	{ key: "d", action: "duplicate target", short: "duplicate" },
	{ key: "e", action: "edit target", short: "edit" },
	{ key: "x", action: "delete target", short: "delete" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const CONFIG_WRITE: readonly Keybind[] = [
	{ key: "Tab", action: "next field", short: "field" },
	{ key: "y", action: "confirm write", short: "confirm" },
	{ key: "t", action: "toggle target cascade", short: "cascade" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const HISTORY: readonly Keybind[] = [
	{ key: "↑/↓", action: "move receipt", standard: true },
	{ key: "j/k", action: "move receipt", standard: true },
	{ key: "Enter", action: "open receipt", short: "open" },
	{ key: "r", action: "refresh history", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const OPERATION: readonly Keybind[] = [
	{ key: "Tab", action: "switch operation tab", short: "tabs" },
	{
		key: "Shift+Tab",
		action: "switch operation tab backwards",
		standard: true,
	},
	{ key: "1–3", action: "select operation tab", standard: true },
	{ key: "↑/↓", action: "move build step", standard: true },
	{ key: "j/k", action: "move build step", standard: true },
	{ key: "r", action: "refresh operation", short: "refresh" },
	{ key: "Esc", action: "back", short: "back" },
	HELP,
];

const LOGS: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll logs", standard: true },
	{ key: "r", action: "reload logs", short: "reload" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const CLUSTERS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move cluster", standard: true },
	{ key: "j/k", action: "move cluster", standard: true },
	{ key: "Enter", action: "choose namespace", short: "namespace" },
	{ key: "r", action: "refresh clusters", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const CLUSTER_NAMESPACE: readonly Keybind[] = [
	{ key: "↑/↓", action: "move namespace", standard: true },
	{ key: "j/k", action: "move namespace", standard: true },
	{ key: "/", action: "type namespace", short: "type" },
	{ key: "Enter", action: "inspect namespace", short: "inspect" },
	{ key: "Esc", action: "back to clusters", short: "back" },
];

const CLUSTER_RESOURCES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move resource", standard: true },
	{ key: "j/k", action: "move resource", standard: true },
	{ key: "Enter", action: "describe resource", short: "describe" },
	{ key: "e", action: "namespace events", short: "events" },
	{ key: "l", action: "pod logs", short: "logs" },
	{ key: "r", action: "refresh resources", short: "refresh" },
	{ key: "Esc", action: "back to clusters", short: "back" },
];

const CLUSTER_EVENTS: readonly Keybind[] = [
	{ key: "/", action: "filter events", short: "filter" },
	{ key: "r", action: "refresh events", short: "refresh" },
	{ key: "Esc", action: "back to resources", short: "back" },
];

const CLUSTER_DESCRIBE: readonly Keybind[] = [
	{ key: "r", action: "refresh describe", short: "refresh" },
	{ key: "Esc", action: "back to resources", short: "back" },
];

const CLUSTER_POD_LOGS: readonly Keybind[] = [
	{ key: "p", action: "toggle previous logs", short: "previous" },
	{ key: "r", action: "reload pod logs", short: "reload" },
	{ key: "Esc", action: "back", short: "back" },
];

const CLUSTER_POD_CONTAINERS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move container", standard: true },
	{ key: "j/k", action: "move container", standard: true },
	{ key: "Enter", action: "open container logs", short: "logs" },
	{ key: "Esc", action: "back to resources", short: "back" },
];

const CONTAINER_STATS: readonly Keybind[] = [
	{ key: "r", action: "refresh stats", short: "refresh" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const TELEMETRY: readonly Keybind[] = [
	{ key: "↑/↓", action: "move trace", standard: true },
	{ key: "j/k", action: "move trace", standard: true },
	{ key: "Enter", action: "open trace", short: "open" },
	{ key: "Esc", action: "back to application", short: "back" },
	HELP,
];

const CHANGES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move change", standard: true },
	{ key: "j/k", action: "move change", standard: true },
	{ key: "Enter", action: "open diff", short: "diff" },
	{ key: "s", action: "stage / unstage path", short: "stage" },
	{ key: "a", action: "stage all", short: "stage all" },
	{ key: "u", action: "unstage all", short: "unstage all" },
	{ key: "r", action: "refresh changes", short: "refresh" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const DIFF: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll diff", standard: true },
	{ key: "s", action: "cycle diff side", short: "side" },
	{ key: "r", action: "reload diff", short: "reload" },
	{ key: "Esc", action: "back to changes", short: "back" },
];

const GIT: readonly Keybind[] = [
	{ key: "/", action: "filter branches", short: "filter" },
	{ key: "↑/↓", action: "move branch", standard: true },
	{ key: "j/k", action: "move branch", standard: true },
	{ key: "Enter", action: "switch branch", short: "switch" },
	{ key: "f", action: "fetch", short: "fetch" },
	{ key: "p", action: "pull fast-forward", short: "pull" },
	{ key: "P", action: "push branch", short: "push" },
	{ key: "F", action: "force push with lease", short: "force push" },
	{ key: "X", action: "abort rebase", short: "abort rebase" },
	{ key: "t", action: "create tag", short: "tag" },
	{ key: "T", action: "list tags", short: "tags" },
	{ key: "L", action: "commit history", short: "log" },
	{ key: "R", action: "rename branch", short: "rename" },
	{ key: "C", action: "commit staged changes", short: "commit" },
	{ key: "A", action: "commit all changes", short: "commit all" },
	{ key: "s", action: "stash changes", short: "stash" },
	{ key: "S", action: "list stashes", short: "stashes" },
	{ key: "M", action: "merge branch", short: "merge" },
	{ key: "B", action: "rebase onto branch", short: "rebase" },
	{ key: "w", action: "worktrees", short: "worktrees" },
	{ key: "m", action: "remotes", short: "remotes" },
	{ key: "d", action: "delete branch", short: "delete" },
	{ key: "c", action: "changes", short: "changes" },
	{ key: "r", action: "refresh git", short: "refresh" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const GIT_LOG: readonly Keybind[] = [
	{ key: "↑/↓", action: "move commit", standard: true },
	{ key: "j/k", action: "move commit", standard: true },
	{ key: "Enter", action: "open commit", short: "open" },
	{ key: "r", action: "refresh log", short: "refresh" },
	{ key: "Esc", action: "back to git", short: "back" },
];

const GIT_COMMIT: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll commit", standard: true },
	{ key: "r", action: "refresh commit", short: "refresh" },
	{ key: "Esc", action: "back to history", short: "back" },
];

const TAGS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move tag", standard: true },
	{ key: "j/k", action: "move tag", standard: true },
	{ key: "t", action: "create tag", short: "create" },
	{ key: "d", action: "delete tag", short: "delete" },
	{ key: "r", action: "refresh tags", short: "refresh" },
	{ key: "Esc", action: "back to git", short: "back" },
];

const TAG_ADD: readonly Keybind[] = [
	{ key: "Tab", action: "switch field", short: "field" },
	{ key: "Enter", action: "preview tag", short: "preview" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const STASHES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move stash", standard: true },
	{ key: "j/k", action: "move stash", standard: true },
	{ key: "p", action: "pop stash", short: "pop" },
	{ key: "a", action: "apply stash", short: "apply" },
	{ key: "d", action: "drop stash", short: "drop" },
	{ key: "r", action: "refresh stashes", short: "refresh" },
	{ key: "Esc", action: "back to git", short: "back" },
];

const GIT_WRITE: readonly Keybind[] = [
	{ key: "Enter", action: "preview write", short: "preview" },
	{ key: "y", action: "confirm write", short: "confirm" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const WORKTREES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move worktree", standard: true },
	{ key: "j/k", action: "move worktree", standard: true },
	{ key: "a", action: "add worktree", short: "add" },
	{ key: "u", action: "run targets in worktree", short: "use" },
	{ key: "x", action: "remove worktree", short: "remove" },
	{ key: "r", action: "refresh worktrees", short: "refresh" },
	{ key: "Esc", action: "back to git", short: "back" },
];

const PROVIDERS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move provider", standard: true },
	{ key: "j/k", action: "move provider", standard: true },
	{ key: "Enter", action: "search repositories", short: "repos" },
	{ key: "w", action: "write receipts", short: "writes" },
	{ key: "r", action: "refresh providers", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const PROVIDER_REPOS: readonly Keybind[] = [
	{ key: "/", action: "search repositories", short: "search" },
	{ key: "Enter", action: "open repository", short: "open" },
	{ key: "↑/↓", action: "move repository", standard: true },
	{ key: "j/k", action: "move repository", standard: true },
	{ key: "Esc", action: "back to providers", short: "back" },
	HELP,
];

const PROVIDER_LIST: readonly Keybind[] = [
	{ key: "/", action: "filter", short: "filter" },
	{ key: "↑/↓", action: "move item", standard: true },
	{ key: "j/k", action: "move item", standard: true },
	{ key: "Enter", action: "open detail", short: "open" },
	{ key: "c", action: "changes", short: "changes" },
	{ key: "i", action: "issues", short: "issues" },
	{ key: "l", action: "pipelines", short: "pipelines" },
	{ key: "s", action: "cycle state", short: "state" },
	{ key: "r", action: "refresh", short: "refresh" },
	{ key: "Esc", action: "back to repositories", short: "back" },
	HELP,
];

const PROVIDER_PIPELINES: readonly Keybind[] = [
	{ key: "/", action: "filter", short: "filter" },
	{ key: "↑/↓", action: "move pipeline", standard: true },
	{ key: "j/k", action: "move pipeline", standard: true },
	{ key: "Enter", action: "open jobs", short: "jobs" },
	{ key: "t", action: "retry pipeline", short: "retry" },
	{ key: "x", action: "cancel pipeline", short: "cancel" },
	{ key: "c", action: "changes", short: "changes" },
	{ key: "i", action: "issues", short: "issues" },
	{ key: "r", action: "refresh", short: "refresh" },
	{ key: "Esc", action: "back to repositories", short: "back" },
	HELP,
];

const PROVIDER_CHANGE: readonly Keybind[] = [
	{ key: "d", action: "diff and changed files", short: "diff" },
	{ key: "h", action: "discussion history", short: "history" },
	{ key: "v", action: "version history", short: "versions" },
	{ key: "c", action: "comment", short: "comment" },
	{ key: "a", action: "approve exact head", short: "approve" },
	{ key: "M", action: "merge change", short: "merge" },
	{ key: "B", action: "rebase change", short: "rebase" },
	{ key: "u", action: "withdraw approval", short: "unapprove" },
	{ key: "l", action: "add labels", short: "labels" },
	{ key: "A", action: "set assignees", short: "assign" },
	{ key: "r", action: "refresh change", short: "refresh" },
	{ key: "Esc", action: "back to changes", short: "back" },
	HELP,
];

const PROVIDER_FILES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move file", standard: true },
	{ key: "j/k", action: "move file", standard: true },
	{ key: "Enter", action: "open patch", short: "patch" },
	{ key: "r", action: "refresh files", short: "refresh" },
	{ key: "Esc", action: "back to change", short: "back" },
	HELP,
];

const PROVIDER_FILE: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll patch", standard: true },
	{ key: "Esc", action: "back to files", short: "back" },
];

const PROVIDER_DISCUSSIONS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move discussion", standard: true },
	{ key: "j/k", action: "move discussion", standard: true },
	{ key: "c", action: "reply", short: "reply" },
	{ key: "x", action: "resolve / unresolve", short: "resolve" },
	{ key: "r", action: "refresh discussions", short: "refresh" },
	{ key: "Esc", action: "back to change", short: "back" },
];

const PROVIDER_ISSUE_COMMENTS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move comment", standard: true },
	{ key: "j/k", action: "move comment", standard: true },
	{ key: "c", action: "reply", short: "reply" },
	{ key: "r", action: "refresh comments", short: "refresh" },
	{ key: "Esc", action: "back to issue", short: "back" },
];

const PROVIDER_ISSUE: readonly Keybind[] = [
	{ key: "c", action: "comment", short: "comment" },
	{ key: "h", action: "comment history", short: "history" },
	{ key: "o", action: "open / close issue", short: "state" },
	{ key: "l", action: "add labels", short: "labels" },
	{ key: "A", action: "set assignees", short: "assign" },
	{ key: "r", action: "refresh issue", short: "refresh" },
	{ key: "Esc", action: "back to issues", short: "back" },
];

const PROVIDER_VERSIONS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move version", standard: true },
	{ key: "j/k", action: "move version", standard: true },
	{ key: "r", action: "refresh versions", short: "refresh" },
	{ key: "Esc", action: "back to change", short: "back" },
];

const PROVIDER_MERGE: readonly Keybind[] = [
	{ key: "↑/↓", action: "move merge method", standard: true },
	{ key: "j/k", action: "move merge method", standard: true },
	{ key: "Enter", action: "choose merge method", short: "choose" },
	{ key: "Esc", action: "back to change", short: "back" },
];

const PROVIDER_WRITE: readonly Keybind[] = [
	{ key: "Enter", action: "preview write", short: "preview" },
	{ key: "y", action: "confirm write", short: "confirm" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const PROVIDER_WRITES: readonly Keybind[] = [
	{ key: "r", action: "refresh writes", short: "refresh" },
	{ key: "Esc", action: "back to providers", short: "back" },
];

const PROVIDER_JOB_LOGS: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll job log", standard: true },
	{ key: "r", action: "reload job log", short: "reload" },
	{ key: "Esc", action: "back to jobs", short: "back" },
];

const PROVIDER_JOBS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move job", standard: true },
	{ key: "j/k", action: "move job", standard: true },
	{ key: "Enter", action: "open job log", short: "log" },
	{ key: "t", action: "retry job", short: "retry" },
	{ key: "r", action: "refresh jobs", short: "refresh" },
	{ key: "Esc", action: "back to pipelines", short: "back" },
	HELP,
];

const REMOTES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move remote", standard: true },
	{ key: "j/k", action: "move remote", standard: true },
	{ key: "a", action: "add remote", short: "add" },
	{ key: "e", action: "edit remote URL", short: "edit" },
	{ key: "x", action: "remove remote", short: "remove" },
	{ key: "r", action: "refresh remotes", short: "refresh" },
	{ key: "Esc", action: "back to git", short: "back" },
];

const REMOTE_ADD: readonly Keybind[] = [
	{ key: "Tab", action: "switch field", short: "field" },
	{ key: "Enter", action: "add remote", short: "add" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const WORKTREE_ADD: readonly Keybind[] = [
	{ key: "Tab", action: "switch field", short: "field" },
	{ key: "Enter", action: "create worktree", short: "create" },
	{ key: "Esc", action: "cancel", short: "cancel" },
];

const SERVICES: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll services", standard: true },
	{ key: "r", action: "refresh services", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
];

export function viewKeybinds(view: EnvironmentView): readonly Keybind[] {
	switch (view) {
		case "table":
			return TABLE;
		case "detail":
			return DETAIL;
		case "targets":
			return TARGETS;
		case "history":
			return HISTORY;
		case "operation":
			return OPERATION;
		case "logs":
			return LOGS;
		case "telemetry":
			return TELEMETRY;
		case "container-stats":
			return CONTAINER_STATS;
		case "config-write":
			return CONFIG_WRITE;
		case "clusters":
			return CLUSTERS;
		case "cluster-namespace":
			return CLUSTER_NAMESPACE;
		case "cluster-resources":
			return CLUSTER_RESOURCES;
		case "cluster-events":
			return CLUSTER_EVENTS;
		case "cluster-describe":
			return CLUSTER_DESCRIBE;
		case "cluster-pod-logs":
			return CLUSTER_POD_LOGS;
		case "cluster-pod-containers":
			return CLUSTER_POD_CONTAINERS;
		case "changes":
			return CHANGES;
		case "diff":
			return DIFF;
		case "git":
			return GIT;
		case "git-write":
			return GIT_WRITE;
		case "git-log":
			return GIT_LOG;
		case "git-commit":
			return GIT_COMMIT;
		case "tags":
			return TAGS;
		case "tag-add":
			return TAG_ADD;
		case "stashes":
			return STASHES;
		case "worktrees":
			return WORKTREES;
		case "worktree-add":
			return WORKTREE_ADD;
		case "remotes":
			return REMOTES;
		case "remote-add":
			return REMOTE_ADD;
		case "providers":
			return PROVIDERS;
		case "provider-repos":
			return PROVIDER_REPOS;
		case "provider-changes":
		case "provider-issues":
			return PROVIDER_LIST;
		case "provider-pipelines":
			return PROVIDER_PIPELINES;
		case "provider-jobs":
			return PROVIDER_JOBS;
		case "provider-change":
			return PROVIDER_CHANGE;
		case "provider-change-files":
			return PROVIDER_FILES;
		case "provider-file":
			return PROVIDER_FILE;
		case "provider-change-discussions":
			return PROVIDER_DISCUSSIONS;
		case "provider-issue":
			return PROVIDER_ISSUE;
		case "provider-job-logs":
			return PROVIDER_JOB_LOGS;
		case "provider-issue-comments":
			return PROVIDER_ISSUE_COMMENTS;
		case "provider-versions":
			return PROVIDER_VERSIONS;
		case "provider-merge":
			return PROVIDER_MERGE;
		case "provider-write":
			return PROVIDER_WRITE;
		case "provider-writes":
			return PROVIDER_WRITES;
		case "services":
			return SERVICES;
	}
}

export function footerKeybinds(
	view: EnvironmentView,
	searchFocused = false,
): readonly Keybind[] {
	if ((view === "table" || view === "git") && searchFocused)
		return SEARCH.filter((entry) => !entry.standard);
	return viewKeybinds(view).filter((entry) => !entry.standard);
}

export type HelpSection = {
	readonly title: string;
	readonly entries: readonly Keybind[];
};

export const HELP_SECTIONS: readonly HelpSection[] = [
	{ title: "Browse", entries: TABLE },
	{
		title: "Filter",
		entries: [
			{ key: "Enter", action: "focus the filtered list", short: "list" },
			{ key: "↑/↓", action: "move filtered results", standard: true },
			{ key: "Esc", action: "clear filter", short: "clear" },
		],
	},
	{ title: "Application detail", entries: DETAIL },
	{
		title: "Application config",
		entries: [...CONFIG_WRITE, ...TARGETS],
	},
	{
		title: "Providers",
		entries: [
			...PROVIDERS,
			...PROVIDER_REPOS,
			...PROVIDER_LIST,
			...PROVIDER_PIPELINES,
			...PROVIDER_JOBS,
			...PROVIDER_CHANGE,
			...PROVIDER_FILES,
			...PROVIDER_FILE,
			...PROVIDER_DISCUSSIONS,
			...PROVIDER_ISSUE,
			...PROVIDER_JOB_LOGS,
			...PROVIDER_VERSIONS,
			...PROVIDER_WRITE,
			...PROVIDER_WRITES,
		],
	},
	{
		title: "Git",
		entries: [...GIT, ...WORKTREES, ...WORKTREE_ADD, ...REMOTES, ...REMOTE_ADD],
	},
	{ title: "Changes", entries: [...CHANGES, ...DIFF] },
	{
		title: "Kubernetes",
		entries: [...CLUSTERS, ...CLUSTER_NAMESPACE, ...CLUSTER_RESOURCES],
	},
	{
		title: "Execute and observe",
		entries: [...TARGETS, ...OPERATION, ...CONTAINER_STATS],
	},
	{
		title: "Receipts and evidence",
		entries: [...HISTORY, ...LOGS, ...TELEMETRY],
	},
	{
		title: "Open from anywhere",
		entries: [
			{ key: "/environment", action: "open environments" },
			{ key: "<leader>v", action: "open environments" },
			{ key: "/issues", action: "issues for current directory" },
			{ key: "/changes", action: "changes for current directory" },
			{ key: "/git", action: "git for current directory" },
			{ key: "<leader>G", action: "git for current directory" },
		],
	},
];
