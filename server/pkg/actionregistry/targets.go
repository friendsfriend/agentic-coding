package actionregistry

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
)

// CompileTarget adapts existing configuration conventions into immutable definitions.
type DependencyResolver func(resources.DependencyRef) (string, resources.ActionTarget, bool)

func CompileTarget(appIdent string, target resources.ActionTarget) actiondef.Action {
	return CompileTargetGraph(appIdent, target, nil, "")
}

func CompileTargetGraph(appIdent string, target resources.ActionTarget, resolver DependencyResolver, checkoutDir ...string) actiondef.Action {
	composeCmd := docker.ComposeCommand()
	runtimeCmd := docker.RuntimeCommand()
	if target.Runtime == resources.ActionRuntimeDocker {
		runtimeCmd = docker.RuntimeCommandForRuntime("docker")
	}
	dir := ""
	if len(checkoutDir) > 0 {
		dir = checkoutDir[0]
	}
	return compileTargetWithRuntime(appIdent, target, resolver, composeCmd, runtimeCmd, string(target.Runtime), dir)
}

// CompileContainerTargets generates actions for all runtimes.
// - Docker targets get an additional podman variant.
// - Shell-based targets get Tmux (tmux window) + Shell (logged/command) variants.
// tools controls which tool-dependent variants are included; nil means all available.
func CompileContainerTargets(appIdent string, target resources.ActionTarget, resolver DependencyResolver, checkoutDir ...string) []actiondef.Action {
	return compileContainerTargets(appIdent, target, resolver, nil, firstDir(checkoutDir))
}

// CompileContainerTargetsWithTools is like CompileContainerTargets but respects
// the given ToolSet: missing tools cause their corresponding action variants to be
// omitted entirely.
func CompileContainerTargetsWithTools(appIdent string, target resources.ActionTarget, resolver DependencyResolver, tools ToolSet, checkoutDir ...string) []actiondef.Action {
	return compileContainerTargets(appIdent, target, resolver, &tools, firstDir(checkoutDir))
}

func firstDir(dirs []string) string {
	if len(dirs) > 0 {
		return dirs[0]
	}
	return ""
}

func compileContainerTargets(appIdent string, target resources.ActionTarget, resolver DependencyResolver, tools *ToolSet, dir string) []actiondef.Action {
	// Docker variants
	if target.Runtime == resources.ActionRuntimeDocker {
		if tools != nil && !tools.Docker && !tools.Podman {
			return nil
		}
		dockerTarget := target
		dockerTarget.Provider = resources.ContainerProviderDocker
		results := []actiondef.Action{CompileTargetGraph(appIdent, dockerTarget, resolver, dir)}
		results[0].ActionRuntime = "docker"
		if tools == nil || (tools.Podman && tools.PodmanCompose) {
			podmanTarget := target
			podmanTarget.Provider = resources.ContainerProviderPodman
			podmanAction := compileTargetWithRuntime(appIdent, podmanTarget, resolver, docker.ComposeCommandForRuntime("podman"), docker.RuntimeCommandForRuntime("podman"), "podman", dir)
			if podmanAction.ActionID != results[0].ActionID {
				results = append(results, podmanAction)
			}
		}
		if tools != nil && (!tools.Docker || !tools.DockerCompose) {
			// Docker provider or Compose command unavailable.
			if len(results) > 0 {
				results = results[1:]
			}
		}
		return results
	}
	// Shell-based variants
	if target.Runtime == resources.ActionRuntimeShell || target.Runtime == resources.ActionRuntimeSystemShell || target.Runtime == resources.ActionRuntimePowerShell {
		// Tmux variant (requires tmux tool)
		results := []actiondef.Action{}
		if tools == nil || tools.Tmux {
			results = append(results, compileTmuxAction(appIdent, target, resolver, dir))
		}
		// Shell variant (always available, no external tool required)
		scriptRuntime := "command-" + string(target.Runtime)
		shellAction := compileTargetWithRuntime(appIdent, target, resolver, composeCmdForRuntime(target.Runtime), runtimeCmdForRuntime(target.Runtime), scriptRuntime, dir, actiondef.StepKindCommand)
		shellAction.DisplayLabel = "Shell " + target.Label
		if len(results) == 0 || shellAction.ActionID != results[0].ActionID {
			results = append(results, shellAction)
		}
		return results
	}
	// Kubernetes profiles select one provider. Legacy targets without a provider
	// retain both variants until configuration migration supplies an identity.
	if target.Runtime == resources.ActionRuntimeKubernetes && target.Action == resources.AppActionRun {
		if tools != nil && (!tools.Kind || !tools.Kubectl || !tools.Helm) {
			return nil
		}
		providers := []resources.ContainerProvider{resources.ContainerProviderDocker, resources.ContainerProviderPodman}
		if target.Provider != "" {
			providers = []resources.ContainerProvider{target.Provider}
		}
		results := []actiondef.Action{}
		for _, provider := range providers {
			if tools != nil && ((provider == resources.ContainerProviderDocker && !tools.Docker) || (provider == resources.ContainerProviderPodman && !tools.Podman)) {
				continue
			}
			name := string(provider)
			variant := target
			variant.Provider = provider
			action := compileTargetWithRuntime(appIdent, variant, resolver, docker.ComposeCommandForRuntime(name), docker.RuntimeCommandForRuntime(name), name, dir)
			if len(results) == 0 || action.ActionID != results[0].ActionID {
				results = append(results, action)
			}
		}
		return results
	}
	// Non-shell, non-Docker, non-Kubernetes targets: single default action
	return []actiondef.Action{CompileTargetGraph(appIdent, target, resolver, dir)}
}

// compileTmuxAction creates an action that runs the target's command in a new tmux window.
func compileTmuxAction(appIdent string, target resources.ActionTarget, resolver DependencyResolver, checkoutDir string) actiondef.Action {
	profile := target.Profile
	if profile == "" {
		profile = "default"
	}
	id := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", string(target.Action), "tmux", profile))
	rootID := actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root"))

	// Build shell wrapper that runs the target command then waits for keypress
	// so the tmux window stays open after the command finishes.
	var sb strings.Builder
	sb.WriteString(target.Command)
	for _, arg := range target.Args {
		sb.WriteString(" ")
		sb.WriteString(arg)
	}
	sb.WriteString("; echo; printf 'Press Enter to close this window...'; read")
	shellWrapper := sb.String()

	tmuxArgs := []string{"new-window", "-P", "-F", "#{window_id}", "-n", target.Label}
	dir := checkoutDir
	if _, err := os.Stat(dir); dir == "" || err != nil {
		dir = target.WorkingDir
		if dir == "" {
			dir = filepath.Dir(target.SourcePath)
		}
	}
	if dir != "" {
		tmuxArgs = append(tmuxArgs, "-c", dir)
	}
	tmuxArgs = append(tmuxArgs, "sh", "-c", shellWrapper)

	leaf := actiondef.Step{
		StepID:       actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "execute")),
		StepType:     actiondef.StepKindCommand,
		DisplayLabel: target.Label,
		Handler:      "tmux",
		Configuration: map[string]any{
			"command": "tmux",
			"args":    tmuxArgs,
		},
	}
	children := []actiondef.Step{}
	if target.Action == resources.AppActionRun {
		children = append(children, compileDependencySteps(id, target.Requires, resolver, map[string]bool{}, docker.ComposeCommand(), docker.RuntimeCommand(), checkoutDir)...)
	}
	children = append(children, leaf)
	root := actiondef.Step{
		StepID:       rootID,
		StepType:     actiondef.StepKindComposite,
		DisplayLabel: actionLabel(target.Action, "Tmux "+target.Label),
		ChildSteps:   children,
	}
	return actiondef.NewAction(actiondef.Action{
		ActionID:          id,
		Resource:          actiondef.ResourceRef{Kind: "app", ID: appIdent},
		ActionType:        actiondef.ActionType(target.Action),
		ActionRuntime:     "tmux",
		DisplayLabel:      "Tmux " + target.Label,
		AvailabilityState: actiondef.Availability{Available: true},
		RootStep:          root,
	})
}

func composeCmdForRuntime(runtime resources.ActionRuntime) string {
	if runtime == resources.ActionRuntimePowerShell {
		return ""
	}
	return docker.ComposeCommand()
}

func runtimeCmdForRuntime(runtime resources.ActionRuntime) string {
	return docker.RuntimeCommand()
}

func compileTargetWithRuntime(appIdent string, target resources.ActionTarget, resolver DependencyResolver, composeCmd, runtimeCmd, actionRuntime, checkoutDir string, leafKindOverrides ...actiondef.StepKind) actiondef.Action {
	profile := target.Profile
	if profile == "" {
		profile = "default"
	}
	id := actiondef.ActionID(actiondef.StableID("app", appIdent, "action", string(target.Action), actionRuntime, profile))
	rootID := actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "root"))
	leafKind := actiondef.StepKindCommand
	if len(leafKindOverrides) > 0 {
		leafKind = leafKindOverrides[0]
	} else if target.Action == resources.AppActionRun && target.Runtime != resources.ActionRuntimeDocker && target.Runtime != resources.ActionRuntimeKubernetes {
		leafKind = actiondef.StepKindProcess
	}
	leaf := actiondef.Step{
		StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "execute")), StepType: leafKind,
		DisplayLabel: target.Label, Handler: actionRuntime,
		Configuration: map[string]any{"targetId": target.ID, "command": target.Command, "args": append([]string(nil), target.Args...), "profile": target.Profile, "launchMode": target.LaunchMode, "requires": append([]resources.DependencyRef(nil), target.Requires...)},
	}
	env := map[string]string{}
	for key, value := range target.Env {
		env[key] = value
	}
	for _, binding := range target.Bindings {
		if binding.Destination == "env" {
			env[binding.Name] = "${endpoint." + binding.Export + "}"
		}
	}
	if len(env) > 0 {
		leaf.Configuration["env"] = environmentSlice(env)
	}
	if len(target.Exports) > 0 {
		exports := make([]actiondef.EndpointValue, 0, len(target.Exports))
		outputs := make([]actiondef.PortDefinition, 0, len(target.Exports))
		for _, endpoint := range target.Exports {
			host := endpoint.Host
			if host == "" {
				host = "127.0.0.1"
			}
			exports = append(exports, actiondef.EndpointValue{Name: endpoint.Name, Protocol: endpoint.Protocol, Host: host, Port: endpoint.Port})
			outputs = append(outputs, actiondef.PortDefinition{Key: actiondef.ValueKey("endpoint." + endpoint.Name), Type: actiondef.ValueTypeEndpoint, Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityPublic})
		}
		leaf.Configuration["endpointExports"] = exports
		leaf.OutputPorts = outputs
	}
	// Shell-based build/test actions must run from the checkout directory.
	if checkoutDir != "" && target.Runtime != resources.ActionRuntimeDocker && target.Runtime != resources.ActionRuntimeKubernetes && (target.Action == resources.AppActionBuild || target.Action == resources.AppActionTest) {
		leaf.Configuration["dir"] = checkoutDir
	}
	if target.Runtime == resources.ActionRuntimeDocker && target.Action == resources.AppActionRun {
		leaf.StepType = actiondef.StepKindCommand
		args := []string{"-f", target.SourcePath, "up", "-d"}
		if target.Profile != "" && !strings.HasPrefix(composeCmd, "podman-compose") && !strings.HasPrefix(composeCmd, "docker-compose") {
			args = append(args, "--profile", target.Profile)
		}
		dir := checkoutDir
		if dir == "" {
			dir = filepath.Dir(target.SourcePath)
		}
		leaf.Configuration = map[string]any{"command": composeCmd, "args": args, "dir": dir}
		if len(env) > 0 {
			leaf.Configuration["env"] = environmentSlice(env)
		}
	}
	children := []actiondef.Step{}
	if target.Action == resources.AppActionRun {
		children = append(children, compileDependencySteps(id, target.Requires, resolver, map[string]bool{}, composeCmd, runtimeCmd, checkoutDir)...)
	}
	children = append(children, leaf)
	if target.Runtime == resources.ActionRuntimeDocker && target.Action == resources.AppActionRun {
		readiness := actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "readiness")), StepType: actiondef.StepKindReadiness, DisplayLabel: "Wait for containers", Handler: actionRuntime, Configuration: map[string]any{"probe": "compose", "command": composeCmd, "args": []string{"-f", target.SourcePath}, "stabilizationMs": float64(3000)}}
		children = append(children, readiness, actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "diagnostics")), StepType: actiondef.StepKindOperation, DisplayLabel: "Inspect failed containers", Handler: actionRuntime, RunCondition: actiondef.ConditionOnFailure, OnFailure: actiondef.FailureAlwaysRun})
	}
	if target.Runtime == resources.ActionRuntimeDocker && (target.Action == resources.AppActionBuild || target.Action == resources.AppActionTest) {
		buildSteps := dockerBuildSteps(id, appIdent, target, runtimeCmd, checkoutDir)
		if target.Action == resources.AppActionTest {
			// Test actions only need the build step, not artifact extraction.
			children = buildSteps[:1]
		} else {
			children = buildSteps
		}
	} else if target.Runtime == resources.ActionRuntimeKubernetes && target.Action == resources.AppActionRun {
		children = append(children[:len(children)-1], kubernetesSteps(id, target, runtimeCmd, appIdent, checkoutDir)...)
	}
	label := target.Label
	if actionRuntime == "podman" && label == "Docker" {
		label = "Podman"
	}
	root := actiondef.Step{StepID: rootID, StepType: actiondef.StepKindComposite, DisplayLabel: actionLabel(target.Action, label), ChildSteps: children}
	availability := actiondef.Availability{Available: true}
	if target.SourcePath != "" {
		if _, err := os.Stat(target.SourcePath); err != nil {
			availability = actiondef.Availability{Available: false, Reason: fmt.Sprintf("required source unavailable: %s", target.SourcePath)}
		}
	}
	return actiondef.NewAction(actiondef.Action{
		ActionID: id, Resource: actiondef.ResourceRef{Kind: "app", ID: appIdent}, ActionType: actiondef.ActionType(target.Action),
		ActionRuntime: actiondef.Runtime(actionRuntime), DisplayLabel: label, AvailabilityState: availability, RootStep: root,
	})
}

func compileDependencySteps(actionID actiondef.ActionID, refs []resources.DependencyRef, resolver DependencyResolver, path map[string]bool, composeCmd, runtimeCmd, checkoutDir string) []actiondef.Step {
	steps := make([]actiondef.Step, 0, len(refs))
	for index, ref := range refs {
		identity := ref.Infra
		if identity == "" {
			identity = actiondef.StableID(ref.App, ref.Runtime, ref.Profile, string(ref.Provider))
		} else if ref.Provider != "" || ref.Runtime != "" || ref.Profile != "" {
			identity = actiondef.StableID(ref.Infra, ref.Runtime, ref.Profile, string(ref.Provider))
		}
		semanticID := actiondef.StepDefinitionID(actiondef.StableID(string(actionID), "step", "dependency", fmt.Sprint(index), identity))
		step := actiondef.Step{StepID: semanticID, SharedKey: actiondef.ExecutionKey("dependency/" + identity), StepType: actiondef.StepKindComposite, DisplayLabel: "Start dependency: " + identity, Configuration: map[string]any{"lifecycle": dependencyLifecycle(ref), "dependencyTarget": identity}}
		if !path[identity] && resolver != nil && ref.Lifecycle != "external" {
			if appIdent, target, ok := resolver(ref); ok {
				next := make(map[string]bool, len(path)+1)
				for key, value := range path {
					next[key] = value
				}
				next[identity] = true
				step.ChildSteps = append(step.ChildSteps, compileDependencySteps(actiondef.ActionID(semanticID), target.Requires, resolver, next, composeCmd, runtimeCmd, checkoutDir)...)
				step.ChildSteps = append(step.ChildSteps, dependencyExecutionSteps(semanticID, appIdent, target, composeCmd, runtimeCmd, checkoutDir, ref.Provider)...)
			}
		}
		if len(step.ChildSteps) == 0 && ref.Lifecycle != "external" {
			step.ChildSteps = []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(semanticID), "start")), StepType: actiondef.StepKindOperation, DisplayLabel: "Start dependency", Handler: "infrastructure", Configuration: map[string]any{"dependency": ref}}}
		}
		step.ChildSteps = append(step.ChildSteps, actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(semanticID), "readiness")), StepType: actiondef.StepKindReadiness, DisplayLabel: "Wait for readiness", Handler: "dependency", Configuration: map[string]any{"dependency": ref, "lifecycle": dependencyLifecycle(ref)}})
		steps = append(steps, step)
	}
	return steps
}

func dependencyLifecycle(ref resources.DependencyRef) string {
	if ref.Lifecycle == "" {
		return "shared"
	}
	return ref.Lifecycle
}

func kubernetesSteps(id actiondef.ActionID, target resources.ActionTarget, runtimeCmd, appIdent, checkoutDir string) []actiondef.Step {
	meta := target.Kubernetes
	if meta == nil {
		return nil
	}
	releaseKey := actiondef.ValueKey("helm.release." + string(id))
	release := actiondef.PortDefinition{Key: releaseKey, Type: "helm-release", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityPublic}
	identity := k8s.ResolveIdentity(target.Provider, meta.ClusterName, meta.ContextName)
	if meta.Provider != "" {
		identity.Provider = meta.Provider
	}
	if runtimeCmd == "podman" {
		identity.Provider = resources.ContainerProviderPodman
	}
	kindEnv := identity.Env()
	step := func(name, label, command string, args ...string) actiondef.Step {
		cfg := map[string]any{"command": command, "args": args}
		if len(kindEnv) > 0 && command == "kind" {
			cfg["env"] = kindEnv
		}
		return actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", name)), StepType: actiondef.StepKindCommand, DisplayLabel: label, Handler: "kubernetes", Configuration: cfg}
	}
	clusterName := identity.Cluster
	// Single step: check if cluster exists, create if missing, then export kubeconfig.
	// Collapsed into one shell command because the ConditionOnFailure reset logic
	// interacts badly with other ConditionOnFailure steps (diagnostics, cleanup)
	// that also run after a failure.
	shellCmd := fmt.Sprintf("kind export kubeconfig --name %s 2>/dev/null || (kind create cluster --name %s && kind export kubeconfig --name %s)", clusterName, clusterName, clusterName)
	cfg := map[string]any{"command": "sh", "args": []string{"-c", shellCmd}}
	if len(kindEnv) > 0 {
		cfg["env"] = kindEnv
	}
	steps := []actiondef.Step{{
		StepID:        actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "ensure-cluster")),
		StepType:      actiondef.StepKindCommand,
		DisplayLabel:  "Ensure cluster",
		Handler:       "kubernetes",
		Configuration: cfg,
	}}
	if meta.Image != nil {
		imageRef := meta.Image.Repository + ":" + meta.Image.Tag
		if imageRef == ":" {
			imageRef = ""
		}
		if imageRef != "" {
			// kind load docker-image has issues with podman Docker API compat.
			// Use save to temp file + load image-archive instead.
			tarPath := identity.Archive(string(id))
			// Check that image exists locally before attempting to load.
			// If missing, the user must run Build first.
			checkCmd := fmt.Sprintf("%s image exists %s", runtimeCmd, imageRef)
			check := step("check-image", "Check image availability", "sh", "-c", checkCmd)
			steps = append(steps, check)
			loadCmd := fmt.Sprintf("%s save %s -o %s && kind load image-archive %s --name %s",
				runtimeCmd, imageRef, tarPath, tarPath, clusterName)
			load := step("load-image", "Load image", "sh", "-c", loadCmd)
			if len(kindEnv) > 0 {
				load.Configuration["env"] = kindEnv
			}
			steps = append(steps, load)
		}
	}
	namespace := meta.Namespace
	if namespace == "" {
		namespace = "default"
	}
	for index, secret := range meta.Secrets {
		deleteStep := step(fmt.Sprintf("secret-%d-delete", index), "Delete secret", "kubectl", "--context", identity.Context, "delete", "secret", secret.Name, "--namespace", namespace, "--ignore-not-found")
		create := step(fmt.Sprintf("secret-%d-create", index), "Create secret", "kubectl", "--context", identity.Context, "create", "secret", "generic", secret.Name, "--namespace", namespace)
		create.Configuration["displayArgs"] = []string{"create", "secret", "generic", secret.Name, "[REDACTED]"}
		create.OutputPorts = []actiondef.PortDefinition{{Key: actiondef.ValueKey("secret." + secret.Name), Type: "secret-handle", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilitySecret}}
		steps = append(steps, deleteStep, create)
	}
	nsStep := step("create-namespace", "Create namespace", "sh", "-c", fmt.Sprintf("kubectl --context %s create namespace %s --dry-run=client -o yaml | kubectl --context %s apply -f -", identity.Context, namespace, identity.Context))
	nsStep.Configuration["displayArgs"] = []string{fmt.Sprintf("Ensure namespace %s exists", namespace)}
	steps = append(steps, nsStep)
	helmArgs := []string{"--kube-context", identity.Context, "upgrade", "--install", meta.Release, meta.ChartPath, "--namespace", namespace}
	for _, v := range meta.ValuesFiles {
		helmArgs = append(helmArgs, "--values", v)
	}
	for _, binding := range target.Bindings {
		if binding.Destination == "helm" && binding.ValuePath != "" {
			helmArgs = append(helmArgs, "--set", binding.ValuePath+"=${endpoint."+binding.Export+"}")
		}
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
	helm := step("helm-install", "Install Helm release", "helm", helmArgs...)
	helm.OutputPorts = []actiondef.PortDefinition{release}
	helm.Configuration["setValues"] = map[string]any{string(releaseKey): meta.Release}
	readinessConfig := map[string]any{"probe": "kubernetes", "resource": meta.Release, "context": identity.Context, "namespace": namespace, "timeout": meta.Wait.Timeout}
	endpointExports := make([]actiondef.EndpointValue, 0, len(meta.Exports))
	readinessOutputs := make([]actiondef.PortDefinition, 0, len(meta.Exports))
	for _, endpoint := range meta.Exports {
		host := endpoint.Host
		if host == "" && endpoint.Strategy == "kubernetes-service" {
			host = endpoint.Resource + "." + namespace + ".svc.cluster.local"
		}
		if host == "" && endpoint.Strategy == "port-forward" {
			host = "127.0.0.1"
		}
		endpointExports = append(endpointExports, actiondef.EndpointValue{Name: endpoint.Name, Protocol: endpoint.Protocol, Host: host, Port: endpoint.Port})
		readinessOutputs = append(readinessOutputs, actiondef.PortDefinition{Key: actiondef.ValueKey("endpoint." + endpoint.Name), Type: actiondef.ValueTypeEndpoint, Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityPublic})
	}
	if len(endpointExports) > 0 {
		readinessConfig["endpointExports"] = endpointExports
	}
	readiness := actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "readiness")), StepType: actiondef.StepKindReadiness, DisplayLabel: "Wait for workloads", Handler: "kubernetes", Configuration: readinessConfig, OutputPorts: readinessOutputs}
	steps = append(steps, helm, readiness, actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "diagnostics")), StepType: actiondef.StepKindOperation, DisplayLabel: "Collect workload diagnostics", Handler: "kubernetes", RunCondition: actiondef.ConditionOnFailure, OnFailure: actiondef.FailureAlwaysRun}, actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", "cleanup-failed-release")), StepType: actiondef.StepKindCleanup, DisplayLabel: "Clean up failed release", Handler: "kubernetes", RunCondition: actiondef.ConditionOnFailure, OnFailure: actiondef.FailureAlwaysRun, Configuration: map[string]any{"command": "helm", "args": []string{"--kube-context", identity.Context, "uninstall", "${" + string(releaseKey) + "}", "--namespace", namespace}}})
	runner := k8s.NewRunner(docker.Runtime{Name: runtimeCmd, Command: runtimeCmd})
	runner.ContextName = identity.Context
	runner.ClusterName = identity.Cluster
	for index, port := range meta.Ports {
		command := k8s.PortForwardCommand(runner, namespace, port)
		configuration := map[string]any{"command": command.Name, "args": command.Args}
		if len(command.Env) > 0 {
			configuration["env"] = command.Env
		}
		portStepID := actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", fmt.Sprintf("port-forward-%d", index)))
		steps = append(steps,
			actiondef.Step{StepID: portStepID, StepType: actiondef.StepKindProcess, DisplayLabel: "Start port forward", Handler: "kubernetes", Configuration: configuration},
			actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", fmt.Sprintf("port-forward-readiness-%d", index))), StepType: actiondef.StepKindReadiness, DisplayLabel: "Wait for port forward", Handler: "kubernetes", Configuration: map[string]any{"processStepId": string(portStepID), "stabilizationMs": float64(1000)}},
		)
	}
	return steps
}

func dependencyExecutionSteps(parent actiondef.StepDefinitionID, appIdent string, target resources.ActionTarget, composeCmd, runtimeCmd, checkoutDir string, provider resources.ContainerProvider) []actiondef.Step {
	id := actiondef.ActionID(parent)
	label := "Start application: " + appIdent
	dir := target.WorkingDir
	if dir == "" {
		dir = checkoutDir
	}
	if dir == "" {
		dir = filepath.Dir(target.SourcePath)
	}
	switch target.Runtime {
	case resources.ActionRuntimeDocker:
		selectedCompose := composeCmd
		selectedRuntime := runtimeCmd
		if provider == resources.ContainerProviderPodman {
			selectedCompose = docker.ComposeCommandForRuntime("podman")
			selectedRuntime = docker.RuntimeCommandForRuntime("podman")
		} else if provider == resources.ContainerProviderDocker {
			selectedCompose = docker.ComposeCommandForRuntime("docker")
			selectedRuntime = docker.RuntimeCommandForRuntime("docker")
		}
		args := []string{"-f", target.SourcePath}
		if target.Profile != "" && !strings.HasPrefix(selectedCompose, "podman-compose") && !strings.HasPrefix(selectedCompose, "docker-compose") {
			args = append(args, "--profile", target.Profile)
		}
		args = append(args, "up", "-d")
		return []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "start")), StepType: actiondef.StepKindCommand, DisplayLabel: label, Handler: string(selectedRuntime), Configuration: map[string]any{"command": selectedCompose, "args": args, "dir": dir}}}
	case resources.ActionRuntimeShell, resources.ActionRuntimePowerShell, resources.ActionRuntimeSystemShell:
		dir := target.WorkingDir
		if dir == "" {
			dir = filepath.Dir(target.SourcePath)
		}
		configuration := map[string]any{"command": target.Command, "args": target.Args, "dir": dir, "handleKey": appIdent}
		if len(target.Env) > 0 {
			configuration["env"] = environmentSlice(target.Env)
		}
		return []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "start")), StepType: actiondef.StepKindProcess, DisplayLabel: label, Handler: string(target.Runtime), Configuration: configuration}}
	case resources.ActionRuntimeKubernetes:
		return kubernetesSteps(id, target, runtimeCmd, appIdent, checkoutDir)
	}
	return []actiondef.Step{{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "start")), StepType: actiondef.StepKindOperation, DisplayLabel: label, Handler: string(target.Runtime)}}
}

func dockerBuildSteps(id actiondef.ActionID, appIdent string, target resources.ActionTarget, runtimeCmd, checkoutDir string) []actiondef.Step {
	dir := checkoutDir
	if dir == "" {
		dir = filepath.Dir(target.SourcePath)
	}
	imageRef := actiondef.PortDefinition{Key: "image.ref", Type: "image-ref", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityPublic}
	artifactPath := actiondef.PortDefinition{Key: "artifact.path", Type: "path", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityInternal}
	containerID := actiondef.PortDefinition{Key: "artifact.container.id", Type: "container-id", Scope: actiondef.ScopeAction, Visibility: actiondef.VisibilityEphemeral}
	step := func(name, label string, kind actiondef.StepKind) actiondef.Step {
		return actiondef.Step{StepID: actiondef.StepDefinitionID(actiondef.StableID(string(id), "step", name)), StepType: kind, DisplayLabel: label, Handler: "docker"}
	}
	templatesDir := filepath.Join(resources.ResolveConfigDir(), "templates")
	templateMarker := filepath.Join(os.TempDir(), fmt.Sprintf("devenv-templates-%s-%s", appIdent, string(id)))
	// Copy templates (e.g. .dockerignore) before build to avoid sending
	// large directories like node_modules in the build context.
	prepare := step("prepare-build-context", "Prepare build context", actiondef.StepKindCommand)
	prepare.Configuration = map[string]any{"command": "sh", "args": []string{"-c", fmt.Sprintf("ls -1A %s/ > %s 2>/dev/null; cp -r %s/. . 2>/dev/null; true", templatesDir, templateMarker, templatesDir)}, "dir": dir}
	build := step("build-image", "Build image", actiondef.StepKindCommand)
	imageName := "devenv-" + appIdent + ":latest"
	build.Configuration = map[string]any{"command": runtimeCmd, "args": []string{"build", "-f", target.SourcePath, "-t", imageName, "."}, "dir": dir, "setValues": map[string]any{"image.ref": imageName}}
	build.OutputPorts = []actiondef.PortDefinition{imageRef}
	// Clean up template files from checkout dir after build (always runs).
	cleanupTemplates := step("cleanup-build-context", "Clean up build context", actiondef.StepKindCommand)
	cleanupTemplates.OnFailure = actiondef.FailureAlwaysRun
	cleanupTemplates.Configuration = map[string]any{"command": "sh", "args": []string{"-c", fmt.Sprintf("if [ -f %s ]; then xargs -I{} rm -rf \"{}\" < %s 2>/dev/null; rm -f %s; fi", templateMarker, templateMarker, templateMarker)}, "dir": dir}
	// Prune superseded images and unused volumes after every successful build.
	// Docker also has a distinct BuildKit cache, while Podman's builder prune
	// aliases image prune. Never use --all: current tagged images must survive.
	pruneCmd := fmt.Sprintf("%s image prune -f && %s volume prune -f", runtimeCmd, runtimeCmd)
	if runtimeCmd == "docker" {
		pruneCmd = "docker builder prune -f && " + pruneCmd
	}
	prune := step("prune-old-images", "Prune old images", actiondef.StepKindCommand)
	prune.Configuration = map[string]any{"command": "sh", "args": []string{"-c", pruneCmd}, "dir": dir}
	inspect := step("inspect-artifacts", "Inspect artifacts", actiondef.StepKindCommand)
	inspect.Configuration = map[string]any{"command": runtimeCmd, "args": []string{"inspect", "--format", "{{json .Config.Labels}}", "${image.ref}"}, "captureJSONLabel": "devenv.artifacts", "captureKey": "artifact.path"}
	inspect.InputPorts = []actiondef.PortDefinition{{Key: imageRef.Key, Type: imageRef.Type, Scope: imageRef.Scope, Visibility: imageRef.Visibility, Required: true}}
	inspect.OutputPorts = []actiondef.PortDefinition{artifactPath}
	create := step("create-extractor", "Create artifact extractor", actiondef.StepKindCommand)
	create.Configuration = map[string]any{"command": runtimeCmd, "args": []string{"create", "${image.ref}"}, "captureStdout": "artifact.container.id", "captureType": "container-id"}
	create.InputPorts = inspect.InputPorts
	create.OutputPorts = []actiondef.PortDefinition{containerID}
	copyStep := step("copy-artifacts", "Copy artifacts", actiondef.StepKindCommand)
	copyStep.Configuration = map[string]any{"command": runtimeCmd, "args": []string{"cp", "${artifact.container.id}:${artifact.path}", "."}, "dir": dir}
	copyStep.InputPorts = []actiondef.PortDefinition{{Key: containerID.Key, Type: containerID.Type, Scope: containerID.Scope, Visibility: containerID.Visibility, Required: true}, {Key: artifactPath.Key, Type: artifactPath.Type, Scope: artifactPath.Scope, Visibility: artifactPath.Visibility, Required: true}}
	cleanup := step("remove-extractor", "Remove artifact extractor", actiondef.StepKindCleanup)
	cleanup.OnFailure = actiondef.FailureAlwaysRun
	cleanup.Configuration = map[string]any{"command": runtimeCmd, "args": []string{"rm", "${artifact.container.id}"}}
	cleanup.InputPorts = []actiondef.PortDefinition{{Key: containerID.Key, Type: containerID.Type, Scope: containerID.Scope, Visibility: containerID.Visibility, Required: true}}
	return []actiondef.Step{prepare, build, cleanupTemplates, prune, inspect, create, copyStep, cleanup}
}

func environmentSlice(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+values[key])
	}
	return out
}

func actionLabel(action resources.AppAction, label string) string {
	verb := strings.ToUpper(string(action[:1])) + string(action[1:])
	if strings.TrimSpace(label) == "" {
		return verb
	}
	return fmt.Sprintf("%s: %s", verb, label)
}
