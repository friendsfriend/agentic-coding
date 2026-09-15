// Canonical step labels and command classification for environment actions
// (`port-action-execution-to-bun`, task 1.2).
//
// Ported from `server/pkg/actionrun/labels.go`. This is the single place a
// step's human label is resolved: producers classify the operation, the label
// comes from the registry here, and no caller invents its own formatting or
// parses a step id. Both halves matter for parity — the run tree the TUI shows
// is labelled from this table, so a fallback that differs by one capital letter
// is a visible regression.
//
// `ActionKind` (the coarse run bucket) also lives here because it is the same
// classification question asked about an action key instead of a command.

/** `""` means "no specific classification"; the fallback command is title-cased. */
export const STEP_KIND_COMMAND = "";

export const STEP_KIND = {
	gitRevParse: "git.rev-parse",
	gitFetch: "git.fetch",
	gitPull: "git.pull",
	gitPush: "git.push",
	gitClone: "git.clone",
	gitStatus: "git.status",
	gitListBranches: "git.branch.list",
	gitSwitchBranch: "git.switch",
	gitWorktreeList: "git.worktree.list",
	gitWorktreeRemove: "git.worktree.remove",
	gitWorktreePrune: "git.worktree.prune",

	kubernetesClusterCheck: "kubernetes.cluster.check",
	kubernetesClusterCreate: "kubernetes.cluster.create",
	kubernetesClusterDelete: "kubernetes.cluster.delete",
	kubernetesClusterExport: "kubernetes.cluster.export",
	kubernetesSecretDelete: "kubernetes.secret.delete",
	kubernetesSecretCreate: "kubernetes.secret.create",
	kubernetesPortForward: "kubernetes.port-forward",
	kubernetesHelmStatus: "kubernetes.helm.status",
	kubernetesHelmUninstall: "kubernetes.helm.uninstall",
	kubernetesHelmInstall: "kubernetes.helm.install",
	kubernetesImageBuild: "kubernetes.image.build",
	kubernetesImageLoad: "kubernetes.image.load",

	composeStart: "compose.start",
	composeStop: "compose.stop",
	composeBuild: "compose.build",
	composePull: "compose.pull",

	executeBuild: "command.build",
	executeTest: "command.test",
	executeRun: "command.run",
	executeStart: "command.start",
	executeStop: "command.stop",
	execute: "command.execute",
} as const;

export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND] | string;

/** Templates containing `%s` are filled with the encoded args, in order. */
const STEP_LABEL_TEMPLATES: Record<string, string> = {
	[STEP_KIND.gitRevParse]: "Get ref",
	[STEP_KIND.gitFetch]: "Fetch",
	[STEP_KIND.gitPull]: "Pull",
	[STEP_KIND.gitPush]: "Push",
	[STEP_KIND.gitClone]: "Clone repository",
	[STEP_KIND.gitStatus]: "Check status",
	[STEP_KIND.gitListBranches]: "List branches",
	[STEP_KIND.gitSwitchBranch]: "Switch branch",
	[STEP_KIND.gitWorktreeList]: "List worktrees",
	[STEP_KIND.gitWorktreeRemove]: "Remove worktree",
	[STEP_KIND.gitWorktreePrune]: "Prune worktrees",

	[STEP_KIND.kubernetesClusterCheck]: "Check cluster",
	[STEP_KIND.kubernetesClusterCreate]: "Create cluster",
	[STEP_KIND.kubernetesClusterDelete]: "Delete cluster",
	[STEP_KIND.kubernetesClusterExport]: "Export kubeconfig",
	[STEP_KIND.kubernetesSecretDelete]: "Delete secret %s",
	[STEP_KIND.kubernetesSecretCreate]: "Create secret %s",
	[STEP_KIND.kubernetesPortForward]: "Port-forward %s",
	[STEP_KIND.kubernetesHelmStatus]: "Check release",
	[STEP_KIND.kubernetesHelmUninstall]: "Uninstall release",
	[STEP_KIND.kubernetesHelmInstall]: "Install release",
	[STEP_KIND.kubernetesImageBuild]: "Build image",
	[STEP_KIND.kubernetesImageLoad]: "Load image into cluster",

	[STEP_KIND.composeStart]: "Start containers",
	[STEP_KIND.composeStop]: "Stop containers",
	[STEP_KIND.composeBuild]: "Build containers",
	[STEP_KIND.composePull]: "Pull container images",

	[STEP_KIND.executeBuild]: "Run build command",
	[STEP_KIND.executeTest]: "Run test command",
	[STEP_KIND.executeRun]: "Run application command",
	[STEP_KIND.executeStart]: "Run start command",
	[STEP_KIND.executeStop]: "Run stop command",
	[STEP_KIND.execute]: "Run command",
};

/** Packs a base kind plus display args into a wire-safe `kind` string. */
export function encodeStepKind(kind: string, ...args: string[]): string {
	if (args.length === 0) return kind;
	return `${kind}|${args.join("|")}`;
}

/** Splits a wire-encoded kind back into its base kind and display args. */
export function decodeStepKind(encoded: string): {
	kind: string;
	args: string[];
} {
	const parts = encoded.split("|");
	return { kind: parts[0] ?? "", args: parts.slice(1) };
}

/**
 * Resolves a step's canonical kind into the one human label shown across the
 * TUI. Unknown or empty kinds fall back to title-casing the raw executed
 * command so every step stays readable without a registry entry.
 */
export function stepLabel(encodedKind: string, fallback: string): string {
	const { kind, args } = decodeStepKind(encodedKind);
	const template = STEP_LABEL_TEMPLATES[kind];
	if (template === undefined) return titleCaseCommand(fallback);
	if (!template.includes("%s")) return template;
	let index = 0;
	return template.replace(/%s/g, () => args[index++] ?? "");
}

/** Renders a raw executed command as a readable label. */
export function titleCaseCommand(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "") return "Command";
	return trimmed
		.split(/\s+/)
		.map((part) =>
			part === "" ? part : part.slice(0, 1).toUpperCase() + part.slice(1),
		)
		.join(" ");
}

/** Whether `label` is exactly the verb phrase or the verb plus its arguments. */
function matchesVerb(label: string, ...verbs: string[]): boolean {
	const phrase = verbs.join(" ");
	return label === phrase || label.startsWith(`${phrase} `);
}

/**
 * Classifies a git/wt argument string by verb, not by step position or id
 * parsing, so every Git operation gets a consistent label.
 */
export function gitCommandStepKind(commandArgs: string): string {
	const label = commandArgs.trim();
	switch (true) {
		case matchesVerb(label, "worktree", "list"):
			return STEP_KIND.gitWorktreeList;
		case matchesVerb(label, "worktree", "remove"):
			return STEP_KIND.gitWorktreeRemove;
		case matchesVerb(label, "worktree", "prune"):
			return STEP_KIND.gitWorktreePrune;
		case matchesVerb(label, "rev-parse"):
			return STEP_KIND.gitRevParse;
		case matchesVerb(label, "fetch"):
			return STEP_KIND.gitFetch;
		case matchesVerb(label, "reset"):
			return STEP_KIND.gitPull;
		case matchesVerb(label, "push"):
			return STEP_KIND.gitPush;
		case matchesVerb(label, "clone"):
			return STEP_KIND.gitClone;
		case matchesVerb(label, "status"):
			return STEP_KIND.gitStatus;
		case matchesVerb(label, "branch"):
			return STEP_KIND.gitListBranches;
		case matchesVerb(label, "switch"):
			return STEP_KIND.gitSwitchBranch;
		case matchesVerb(label, "remove"):
			// Worktrunk (wt) binary command form: "remove <branch> --yes".
			return STEP_KIND.gitWorktreeRemove;
		default:
			return STEP_KIND_COMMAND;
	}
}

/** Classifies a joined `kind` CLI argument string into a cluster-lifecycle kind. */
export function kubernetesClusterCommandStepKind(joinedArgs: string): string {
	switch (true) {
		case joinedArgs.includes("get clusters"):
			return STEP_KIND.kubernetesClusterCheck;
		case joinedArgs.includes("create cluster"):
			return STEP_KIND.kubernetesClusterCreate;
		case joinedArgs.includes("delete cluster"):
			return STEP_KIND.kubernetesClusterDelete;
		case joinedArgs.includes("export kubeconfig"):
			return STEP_KIND.kubernetesClusterExport;
		default:
			return STEP_KIND_COMMAND;
	}
}

/**
 * Classifies a process command observed by the generic action bridge. Raw
 * command text stays on the command record; only the surrounding step gets this
 * concise label.
 */
export function commandStepKind(
	operation: string,
	command: string,
	args: readonly string[],
): string {
	const base = command.trim().toLowerCase();
	const joinedArgs = args.join(" ").trim().toLowerCase();
	if (base.endsWith("kind")) {
		const kind = kubernetesClusterCommandStepKind(joinedArgs);
		if (kind !== STEP_KIND_COMMAND) return kind;
	}
	if (base.endsWith("helm")) {
		for (const arg of args) {
			switch (arg.toLowerCase()) {
				case "status":
				case "list":
					return STEP_KIND.kubernetesHelmStatus;
				case "install":
				case "upgrade":
					return STEP_KIND.kubernetesHelmInstall;
				case "uninstall":
					return STEP_KIND.kubernetesHelmUninstall;
			}
		}
	}
	const isCompose =
		base.endsWith("podman-compose") ||
		base.endsWith("docker-compose") ||
		(base.endsWith("docker") && matchesVerb(joinedArgs, "compose")) ||
		(base.endsWith("podman") && matchesVerb(joinedArgs, "compose"));
	if (isCompose) {
		// Options and their values may precede the compose verb. Token matching
		// is deliberate: paths can contain words such as "build" or "up".
		for (const arg of args) {
			switch (arg.toLowerCase()) {
				case "up":
				case "start":
				case "create":
					return STEP_KIND.composeStart;
				case "down":
				case "stop":
				case "rm":
				case "kill":
					return STEP_KIND.composeStop;
				case "build":
					return STEP_KIND.composeBuild;
				case "pull":
					return STEP_KIND.composePull;
			}
		}
	}
	switch (operation.trim().toLowerCase()) {
		case "build":
			return STEP_KIND.executeBuild;
		case "test":
			return STEP_KIND.executeTest;
		case "run":
			return STEP_KIND.executeRun;
		case "start":
			return STEP_KIND.executeStart;
		case "stop":
			return STEP_KIND.executeStop;
		default:
			return STEP_KIND.execute;
	}
}

/** Coarse run bucket for an action key, used for grouping and filtering. */
export function actionKind(action: string): string {
	switch (true) {
		case action.includes("worktree"):
			return "worktree";
		case action.startsWith("git") ||
			action === "checkout" ||
			action === "pull" ||
			action === "push" ||
			action === "fetch":
			return "git";
		case action.includes("kubernetes"):
			return "kubernetes";
		case action.includes("infra"):
			return "infrastructure";
		case action.includes("task") || action.includes("script"):
			return "task";
		default:
			return "app";
	}
}
