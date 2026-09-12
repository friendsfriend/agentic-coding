package actionregistry

import (
	"strconv"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/app"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func CompileInfrastructure(service app.InfraService) []actiondef.Action {
	runtime := service.Type
	if runtime == "" {
		runtime = app.InfraServiceTypeDocker
	}
	startRuntimes := []string{runtime}
	if runtime == app.InfraServiceTypeScript {
		switch {
		case service.DefaultRunner != "":
			startRuntimes = []string{service.DefaultRunner}
		case service.ShellPath != "" && service.PowerShellPath != "":
			startRuntimes = []string{app.ScriptRunnerShell, app.ScriptRunnerPowerShell}
		case service.PowerShellPath != "":
			startRuntimes = []string{app.ScriptRunnerPowerShell}
		default:
			startRuntimes = []string{app.ScriptRunnerShell}
		}
	}
	definitions := make([]actiondef.Action, 0, len(startRuntimes)+1)
	for _, startRuntime := range startRuntimes {
		definitions = append(definitions, compileInfrastructureStart(service, runtime, startRuntime))
	}
	definitions = append(definitions, compileInfrastructureStop(service, runtime))
	return definitions
}

func compileInfrastructureStart(service app.InfraService, serviceType, startRuntime string) actiondef.Action {
	startID := actiondef.ActionID(actiondef.StableID("infra", service.Ident, "action", "start", startRuntime, "default"))
	configuration := infrastructureConfiguration(service)
	configuration["runner"] = startRuntime
	if serviceType == app.InfraServiceTypeScript {
		if startRuntime == app.ScriptRunnerPowerShell {
			configuration["command"] = "pwsh"
			configuration["args"] = append([]string{"-File", service.PowerShellPath}, service.Args...)
		} else {
			configuration["command"] = "/bin/sh"
			configuration["args"] = append([]string{service.ShellPath}, service.Args...)
		}
		configuration["dir"] = service.Cwd
		configuration["logPath"] = service.LogPath
		configuration["handleKey"] = service.Ident
		if len(service.Env) > 0 {
			configuration["env"] = environmentSlice(service.Env)
		}
	}
	startChildren := []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "start")), StepType: infrastructureStartKind(serviceType), DisplayLabel: "Start " + service.DisplayName, Handler: serviceType, Configuration: configuration}}
	if serviceType == app.InfraServiceTypeKubernetes && service.Kubernetes != nil {
		kube := service.Kubernetes
		identity := k8s.ResolveIdentity(resources.ContainerProvider(kube.Provider), kube.Cluster, kube.Context)
		env := identity.Env()
		ensure := map[string]any{"command": "sh", "args": []string{"-c", "kind export kubeconfig --name " + identity.Cluster + " 2>/dev/null || (kind create cluster --name " + identity.Cluster + " && kind export kubeconfig --name " + identity.Cluster + ")"}}
		if len(env) > 0 {
			ensure["env"] = env
		}
		helmArgs := []string{"--kube-context", identity.Context, "upgrade", "--install", kube.Release, kube.ChartPath, "--namespace", kube.Namespace}
		for _, value := range kube.Values {
			helmArgs = append(helmArgs, "--values", value)
		}
		namespace := kube.Namespace
		if namespace == "" {
			namespace = "default"
		}
		ns := map[string]any{"command": "sh", "args": []string{"-c", "kubectl --context " + identity.Context + " create namespace " + namespace + " --dry-run=client -o yaml | kubectl --context " + identity.Context + " apply -f -"}}
		startChildren = []actiondef.Step{
			{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "ensure-cluster")), StepType: actiondef.StepKindCommand, DisplayLabel: "Ensure cluster", Handler: "kubernetes", Configuration: ensure},
			{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "create-namespace")), StepType: actiondef.StepKindCommand, DisplayLabel: "Create namespace", Handler: "kubernetes", Configuration: ns},
			{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "helm-install")), StepType: actiondef.StepKindCommand, DisplayLabel: "Install Helm release", Handler: "kubernetes", Configuration: map[string]any{"command": "helm", "args": helmArgs}},
		}
	}
	if serviceType == app.InfraServiceTypeScript || serviceType == app.InfraServiceTypeKubernetes || serviceType == app.InfraServiceTypeDocker {
		readinessConfig := infrastructureConfiguration(service)
		if serviceType == app.InfraServiceTypeScript {
			readinessConfig = map[string]any{"probe": "process", "processStepId": service.Ident, "stabilizationMs": float64(1000)}
		} else if serviceType == app.InfraServiceTypeKubernetes && service.Kubernetes != nil {
			kube := service.Kubernetes
			identity := k8s.ResolveIdentity(resources.ContainerProvider(kube.Provider), kube.Cluster, kube.Context)
			readinessConfig = map[string]any{"probe": "kubernetes", "resource": kube.Release, "context": identity.Context, "namespace": kube.Namespace, "timeout": kube.Timeout}
		}
		startChildren = append(startChildren, actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "readiness")), StepType: actiondef.StepKindReadiness, DisplayLabel: "Wait for readiness", Handler: serviceType, Configuration: readinessConfig})
	}
	label := "Default"
	if serviceType == app.InfraServiceTypeScript {
		if startRuntime == app.ScriptRunnerPowerShell {
			label = "PowerShell"
		} else {
			label = "Shell"
		}
	}
	return actiondef.NewAction(actiondef.Action{ActionID: startID, Resource: actiondef.ResourceRef{Kind: "infrastructure", ID: service.Ident}, ActionType: "start", ActionRuntime: actiondef.Runtime(startRuntime), DisplayLabel: label, AvailabilityState: actiondef.Availability{Available: true}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(startID), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: "Start " + service.DisplayName, ChildSteps: startChildren}})
}
func compileInfrastructureStop(service app.InfraService, runtime string) actiondef.Action {
	stopID := actiondef.ActionID(actiondef.StableID("infra", service.Ident, "action", "stop", runtime, "default"))
	children := []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "stop")), StepType: actiondef.StepKindOperation, DisplayLabel: "Terminate " + service.DisplayName, Handler: runtime, Configuration: infrastructureConfiguration(service)}, {StepID: actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "verify")), StepType: actiondef.StepKindOperation, DisplayLabel: "Verify stopped", Handler: runtime, Configuration: infrastructureConfiguration(service)}}
	if runtime == app.InfraServiceTypeKubernetes && service.Kubernetes != nil {
		identity := k8s.ResolveIdentity(resources.ContainerProvider(service.Kubernetes.Provider), service.Kubernetes.Cluster, service.Kubernetes.Context)
		children = []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "helm-uninstall")), StepType: actiondef.StepKindCommand, DisplayLabel: "Uninstall Helm release", Handler: "kubernetes", Configuration: map[string]any{"command": "helm", "args": []string{"--kube-context", identity.Context, "uninstall", service.Kubernetes.Release, "--namespace", service.Kubernetes.Namespace}}}}
	}
	return actiondef.NewAction(actiondef.Action{ActionID: stopID, Resource: actiondef.ResourceRef{Kind: "infrastructure", ID: service.Ident}, ActionType: "stop", ActionRuntime: actiondef.Runtime(runtime), DisplayLabel: "Stop", AvailabilityState: actiondef.Availability{Available: true}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(stopID), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: "Stop " + service.DisplayName, ChildSteps: children}})
}
func infrastructureStartKind(runtime string) actiondef.StepKind {
	if runtime == app.InfraServiceTypeScript {
		return actiondef.StepKindProcess
	}
	return actiondef.StepKindOperation
}
func infrastructureConfiguration(service app.InfraService) map[string]any {
	return map[string]any{"ident": service.Ident, "type": service.Type, "shellPath": service.ShellPath, "powerShellPath": service.PowerShellPath, "defaultRunner": service.DefaultRunner, "cwd": service.Cwd, "args": append([]string(nil), service.Args...), "kubernetes": service.Kubernetes}
}
func CompileOperation(owner actiondef.ResourceRef, actionType actiondef.ActionType, runtime actiondef.Runtime, label, handler string, kinds ...actiondef.StepKind) actiondef.Action {
	id := actiondef.ActionID(actiondef.StableID(owner.Kind, owner.ID, "action", string(actionType), string(runtime), "default"))
	children := make([]actiondef.Step, len(kinds))
	for i, kind := range kinds {
		children[i] = actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", handler, strconv.Itoa(i))), StepType: kind, DisplayLabel: label, Handler: handler}
	}
	return actiondef.NewAction(actiondef.Action{ActionID: id, Resource: owner, ActionType: actionType, ActionRuntime: runtime, DisplayLabel: label, AvailabilityState: actiondef.Availability{Available: true}, RootStep: actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root")), StepType: actiondef.StepKindComposite, DisplayLabel: label, ChildSteps: children}})
}
