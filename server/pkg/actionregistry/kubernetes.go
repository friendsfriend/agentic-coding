package actionregistry

import (
	"os"
	"path/filepath"
	"strconv"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

func CompileKubernetesClusterActions() []actiondef.Action {
	return compileKubernetesClusterActions(ToolSet{Kind: lookPath("kind")})
}

// CompileKubernetesClusterActionsWithTools returns cluster actions only when
// the required tools (kind) are present in the given ToolSet.
func CompileKubernetesClusterActionsWithTools(tools ToolSet) []actiondef.Action {
	return compileKubernetesClusterActions(tools)
}

type kubernetesClusterSpec struct {
	action, label string
	commands      [][]string
}

func exportKubeconfigCommand() []string {
	args := []string{"kind", "export", "kubeconfig", "--name", "devenv"}
	if home, err := os.UserHomeDir(); err == nil {
		args = append(args, "--kubeconfig", filepath.Join(home, ".kube", "config"))
	}
	return args
}

var clusterSpecs = []kubernetesClusterSpec{
	{"status", "Check cluster", [][]string{{"kind", "get", "kubeconfig", "--name", "devenv"}}},
	{"create", "Create cluster", [][]string{{"kind", "create", "cluster", "--name", "devenv"}, exportKubeconfigCommand()}},
	{"delete", "Delete cluster", [][]string{{"kind", "delete", "cluster", "--name", "devenv"}}},
	{"recreate", "Recreate cluster", [][]string{{"kind", "delete", "cluster", "--name", "devenv"}, {"kind", "create", "cluster", "--name", "devenv"}, exportKubeconfigCommand()}},
	{"export-kubeconfig", "Export kubeconfig", [][]string{exportKubeconfigCommand()}},
}

func compileKubernetesClusterActions(tools ToolSet) []actiondef.Action {
	if !tools.Kind || !tools.Kubectl || !tools.Helm {
		return nil
	}
	providers := []struct{ name, label string }{}
	if tools.Docker {
		providers = append(providers, struct{ name, label string }{"docker", ""})
	}
	if tools.Podman {
		providers = append(providers, struct{ name, label string }{"podman", " (podman)"})
	}
	out := make([]actiondef.Action, 0, len(clusterSpecs)*len(providers))
	for _, provider := range providers {
		providerEnv := ""
		if provider.name == "podman" {
			providerEnv = "KIND_EXPERIMENTAL_PROVIDER=podman"
		}
		for _, spec := range clusterSpecs {
			id := actiondef.ActionID(actiondef.StableID("kubernetes", "local", "action", spec.action, provider.name, "default"))
			steps := make([]actiondef.Step, len(spec.commands))
			for i, command := range spec.commands {
				cfg := map[string]any{"command": command[0], "args": command[1:]}
				if providerEnv != "" {
					cfg["env"] = []string{providerEnv}
				}
				steps[i] = actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", spec.action, strconv.Itoa(i))), StepType: actiondef.StepKindCommand, DisplayLabel: kubernetesCommandLabel(command), Handler: "kubernetes", Configuration: cfg}
			}
			label := spec.label + provider.label
			out = append(out, actiondef.NewAction(actiondef.Action{ActionID: id, Resource: actiondef.ResourceRef{Kind: "kubernetes", ID: "local"}, ActionType: actiondef.ActionType(spec.action), ActionRuntime: actiondef.Runtime(provider.name), DisplayLabel: label, AvailabilityState: actiondef.Availability{Available: true}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: label, ChildSteps: steps}}))
		}
	}
	return out
}
func kubernetesCommandLabel(command []string) string {
	if len(command) > 1 {
		switch command[1] {
		case "get":
			return "Check cluster"
		case "create":
			return "Create cluster"
		case "delete":
			return "Delete cluster"
		case "export":
			return "Export kubeconfig"
		}
	}
	return "Run Kubernetes command"
}
