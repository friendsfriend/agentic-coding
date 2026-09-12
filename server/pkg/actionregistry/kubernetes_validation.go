package actionregistry

import (
	"fmt"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/resources"
)

// ValidateKubernetesIdentities rejects explicit cluster/context collisions
// across providers. Legacy default devenv identity remains compatible while
// profiles migrate to provider-scoped names.
func ValidateKubernetesIdentities(targets []resources.ActionTarget) error {
	seen := map[string]resources.ContainerProvider{}
	for _, target := range targets {
		if target.Runtime != resources.ActionRuntimeKubernetes || target.Kubernetes == nil {
			continue
		}
		cluster := target.Kubernetes.ClusterName
		context := target.Kubernetes.ContextName
		if cluster == "" {
			cluster = "devenv"
		}
		if context == "" {
			context = "kind-" + cluster
		}
		provider := target.Provider
		if provider == "" {
			provider = resources.ContainerProviderDocker
		}
		key := cluster + "\x00" + context
		if previous, ok := seen[key]; ok && previous != provider && cluster != "devenv" {
			return fmt.Errorf("Kubernetes cluster/context %q/%q claimed by providers %q and %q", cluster, context, previous, provider)
		}
		seen[key] = provider
	}
	return nil
}

func KubernetesIdentityValidationActionError(err error) error {
	return fmt.Errorf("%s: %w", actiondef.ResourceRef{Kind: "kubernetes", ID: "local"}, err)
}
