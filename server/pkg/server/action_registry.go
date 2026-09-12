package server

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/actionregistry"
	"github.com/friendsfriend/devenv/pkg/resources"
)

type supportedStepKinds map[actiondef.StepKind]bool

type ownedActionTarget struct {
	app         string
	target      resources.ActionTarget
	checkoutDir string
}

func (s supportedStepKinds) Has(kind actiondef.StepKind) bool { return s[kind] }

func (s *Server) rebuildActionDefinitions() error {
	if s.actionDefinitions == nil {
		s.actionDefinitions = actionregistry.New()
	}

	// Check which command-line tools are available on this system.
	// Missing tools cause their corresponding action variants to be omitted.
	s.toolAvailability = actionregistry.CheckToolAvailability()
	missing := []string{}
	if !s.toolAvailability.Docker {
		missing = append(missing, "docker")
	}
	if !s.toolAvailability.Podman {
		missing = append(missing, "podman")
	}
	if !s.toolAvailability.Tmux {
		missing = append(missing, "tmux")
	}
	if !s.toolAvailability.Kind {
		missing = append(missing, "kind")
	}
	if !s.toolAvailability.Kubectl {
		missing = append(missing, "kubectl")
	}
	if !s.toolAvailability.Helm {
		missing = append(missing, "helm")
	}
	if !s.toolAvailability.DockerCompose && !s.toolAvailability.PodmanCompose {
		missing = append(missing, "docker-compose or podman-compose")
	}
	for _, tool := range missing {
		log.Printf("[WARN] %s not found on PATH — %s actions will not be created", tool, tool)
	}
	if len(missing) > 0 {
		msg := "Missing tools: " + strings.Join(missing, ", ") + " — corresponding actions will not be created"
		s.BroadcastEvent(Event{Type: "server.notification", Properties: map[string]any{"message": msg, "type": "warning"}, Timestamp: time.Now()})
	}

	providers := []actionregistry.Provider{
		actionregistry.ProviderFunc{ProviderName: "application-targets", CompileFunc: func(context.Context) ([]actiondef.Action, error) {
			all := []ownedActionTarget{}
			for _, application := range s.apps {
				for _, operation := range []resources.AppAction{resources.AppActionBuild, resources.AppActionTest, resources.AppActionRun} {
					targets, err := s.services.ResourcesManager().DiscoverActionTargets(application.Ident, application.LocalDirectoryPath, operation)
					if err != nil {
						return nil, fmt.Errorf("app %s %s: %w", application.Ident, operation, err)
					}
					for _, target := range targets {
						all = append(all, ownedActionTarget{application.Ident, target, application.LocalDirectoryPath})
						if target.Action == resources.AppActionRun && target.Runtime == resources.ActionRuntimeDocker {
							podman := target
							podman.Provider = resources.ContainerProviderPodman
							all = append(all, ownedActionTarget{application.Ident, podman, application.LocalDirectoryPath})
						}
					}
				}
			}
			resolver := func(ref resources.DependencyRef) (string, resources.ActionTarget, bool) {
				if ref.Infra != "" {
					for _, service := range s.infraServices {
						if service.Ident != ref.Infra {
							continue
						}
						runtime := resources.ActionRuntimeDocker
						provider := ref.Provider
						command := ""
						args := []string{}
						source, _ := s.services.ResourcesManager().ResolveInfrastructureComposeFile(service.Ident)
						if service.Type == "script" {
							runtime = resources.ActionRuntimeShell
							command = "/bin/sh"
							source = service.ShellPath
							if ref.Runtime == string(resources.ActionRuntimePowerShell) || ref.Provider == "powershell" {
								runtime = resources.ActionRuntimePowerShell
								command = "pwsh"
								source = service.PowerShellPath
								args = append([]string{"-File", service.PowerShellPath}, service.Args...)
							} else {
								args = append([]string{service.ShellPath}, service.Args...)
							}
						} else if service.Type == "kubernetes" {
							runtime = resources.ActionRuntimeKubernetes
							if service.Kubernetes != nil {
								source = service.Kubernetes.ChartPath
							}
						}
						if ref.Runtime != "" && ref.Runtime != string(runtime) {
							continue
						}
						if provider == "" && runtime == resources.ActionRuntimeDocker {
							provider = resources.ContainerProviderDocker
						}
						workingDir := service.Cwd
						if workingDir == "" && source != "" {
							workingDir = filepath.Dir(source)
						}
						target := resources.ActionTarget{ID: "infra/" + service.Ident, Action: resources.AppActionRun, Runtime: runtime, Profile: ref.Profile, Provider: provider, Label: service.DisplayName, SourcePath: source, WorkingDir: workingDir, Command: command, Args: args, Env: service.Env}
						if service.Kubernetes != nil {
							k := service.Kubernetes
							target.Profile = k.Profile
							if ref.Profile != "" && ref.Profile != k.Profile {
								continue
							}
							target.Kubernetes = &resources.KubernetesTargetMetadata{Provider: resources.ContainerProvider(k.Provider), ClusterName: k.Cluster, ContextName: k.Context, ChartPath: k.ChartPath, Release: k.Release, Namespace: k.Namespace, ValuesFiles: k.Values}
						}
						if ref.Profile != "" && target.Profile != ref.Profile {
							continue
						}
						return service.Ident, target, true
					}
				}
				for _, owned := range all {
					if owned.target.Action != resources.AppActionRun || owned.app != ref.App {
						continue
					}
					if ref.Runtime != "" && string(owned.target.Runtime) != ref.Runtime {
						continue
					}
					if ref.Profile != "" && owned.target.Profile != ref.Profile {
						continue
					}
					resolved := owned.target
					if resolved.Runtime == resources.ActionRuntimeDocker || resolved.Runtime == resources.ActionRuntimeKubernetes {
						provider := ref.Provider
						if provider == "" {
							provider = resources.ContainerProviderDocker
						}
						resolved.Provider = provider
					}
					if ref.Provider != "" && resolved.Provider != ref.Provider {
						continue
					}
					return owned.app, resolved, true
				}
				return "", resources.ActionTarget{}, false
			}
			definitions := []actiondef.Action{}
			seen := map[actiondef.ActionID]bool{}
			kubernetesTargets := make([]resources.ActionTarget, 0)
			for _, owned := range all {
				if owned.target.Runtime == resources.ActionRuntimeKubernetes {
					kubernetesTargets = append(kubernetesTargets, owned.target)
				}
			}
			if err := actionregistry.ValidateKubernetesIdentities(kubernetesTargets); err != nil {
				return nil, err
			}
			runTargets := make([]resources.ActionTarget, 0, len(all))
			for _, owned := range all {
				if owned.target.Action == resources.AppActionRun {
					runTargets = append(runTargets, owned.target)
				}
			}
			if err := resources.ValidateEndpointContracts(runTargets); err != nil {
				return nil, err
			}
			if err := validateActionDependencies(all, resolver); err != nil {
				return nil, err
			}
			for _, owned := range all {
				for _, compiled := range actionregistry.CompileContainerTargetsWithTools(owned.app, owned.target, resolver, s.toolAvailability, owned.checkoutDir) {
					if !seen[compiled.ActionID] {
						seen[compiled.ActionID] = true
						definitions = append(definitions, compiled)
					} else {
						log.Printf("[DEBUG] skip duplicate target %s/%s/%s -> compiled %s legacy=%s app=%s", owned.target.Action, owned.target.Runtime, owned.target.Profile, compiled.ActionID, owned.target.ID, owned.app)
					}
				}
				for _, lifecycle := range actionregistry.CompileDockerLifecycleActions(owned.app, owned.target) {
					// Filter lifecycle actions by tool availability
					if !s.toolAvailability.Docker && lifecycle.ActionRuntime == "docker" {
						continue
					}
					if !s.toolAvailability.Podman && lifecycle.ActionRuntime == "podman" {
						continue
					}
					if !seen[lifecycle.ActionID] {
						seen[lifecycle.ActionID] = true
						definitions = append(definitions, lifecycle)
					}
				}
				for _, lifecycle := range actionregistry.CompileKubernetesLifecycleActions(owned.app, owned.target) {
					if !seen[lifecycle.ActionID] {
						seen[lifecycle.ActionID] = true
						definitions = append(definitions, lifecycle)
					}
				}
			}
			for _, application := range s.apps {
				for _, gitAction := range actionregistry.CompileGitActions(application.Ident, application.LocalDirectoryPath) {
					if !seen[gitAction.ActionID] {
						seen[gitAction.ActionID] = true
						definitions = append(definitions, gitAction)
					}
				}
			}
			return definitions, nil
		}},
		actionregistry.ProviderFunc{ProviderName: "kubernetes-cluster", CompileFunc: func(context.Context) ([]actiondef.Action, error) {
			return actionregistry.CompileKubernetesClusterActionsWithTools(s.toolAvailability), nil
		}},
		actionregistry.ProviderFunc{ProviderName: "infrastructure", CompileFunc: func(context.Context) ([]actiondef.Action, error) {
			definitions := []actiondef.Action{}
			for _, service := range s.infraServices {
				definitions = append(definitions, actionregistry.CompileInfrastructure(service)...)
			}
			return definitions, nil
		}},
	}
	handlers := supportedStepKinds{
		actiondef.StepKindCommand: true, actiondef.StepKindProcess: true, actiondef.StepKindReadiness: true,
		actiondef.StepKindOperation: true, actiondef.StepKindCleanup: true,
	}
	_, err := s.actionDefinitions.Rebuild(context.Background(), providers, handlers)
	return err
}
