package actionrun

import (
	"strings"
	"testing"
)

func TestStepLabelResolvesRegisteredKinds(t *testing.T) {
	cases := []struct {
		kind StepKind
		args []string
		want string
	}{
		{StepKindGitRevParse, nil, "Get ref"},
		{StepKindGitFetch, nil, "Fetch"},
		{StepKindGitPull, nil, "Pull"},
		{StepKindKubernetesClusterCheck, nil, "Check cluster"},
		{StepKindKubernetesSecretDelete, []string{"db-credentials"}, "Delete secret db-credentials"},
		{StepKindKubernetesPortForward, []string{"web"}, "Port-forward web"},
	}
	for _, tc := range cases {
		if got := StepLabel(EncodeStepKind(tc.kind, tc.args...), "fallback"); got != tc.want {
			t.Fatalf("StepLabel(%v,%v) = %q, want %q", tc.kind, tc.args, got, tc.want)
		}
	}
}

func TestStepLabelFallsBackToTitleCasedCommand(t *testing.T) {
	if got := StepLabel(string(StepKindCommand), "git symbolic-ref HEAD"); got != "Git Symbolic-ref HEAD" {
		t.Fatalf("fallback label = %q", got)
	}
	if got := StepLabel("unknown.kind", "helm list"); got != "Helm List" {
		t.Fatalf("unknown-kind fallback label = %q", got)
	}
}

func TestGitCommandStepKindClassifiesByVerbNotPosition(t *testing.T) {
	cases := map[string]StepKind{
		"rev-parse --abbrev-ref HEAD":                              StepKindGitRevParse,
		"fetch --force origin +refs/heads/*:refs/remotes/origin/*": StepKindGitFetch,
		"reset --hard origin/main":                                 StepKindGitPull,
		"push origin":                                              StepKindGitPush,
		"clone --branch main repo dir":                             StepKindGitClone,
		"status --porcelain":                                       StepKindGitStatus,
		"branch --list main":                                       StepKindGitListBranches,
		"branch --remote --list origin/main":                       StepKindGitListBranches,
		"switch -c main --track origin/main":                       StepKindGitSwitchBranch,
		"switch main":                                              StepKindGitSwitchBranch,
		"switch main --no-cd --yes":                                StepKindGitSwitchBranch,
		"worktree list --porcelain":                                StepKindGitWorktreeList,
		"worktree remove --force dir":                              StepKindGitWorktreeRemove,
		"worktree prune":                                           StepKindGitWorktreePrune,
		"remove main --yes":                                        StepKindGitWorktreeRemove,
		"symbolic-ref HEAD":                                        StepKindCommand,
	}
	for args, want := range cases {
		if got := GitCommandStepKind(args); got != want {
			t.Fatalf("GitCommandStepKind(%q) = %v, want %v", args, got, want)
		}
	}
}

func TestCommandStepKindClassifiesComposeCommands(t *testing.T) {
	cases := []struct {
		operation string
		command   string
		args      []string
		want      StepKind
		label     string
	}{
		{"run", "podman-compose", []string{"-p", "devenv", "--env-file", "/tmp/.env", "up", "-d"}, StepKindComposeStart, "Start containers"},
		{"stop", "docker-compose", []string{"down"}, StepKindComposeStop, "Stop containers"},
		{"build", "docker", []string{"compose", "build"}, StepKindComposeBuild, "Build containers"},
		{"run", "podman", []string{"compose", "pull"}, StepKindComposePull, "Pull container images"},
		{"run", "kind", []string{"get", "clusters"}, StepKindKubernetesClusterCheck, "Check cluster"},
		{"run", "kind", []string{"create", "cluster", "--name", "devenv"}, StepKindKubernetesClusterCreate, "Create cluster"},
		{"run", "kind", []string{"export", "kubeconfig", "--name", "devenv"}, StepKindKubernetesClusterExport, "Export kubeconfig"},
		{"run", "helm", []string{"--kube-context", "kind-devenv", "status", "postgres-local"}, StepKindKubernetesHelmStatus, "Check release"},
		{"run", "helm", []string{"--kube-context", "kind-devenv", "install", "postgres-local"}, StepKindKubernetesHelmInstall, "Install release"},
		{"build", "sh", []string{"/tmp/build.sh"}, StepKindExecuteBuild, "Run build command"},
		{"test", "bun", []string{"test"}, StepKindExecuteTest, "Run test command"},
		{"run", "node", []string{"server.js"}, StepKindExecuteRun, "Run application command"},
		{"", "command", []string{"arg"}, StepKindExecute, "Run command"},
	}
	for _, tc := range cases {
		kind := CommandStepKind(tc.operation, tc.command, tc.args)
		if kind != tc.want {
			t.Fatalf("CommandStepKind(%q, %q, %q) = %q, want %q", tc.operation, tc.command, tc.args, kind, tc.want)
		}
		fallback := strings.Join(append([]string{tc.command}, tc.args...), " ")
		if got := StepLabel(string(kind), fallback); got != tc.label {
			t.Fatalf("StepLabel(%q) = %q, want %q", kind, got, tc.label)
		}
	}
}

func TestKubernetesClusterCommandStepKindClassifiesByArgs(t *testing.T) {
	cases := map[string]StepKind{
		"get clusters":                    StepKindKubernetesClusterCheck,
		"create cluster --name devenv":    StepKindKubernetesClusterCreate,
		"delete cluster --name devenv":    StepKindKubernetesClusterDelete,
		"export kubeconfig --name devenv": StepKindKubernetesClusterExport,
		"version":                         StepKindCommand,
	}
	for args, want := range cases {
		if got := KubernetesClusterCommandStepKind(args); got != want {
			t.Fatalf("KubernetesClusterCommandStepKind(%q) = %v, want %v", args, got, want)
		}
	}
}

func TestActionKindBucketsMachineActionKeys(t *testing.T) {
	cases := map[string]string{
		"git.pull":                  "git",
		"git.worktree.create":       "worktree",
		"kubernetes.cluster.create": "kubernetes",
		"infra.start":               "infrastructure",
		"task.run":                  "task",
		"build":                     "app",
	}
	for action, want := range cases {
		if got := ActionKind(action); got != want {
			t.Fatalf("ActionKind(%q) = %q, want %q", action, got, want)
		}
	}
}
