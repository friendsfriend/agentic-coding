package server

import (
	"fmt"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func validateActionDependencies(targets []ownedActionTarget, resolver func(resources.DependencyRef) (string, resources.ActionTarget, bool)) error {
	byID := map[string]resources.ActionTarget{}
	for _, owned := range targets {
		byID[owned.target.ID] = owned.target
	}
	visiting := map[string]bool{}
	visited := map[string]bool{}
	var visit func(string, resources.ActionTarget, []string) error
	visit = func(owner string, target resources.ActionTarget, chain []string) error {
		if visited[owner] {
			return nil
		}
		if visiting[owner] {
			return fmt.Errorf("dependency cycle: %v -> %s", chain, owner)
		}
		visiting[owner] = true
		chain = append(chain, owner)
		for _, ref := range target.Requires {
			if ref.Lifecycle != "" && ref.Lifecycle != "shared" && ref.Lifecycle != "owned" && ref.Lifecycle != "external" {
				return fmt.Errorf("invalid dependency lifecycle %q for %s; expected shared, owned, or external", ref.Lifecycle, owner)
			}
			depApp, dep, ok := resolver(ref)
			if !ok {
				return fmt.Errorf("unresolved dependency for %s: app=%q infra=%q runtime=%q profile=%q provider=%q", owner, ref.App, ref.Infra, ref.Runtime, ref.Profile, ref.Provider)
			}
			depID := dep.ID
			if err := resources.ValidateEndpointProviderCompatibility(dep, target); err != nil {
				return err
			}
			for _, binding := range target.Bindings {
				if binding.Dependency != "" && binding.Dependency != dep.ID && binding.Dependency != depApp {
					continue
				}
				found := false
				for _, export := range dep.Exports {
					if export.Name == binding.Export {
						found = true
						break
					}
				}
				if !found {
					return fmt.Errorf("unresolved endpoint export %q for dependency %s", binding.Export, dep.ID)
				}
			}
			if depID == "" {
				depID = depApp + "/" + string(dep.Runtime) + "/" + dep.Profile + "/" + string(dep.Provider)
			}
			if existing, exists := byID[depID]; exists {
				dep = existing
			}
			if err := visit(depID, dep, chain); err != nil {
				return err
			}
		}
		delete(visiting, owner)
		visited[owner] = true
		return nil
	}
	for _, owned := range targets {
		if err := visit(owned.target.ID, owned.target, nil); err != nil {
			return err
		}
	}
	return nil
}
