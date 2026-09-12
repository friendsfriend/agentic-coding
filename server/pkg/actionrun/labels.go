package actionrun

import (
	"fmt"
	"strings"
)

// StepKind is a canonical, translatable identifier for what a step does.
// Every producer (Git, Kubernetes, generic command bridge, ...) must resolve
// a step's human label through this single registry instead of inventing
// its own formatting, parsing IDs, or relying on step position/order.
type StepKind string

// StepKindCommand signals "no specific classification"; StepLabel falls back
// to title-casing the raw command/verb text supplied by the caller.
const StepKindCommand StepKind = ""

const (
	StepKindGitRevParse       StepKind = "git.rev-parse"
	StepKindGitFetch          StepKind = "git.fetch"
	StepKindGitPull           StepKind = "git.pull"
	StepKindGitPush           StepKind = "git.push"
	StepKindGitClone          StepKind = "git.clone"
	StepKindGitStatus         StepKind = "git.status"
	StepKindGitListBranches   StepKind = "git.branch.list"
	StepKindGitSwitchBranch   StepKind = "git.switch"
	StepKindGitWorktreeList   StepKind = "git.worktree.list"
	StepKindGitWorktreeRemove StepKind = "git.worktree.remove"
	StepKindGitWorktreePrune  StepKind = "git.worktree.prune"

	StepKindKubernetesClusterCheck  StepKind = "kubernetes.cluster.check"
	StepKindKubernetesClusterCreate StepKind = "kubernetes.cluster.create"
	StepKindKubernetesClusterDelete StepKind = "kubernetes.cluster.delete"
	StepKindKubernetesClusterExport StepKind = "kubernetes.cluster.export"
	StepKindKubernetesSecretDelete  StepKind = "kubernetes.secret.delete"
	StepKindKubernetesSecretCreate  StepKind = "kubernetes.secret.create"
	StepKindKubernetesPortForward   StepKind = "kubernetes.port-forward"
	StepKindKubernetesHelmStatus    StepKind = "kubernetes.helm.status"
	StepKindKubernetesHelmUninstall StepKind = "kubernetes.helm.uninstall"
	StepKindKubernetesHelmInstall   StepKind = "kubernetes.helm.install"
	StepKindKubernetesImageBuild    StepKind = "kubernetes.image.build"
	StepKindKubernetesImageLoad     StepKind = "kubernetes.image.load"

	StepKindComposeStart StepKind = "compose.start"
	StepKindComposeStop  StepKind = "compose.stop"
	StepKindComposeBuild StepKind = "compose.build"
	StepKindComposePull  StepKind = "compose.pull"

	StepKindExecuteBuild StepKind = "command.build"
	StepKindExecuteTest  StepKind = "command.test"
	StepKindExecuteRun   StepKind = "command.run"
	StepKindExecuteStart StepKind = "command.start"
	StepKindExecuteStop  StepKind = "command.stop"
	StepKindExecute      StepKind = "command.execute"
)

// stepLabelTemplates maps a canonical StepKind to its display template.
// Templates containing "%s" are filled with the args passed to StepLabel, in
// order (e.g. a secret or port-forward name).
var stepLabelTemplates = map[StepKind]string{
	StepKindGitRevParse:       "Get ref",
	StepKindGitFetch:          "Fetch",
	StepKindGitPull:           "Pull",
	StepKindGitPush:           "Push",
	StepKindGitClone:          "Clone repository",
	StepKindGitStatus:         "Check status",
	StepKindGitListBranches:   "List branches",
	StepKindGitSwitchBranch:   "Switch branch",
	StepKindGitWorktreeList:   "List worktrees",
	StepKindGitWorktreeRemove: "Remove worktree",
	StepKindGitWorktreePrune:  "Prune worktrees",

	StepKindKubernetesClusterCheck:  "Check cluster",
	StepKindKubernetesClusterCreate: "Create cluster",
	StepKindKubernetesClusterDelete: "Delete cluster",
	StepKindKubernetesClusterExport: "Export kubeconfig",
	StepKindKubernetesSecretDelete:  "Delete secret %s",
	StepKindKubernetesSecretCreate:  "Create secret %s",
	StepKindKubernetesPortForward:   "Port-forward %s",
	StepKindKubernetesHelmStatus:    "Check release",
	StepKindKubernetesHelmUninstall: "Uninstall release",
	StepKindKubernetesHelmInstall:   "Install release",
	StepKindKubernetesImageBuild:    "Build image",
	StepKindKubernetesImageLoad:     "Load image into cluster",

	StepKindComposeStart: "Start containers",
	StepKindComposeStop:  "Stop containers",
	StepKindComposeBuild: "Build containers",
	StepKindComposePull:  "Pull container images",

	StepKindExecuteBuild: "Run build command",
	StepKindExecuteTest:  "Run test command",
	StepKindExecuteRun:   "Run application command",
	StepKindExecuteStart: "Run start command",
	StepKindExecuteStop:  "Run stop command",
	StepKindExecute:      "Run command",
}

// EncodeStepKind packs a base kind plus display args (e.g. a secret name)
// into a single wire-safe string usable anywhere a plain "kind" string is
// threaded through an event/callback. DecodeStepKind reverses it.
func EncodeStepKind(kind StepKind, args ...string) string {
	if len(args) == 0 {
		return string(kind)
	}
	return string(kind) + "|" + strings.Join(args, "|")
}

// DecodeStepKind splits a wire-encoded kind string back into its base kind
// and display args.
func DecodeStepKind(encoded string) (StepKind, []string) {
	parts := strings.Split(encoded, "|")
	return StepKind(parts[0]), parts[1:]
}

// StepLabel resolves a step's canonical kind (optionally produced by
// EncodeStepKind) into the one human label shown across the TUI. Unknown or
// empty kinds fall back to title-casing fallback (typically the raw executed
// command or verb) so every step still gets a readable label without a
// dedicated registry entry for every one-off command.
func StepLabel(encodedKind string, fallback string) string {
	kind, args := DecodeStepKind(encodedKind)
	tmpl, ok := stepLabelTemplates[kind]
	if !ok {
		return TitleCaseCommand(fallback)
	}
	if !strings.Contains(tmpl, "%s") {
		return tmpl
	}
	values := make([]interface{}, len(args))
	for i, a := range args {
		values[i] = a
	}
	return fmt.Sprintf(tmpl, values...)
}

// TitleCaseCommand renders a raw executed command/verb string as a readable
// step label when no explicit StepKind classification applies.
func TitleCaseCommand(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return "Command"
	}
	parts := strings.Fields(text)
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

// matchesVerb reports whether label is exactly the given verb phrase or
// starts with it followed by a space (i.e. the verb plus its arguments).
func matchesVerb(label string, verbs ...string) bool {
	phrase := strings.Join(verbs, " ")
	return label == phrase || strings.HasPrefix(label, phrase+" ")
}

// GitCommandStepKind classifies a git/wt argument string (e.g. "fetch
// --force origin ...") into its canonical StepKind by verb, not by step
// position or ID parsing, so every Git operation gets a consistent label
// regardless of which higher-level action (pull, checkout, worktree, ...)
// triggered it.
func GitCommandStepKind(commandArgs string) StepKind {
	label := strings.TrimSpace(commandArgs)
	switch {
	case matchesVerb(label, "worktree", "list"):
		return StepKindGitWorktreeList
	case matchesVerb(label, "worktree", "remove"):
		return StepKindGitWorktreeRemove
	case matchesVerb(label, "worktree", "prune"):
		return StepKindGitWorktreePrune
	case matchesVerb(label, "rev-parse"):
		return StepKindGitRevParse
	case matchesVerb(label, "fetch"):
		return StepKindGitFetch
	case matchesVerb(label, "reset"):
		return StepKindGitPull
	case matchesVerb(label, "push"):
		return StepKindGitPush
	case matchesVerb(label, "clone"):
		return StepKindGitClone
	case matchesVerb(label, "status"):
		return StepKindGitStatus
	case matchesVerb(label, "branch"):
		return StepKindGitListBranches
	case matchesVerb(label, "switch"):
		return StepKindGitSwitchBranch
	case matchesVerb(label, "remove"):
		// Worktrunk (wt) binary command form: "remove <branch> --yes".
		return StepKindGitWorktreeRemove
	default:
		return StepKindCommand
	}
}

// CommandStepKind classifies process commands observed by the generic action
// bridge. Raw command text remains on the command record; only the surrounding
// step gets this concise human-readable label.
func CommandStepKind(operation, command string, args []string) StepKind {
	base := strings.ToLower(strings.TrimSpace(command))
	joinedArgs := strings.ToLower(strings.TrimSpace(strings.Join(args, " ")))
	if strings.HasSuffix(base, "kind") {
		if kind := KubernetesClusterCommandStepKind(joinedArgs); kind != StepKindCommand {
			return kind
		}
	}
	if strings.HasSuffix(base, "helm") {
		for _, arg := range args {
			switch strings.ToLower(arg) {
			case "status", "list":
				return StepKindKubernetesHelmStatus
			case "install", "upgrade":
				return StepKindKubernetesHelmInstall
			case "uninstall":
				return StepKindKubernetesHelmUninstall
			}
		}
	}
	isCompose := strings.HasSuffix(base, "podman-compose") || strings.HasSuffix(base, "docker-compose") ||
		(strings.HasSuffix(base, "docker") && matchesVerb(joinedArgs, "compose")) ||
		(strings.HasSuffix(base, "podman") && matchesVerb(joinedArgs, "compose"))
	if isCompose {
		// Options and their values may precede the compose verb. Token matching is
		// deliberate here: paths can contain words such as "build" or "up".
		for _, arg := range args {
			switch strings.ToLower(arg) {
			case "up", "start", "create":
				return StepKindComposeStart
			case "down", "stop", "rm", "kill":
				return StepKindComposeStop
			case "build":
				return StepKindComposeBuild
			case "pull":
				return StepKindComposePull
			}
		}
	}

	switch strings.ToLower(strings.TrimSpace(operation)) {
	case "build":
		return StepKindExecuteBuild
	case "test":
		return StepKindExecuteTest
	case "run":
		return StepKindExecuteRun
	case "start":
		return StepKindExecuteStart
	case "stop":
		return StepKindExecuteStop
	case "":
		return StepKindExecute
	default:
		return StepKindExecute
	}

}

// KubernetesClusterCommandStepKind classifies a joined kind CLI argument
// string into its canonical StepKind for cluster lifecycle commands observed
// through the generic cluster service command observer.
func KubernetesClusterCommandStepKind(joinedArgs string) StepKind {
	switch {
	case strings.Contains(joinedArgs, "get clusters"):
		return StepKindKubernetesClusterCheck
	case strings.Contains(joinedArgs, "create cluster"):
		return StepKindKubernetesClusterCreate
	case strings.Contains(joinedArgs, "delete cluster"):
		return StepKindKubernetesClusterDelete
	case strings.Contains(joinedArgs, "export kubeconfig"):
		return StepKindKubernetesClusterExport
	default:
		return StepKindCommand
	}
}

// ActionKind buckets a machine action key (Run.Action, e.g. "git.pull",
// "kubernetes.cluster.create") into the coarse category used for grouping
// and filtering (Run.Kind). This is the single place that classification
// happens; producers must not duplicate this switch.
func ActionKind(action string) string {
	switch {
	case strings.Contains(action, "worktree"):
		return "worktree"
	case strings.HasPrefix(action, "git") || action == "checkout" || action == "pull" || action == "push" || action == "fetch":
		return "git"
	case strings.Contains(action, "kubernetes"):
		return "kubernetes"
	case strings.Contains(action, "infra"):
		return "infrastructure"
	case strings.Contains(action, "task") || strings.Contains(action, "script"):
		return "task"
	default:
		return "app"
	}
}
