package actionregistry

import (
	"github.com/friendsfriend/devenv/pkg/actiondef"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
)

// CompileKubernetesLifecycleActions generates lifecycle actions (Stop, Restart)
// for Kubernetes run targets. Restart explicitly stops then starts the release.
func CompileKubernetesLifecycleActions(appIdent string, target resources.ActionTarget) []actiondef.Action {
	if target.Runtime != resources.ActionRuntimeKubernetes || target.Action != resources.AppActionRun {
		return nil
	}
	meta := target.Kubernetes
	if meta == nil {
		return nil
	}
	profile := target.Profile
	if profile == "" {
		profile = "local"
	}
	ns := meta.Namespace
	if ns == "" {
		ns = "default"
	}
	identity := k8s.ResolveIdentity(target.Provider, meta.ClusterName, meta.ContextName)

	stopID := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", "stop", "kubernetes", profile))
	stopRoot := actiondef.Step{
		StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "root")),
		StepType:     actiondef.StepKindComposite,
		DisplayLabel: "Stop",
		ChildSteps: []actiondef.Step{
			{
				StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "stop", "0")),
				StepType:     actiondef.StepKindCommand,
				DisplayLabel: "Uninstall Helm release",
				Handler:      "kubernetes",
				Configuration: map[string]any{
					"command": "helm",
					"args":    []string{"--kube-context", identity.Context, "uninstall", meta.Release, "--namespace", ns, "--ignore-not-found"},
				},
			},
		},
	}
	stopAction := actiondef.NewAction(actiondef.Action{
		ActionID:          stopID,
		Resource:          actiondef.ResourceRef{Kind: "app", ID: appIdent},
		ActionType:        "stop",
		ActionRuntime:     "kubernetes",
		DisplayLabel:      "Stop",
		AvailabilityState: actiondef.Availability{Available: true},
		RootStep:          stopRoot,
	})

	restartID := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", "restart", "kubernetes", profile))
	helmArgs := []string{"--kube-context", identity.Context, "upgrade", "--install", meta.Release, meta.ChartPath, "--namespace", ns}
	for _, v := range meta.ValuesFiles {
		helmArgs = append(helmArgs, "--values", v)
	}
	if meta.Image != nil {
		vp := meta.Image.ValuePaths
		if vp.Repository != "" && meta.Image.Repository != "" {
			helmArgs = append(helmArgs, "--set", vp.Repository+"="+meta.Image.Repository)
		}
		if vp.Tag != "" && meta.Image.Tag != "" {
			helmArgs = append(helmArgs, "--set", vp.Tag+"="+meta.Image.Tag)
		}
		if vp.PullPolicy != "" && meta.Image.PullPolicy != "" {
			helmArgs = append(helmArgs, "--set", vp.PullPolicy+"="+meta.Image.PullPolicy)
		}
	}
	restartRoot := actiondef.Step{
		StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(restartID), "step", "root")),
		StepType:     actiondef.StepKindComposite,
		DisplayLabel: "Restart",
		ChildSteps: []actiondef.Step{
			{
				StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(restartID), "step", "restart", "0")),
				StepType:     actiondef.StepKindCommand,
				DisplayLabel: "Uninstall Helm release",
				Handler:      "kubernetes",
				Configuration: map[string]any{
					"command": "helm",
					"args":    []string{"--kube-context", identity.Context, "uninstall", meta.Release, "--namespace", ns, "--ignore-not-found"},
				},
			},
			{
				StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(restartID), "step", "restart", "1")),
				StepType:     actiondef.StepKindCommand,
				DisplayLabel: "Install Helm release",
				Handler:      "kubernetes",
				Configuration: map[string]any{
					"command": "helm",
					"args":    helmArgs,
				},
			},
			{
				StepID:        actiondef.StepDefinitionID(actiondef.StableID(string(restartID), "step", "restart", "2")),
				StepType:      actiondef.StepKindReadiness,
				DisplayLabel:  "Wait for workloads",
				Handler:       "kubernetes",
				Configuration: map[string]any{"probe": "kubernetes", "resource": meta.Release, "context": identity.Context, "namespace": ns, "timeout": meta.Wait.Timeout},
			},
		},
	}
	restartAction := actiondef.NewAction(actiondef.Action{
		ActionID:          restartID,
		Resource:          actiondef.ResourceRef{Kind: "app", ID: appIdent},
		ActionType:        "restart",
		ActionRuntime:     "kubernetes",
		DisplayLabel:      "Restart",
		AvailabilityState: actiondef.Availability{Available: true},
		RootStep:          restartRoot,
	})

	return []actiondef.Action{stopAction, restartAction}
}
