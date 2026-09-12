package actionregistry

import (
	"path/filepath"
	"strconv"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/resources"
)

var containerRuntimes = []struct {
	Name    string
	Runtime actiondef.Runtime
}{
	{"docker", "docker"},
	{"podman", "podman"},
}

func CompileDockerLifecycleActions(appIdent string, target resources.ActionTarget) []actiondef.Action {
	if target.Runtime != resources.ActionRuntimeDocker || target.Action != resources.AppActionRun {
		return nil
	}
	profile := target.Profile
	if profile == "" {
		profile = "default"
	}
	var results []actiondef.Action
	for _, rt := range containerRuntimes {
		composeCmd := docker.ComposeCommandForRuntime(rt.Name)
		results = append(results, compileLifecycleForRuntime(appIdent, target, composeCmd, profile, rt.Name, rt.Runtime)...)
	}
	return results
}

func compileLifecycleForRuntime(appIdent string, target resources.ActionTarget, composeCmd, profile, name string, runtime actiondef.Runtime) []actiondef.Action {
	compile := func(action actiondef.ActionType, label string, sequences ...[]string) actiondef.Action {
		id := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", string(action), name, profile))
		steps := make([]actiondef.Step, len(sequences))
		for i, args := range sequences {
			steps[i] = actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", string(action), strconv.Itoa(i))), StepType: actiondef.StepKindCommand, DisplayLabel: label, Handler: name, Configuration: map[string]any{"command": composeCmd, "args": composeLifecycleArgs(target, args...), "dir": filepath.Dir(target.SourcePath)}}
		}
		return actiondef.NewAction(actiondef.Action{ActionID: id, Resource: actiondef.ResourceRef{Kind: "app", ID: appIdent}, ActionType: action, ActionRuntime: runtime, DisplayLabel: label + " (" + name + ")", AvailabilityState: actiondef.Availability{Available: true}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: label, ChildSteps: steps}})
	}
	return []actiondef.Action{compile("stop", "Stop", []string{"down"}), compile("restart", "Restart", []string{"down"}, []string{"up", "-d"})}
}

func composeLifecycleArgs(target resources.ActionTarget, args ...string) []string {
	out := []string{"-f", target.SourcePath}
	if target.Profile != "" {
		out = append(out, "--profile", target.Profile)
	}
	return append(out, args...)
}
