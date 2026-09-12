package resources

import (
	"fmt"
	"sort"
	"strings"
)

type TargetKind string

const (
	TargetKindAppRun TargetKind = "app-run"
	TargetKindInfra  TargetKind = "infra"
)

type TargetIdentity struct {
	Kind     TargetKind
	App      string
	Infra    string
	Runtime  ActionRuntime
	Profile  string
	Provider ContainerProvider
}

func (i TargetIdentity) String() string {
	owner := i.App
	if i.Kind == TargetKindInfra {
		owner = i.Infra
	}
	parts := []string{string(i.Kind), owner, string(i.Runtime), i.Profile}
	if i.Provider != "" {
		parts = append(parts, string(i.Provider))
	}
	return strings.Join(parts, "/")
}

type RegistryTarget struct {
	ID       string
	Kind     TargetKind
	App      string
	Runtime  ActionRuntime
	Profile  string
	Provider ContainerProvider
	Infra    string
	Requires []DependencyRef
	Running  bool
}

func (t RegistryTarget) Identity() TargetIdentity {
	return TargetIdentity{Kind: t.Kind, App: t.App, Infra: t.Infra, Runtime: t.Runtime, Profile: t.Profile, Provider: t.Provider}
}

type TargetRegistry struct {
	targets map[string]RegistryTarget
}

func NewTargetRegistry(targets []RegistryTarget) TargetRegistry {
	registry := TargetRegistry{targets: map[string]RegistryTarget{}}
	for _, target := range targets {
		registry.targets[target.ID] = target
	}
	return registry
}

func AppRunTargetID(appIdent string, runtime ActionRuntime, profile string) string {
	return AppRuntimeTargetID(appIdent, runtime, profile, "")
}

func AppRuntimeTargetID(appIdent string, runtime ActionRuntime, profile string, provider ContainerProvider) string {
	id := actionTargetID(appIdent, AppActionRun, runtime, profile)
	if provider == "" {
		return id
	}
	return id + "/" + string(provider)
}

func InfraTargetID(infraIdent string) string {
	return "infra/" + infraIdent
}

func InfraRuntimeTargetID(infraIdent, runtime, profile string) string {
	return InfraRuntimeProviderTargetID(infraIdent, runtime, profile, "")
}

func InfraRuntimeProviderTargetID(infraIdent, runtime, profile string, provider ContainerProvider) string {
	if strings.TrimSpace(runtime) == "" || strings.TrimSpace(profile) == "" {
		return InfraTargetID(infraIdent)
	}
	id := fmt.Sprintf("infra/%s/%s/%s", infraIdent, runtime, profile)
	if provider == "" {
		return id
	}
	return id + "/" + string(provider)
}

func (r TargetRegistry) ResolveRef(ref DependencyRef) (string, error) {
	if strings.TrimSpace(ref.Infra) != "" {
		id := InfraRuntimeProviderTargetID(ref.Infra, ref.Runtime, ref.Profile, ref.Provider)
		if _, ok := r.targets[id]; !ok {
			if ref.Runtime != "" || ref.Profile != "" {
				return "", fmt.Errorf("unknown infrastructure target %q runtime %q profile %q", ref.Infra, ref.Runtime, ref.Profile)
			}
			return "", fmt.Errorf("unknown infrastructure service %q", ref.Infra)
		}
		return id, nil
	}
	if strings.TrimSpace(ref.App) == "" {
		return "", fmt.Errorf("dependency requires app or infra")
	}
	if strings.TrimSpace(ref.Runtime) == "" {
		return "", fmt.Errorf("app dependency %q requires runtime", ref.App)
	}
	if strings.TrimSpace(ref.Profile) == "" {
		return "", fmt.Errorf("app dependency %q requires profile", ref.App)
	}
	id := AppRuntimeTargetID(ref.App, ActionRuntime(ref.Runtime), ref.Profile, ref.Provider)
	if _, ok := r.targets[id]; !ok {
		return "", fmt.Errorf("unknown app run target %q runtime %q profile %q", ref.App, ref.Runtime, ref.Profile)
	}
	return id, nil
}

func (r TargetRegistry) Target(id string) (RegistryTarget, bool) {
	target, ok := r.targets[id]
	return target, ok
}

func (r TargetRegistry) Dependencies(id string) ([]RegistryTarget, error) {
	target, ok := r.targets[id]
	if !ok {
		return nil, fmt.Errorf("unknown target %q", id)
	}
	deps := make([]RegistryTarget, 0, len(target.Requires))
	for _, ref := range target.Requires {
		depID, err := r.ResolveRef(ref)
		if err != nil {
			return nil, err
		}
		deps = append(deps, r.targets[depID])
	}
	return deps, nil
}

func (r TargetRegistry) ResolveStartPlan(rootID string) ([]RegistryTarget, error) {
	if _, ok := r.targets[rootID]; !ok {
		return nil, fmt.Errorf("unknown target %q", rootID)
	}
	visited := map[string]bool{}
	visiting := map[string]bool{}
	var stack []string
	var plan []RegistryTarget
	var visit func(string) error
	visit = func(id string) error {
		if visited[id] {
			return nil
		}
		if visiting[id] {
			cycle := appendCycle(stack, id)
			return fmt.Errorf("dependency cycle: %s", strings.Join(cycle, " -> "))
		}
		target := r.targets[id]
		visiting[id] = true
		stack = append(stack, id)
		refs := append([]DependencyRef(nil), target.Requires...)
		sort.SliceStable(refs, func(i, j int) bool { return refKey(refs[i]) < refKey(refs[j]) })
		for _, ref := range refs {
			depID, err := r.ResolveRef(ref)
			if err != nil {
				return err
			}
			if err := visit(depID); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		visiting[id] = false
		visited[id] = true
		if !target.Running {
			plan = append(plan, target)
		}
		return nil
	}
	if err := visit(rootID); err != nil {
		return nil, err
	}
	return plan, nil
}

func refKey(ref DependencyRef) string {
	if ref.Infra != "" {
		return InfraRuntimeProviderTargetID(ref.Infra, ref.Runtime, ref.Profile, ref.Provider)
	}
	return AppRuntimeTargetID(ref.App, ActionRuntime(ref.Runtime), ref.Profile, ref.Provider)
}

func appendCycle(stack []string, id string) []string {
	for i, candidate := range stack {
		if candidate == id {
			return append(append([]string{}, stack[i:]...), id)
		}
	}
	return append(append([]string{}, stack...), id)
}
