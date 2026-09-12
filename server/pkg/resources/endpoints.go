package resources

import (
	"fmt"
	"strings"
)

var endpointStrategies = map[string]bool{"kubernetes-service": true, "port-forward": true, "host-published": true, "compose-service": true}

// ValidateEndpointContracts validates endpoint exports/bindings across targets.
func ValidateEndpointProviderCompatibility(producer, consumer ActionTarget) error {
	if producer.Provider != "" && consumer.Provider != "" && producer.Provider != consumer.Provider && producer.Runtime == ActionRuntimeDocker && consumer.Runtime == ActionRuntimeDocker {
		for _, endpoint := range producer.Exports {
			if endpoint.Strategy == "compose-service" {
				return fmt.Errorf("unsupported direct Docker-to-Podman network binding for endpoint %q", endpoint.Name)
			}
		}
	}
	return nil
}

func ValidateEndpointContracts(targets []ActionTarget) error {
	byID := map[string]ActionTarget{}
	for _, target := range targets {
		byID[target.ID] = target
	}
	ports := map[int]string{}
	for _, target := range targets {
		seen := map[string]bool{}
		for _, endpoint := range target.Exports {
			if strings.TrimSpace(endpoint.Name) == "" || strings.TrimSpace(endpoint.Protocol) == "" || endpoint.Port <= 0 {
				return fmt.Errorf("target %s endpoint requires name, protocol, and positive port", target.ID)
			}
			if seen[endpoint.Name] {
				return fmt.Errorf("target %s duplicate endpoint %q", target.ID, endpoint.Name)
			}
			seen[endpoint.Name] = true
			if !endpointStrategies[endpoint.Strategy] {
				return fmt.Errorf("target %s endpoint %q uses unsupported strategy %q", target.ID, endpoint.Name, endpoint.Strategy)
			}
			if endpoint.Strategy == "port-forward" && endpoint.LocalPort > 0 {
				if owner, ok := ports[endpoint.LocalPort]; ok {
					return fmt.Errorf("endpoint local port %d conflicts between %s and %s", endpoint.LocalPort, owner, target.ID)
				}
				ports[endpoint.LocalPort] = target.ID
			}
		}
		for _, binding := range target.Bindings {
			if binding.Dependency == "" && len(target.Requires) != 1 {
				return fmt.Errorf("target %s endpoint binding %q requires dependency when multiple dependencies exist", target.ID, binding.Name)
			}
			if strings.TrimSpace(binding.Name) == "" || strings.TrimSpace(binding.Export) == "" || strings.TrimSpace(binding.Destination) == "" {
				return fmt.Errorf("target %s endpoint binding requires name, export, and destination", target.ID)
			}
			if binding.Destination != "env" && binding.Destination != "helm" && binding.Destination != "compose" {
				return fmt.Errorf("target %s endpoint binding %q uses unsupported destination %q", target.ID, binding.Name, binding.Destination)
			}
			_ = byID
		}
	}
	return nil
}
