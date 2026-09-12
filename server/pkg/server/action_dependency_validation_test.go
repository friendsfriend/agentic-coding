package server

import (
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestValidateActionDependenciesRejectsMissingEndpointExport(t *testing.T) {
	consumer := resources.ActionTarget{
		ID:       "consumer",
		Requires: []resources.DependencyRef{{Infra: "db", Runtime: "shell", Profile: "default"}},
		Bindings: []resources.EndpointBinding{{Name: "DATABASE_URL", Export: "missing", Destination: "env"}},
	}
	producer := resources.ActionTarget{ID: "db", Exports: []resources.EndpointExport{{Name: "database", Protocol: "tcp", Port: 5432, Strategy: "host-published"}}}
	resolver := func(resources.DependencyRef) (string, resources.ActionTarget, bool) { return "db", producer, true }
	if err := validateActionDependencies([]ownedActionTarget{{app: "consumer", target: consumer}}, resolver); err == nil || !strings.Contains(err.Error(), "unresolved endpoint export") {
		t.Fatalf("err=%v", err)
	}
}

func TestValidateActionDependenciesRejectsMissingAndCycles(t *testing.T) {
	a := ownedActionTarget{app: "a", target: resources.ActionTarget{ID: "a", Requires: []resources.DependencyRef{{App: "missing", Runtime: "shell", Profile: "dev"}}}}
	resolver := func(ref resources.DependencyRef) (string, resources.ActionTarget, bool) {
		return "", resources.ActionTarget{}, false
	}
	if err := validateActionDependencies([]ownedActionTarget{a}, resolver); err == nil || !strings.Contains(err.Error(), "unresolved dependency") {
		t.Fatalf("missing err=%v", err)
	}
	first := resources.ActionTarget{ID: "a", Requires: []resources.DependencyRef{{App: "b", Runtime: "shell", Profile: "dev"}}}
	second := resources.ActionTarget{ID: "b", Requires: []resources.DependencyRef{{App: "a", Runtime: "shell", Profile: "dev"}}}
	resolver = func(ref resources.DependencyRef) (string, resources.ActionTarget, bool) {
		if ref.App == "a" {
			return "a", first, true
		}
		if ref.App == "b" {
			return "b", second, true
		}
		return "", resources.ActionTarget{}, false
	}
	if err := validateActionDependencies([]ownedActionTarget{{app: "a", target: first}, {app: "b", target: second}}, resolver); err == nil || !strings.Contains(err.Error(), "dependency cycle") {
		t.Fatalf("cycle err=%v", err)
	}
}
