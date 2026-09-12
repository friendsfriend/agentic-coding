package actionregistry

import "github.com/friendsfriend/devenv/pkg/actiondef"

type GitActionSpec struct {
	Type     actiondef.ActionType
	Label    string
	Commands []GitCommandSpec
	Inputs   []actiondef.InputDefinition
}
type GitCommandSpec struct {
	ID    string
	Label string
	Args  []string
}

func CompileGitActions(appIdent, workingDirectory string) []actiondef.Action {
	branchInput := actiondef.InputDefinition{PortDefinition: actiondef.PortDefinition{Key: "branch", Type: "string", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityPublic, Required: true}, Label: "Branch"}
	pathInput := actiondef.InputDefinition{PortDefinition: actiondef.PortDefinition{Key: "path", Type: "path", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityInternal, Required: true}, Label: "Path"}
	specs := []GitActionSpec{
		{Type: "pull", Label: "Pull", Commands: []GitCommandSpec{{"get-ref", "Get ref", []string{"rev-parse", "--abbrev-ref", "HEAD"}}, {"fetch", "Fetch", []string{"fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"}}, {"pull", "Pull", []string{"reset", "--hard", "origin/${git.branch}"}}}},
		{Type: "fetch", Label: "Fetch", Commands: []GitCommandSpec{{"fetch", "Fetch", []string{"fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"}}}},
		{Type: "push", Label: "Push", Commands: []GitCommandSpec{{"push", "Push", []string{"push", "origin", "HEAD"}}}},
		{Type: "branches", Label: "List branches", Commands: []GitCommandSpec{{"branches", "List branches", []string{"branch", "--all", "--format=%(refname:short)"}}}},
		{Type: "checkout", Label: "Checkout branch", Inputs: []actiondef.InputDefinition{branchInput}, Commands: []GitCommandSpec{{"checkout", "Checkout branch", []string{"switch", "${branch}"}}}},
		{Type: "worktree-list", Label: "List worktrees", Commands: []GitCommandSpec{{"worktree-list", "List worktrees", []string{"worktree", "list", "--porcelain"}}}},
		{Type: "worktree-add", Label: "Add worktree", Inputs: []actiondef.InputDefinition{branchInput, pathInput}, Commands: []GitCommandSpec{{"worktree-add", "Add worktree", []string{"worktree", "add", "${path}", "${branch}"}}}},
		{Type: "worktree-remove", Label: "Remove worktree", Inputs: []actiondef.InputDefinition{pathInput}, Commands: []GitCommandSpec{{"worktree-remove", "Remove worktree", []string{"worktree", "remove", "${path}"}}}},
	}
	out := make([]actiondef.Action, 0, len(specs))
	for _, spec := range specs {
		out = append(out, compileGitAction(appIdent, workingDirectory, spec))
	}
	return out
}
func compileGitAction(appIdent, workingDirectory string, spec GitActionSpec) actiondef.Action {
	id := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", string(spec.Type), "git", "default"))
	steps := make([]actiondef.Step, len(spec.Commands))
	for i, command := range spec.Commands {
		configuration := map[string]any{"command": "git", "args": append([]string(nil), command.Args...), "dir": workingDirectory}
		step := actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", command.ID)), StepType: actiondef.StepKindCommand, DisplayLabel: command.Label, Handler: "git", Configuration: configuration}
		if command.ID == "get-ref" {
			configuration["captureStdout"] = "git.branch"
			configuration["captureType"] = "string"
			step.OutputPorts = []actiondef.PortDefinition{{Key: "git.branch", Type: "string", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityInternal}}
		}
		if command.ID == "pull" {
			step.InputPorts = []actiondef.PortDefinition{{Key: "git.branch", Type: "string", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityInternal, Required: true}}
		}
		steps[i] = step
	}
	return actiondef.NewAction(actiondef.Action{ActionID: id, Resource: actiondef.ResourceRef{Kind: "app", ID: appIdent}, ActionType: spec.Type, ActionRuntime: "git", DisplayLabel: spec.Label, InputDefinitions: spec.Inputs, AvailabilityState: actiondef.Availability{Available: workingDirectory != "", Reason: availabilityReason(workingDirectory)}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: spec.Label, ChildSteps: steps}})
}
func availabilityReason(path string) string {
	if path == "" {
		return "checkout required"
	}
	return ""
}
