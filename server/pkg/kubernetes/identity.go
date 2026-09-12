package kubernetes

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type ExecutionIdentity struct {
	Provider resources.ContainerProvider
	Cluster  string
	Context  string
}

func ResolveIdentity(provider resources.ContainerProvider, cluster, context string) ExecutionIdentity {
	if provider == "" {
		provider = resources.ContainerProviderDocker
	}
	if cluster == "" {
		cluster = "devenv"
	}
	if context == "" {
		context = "kind-" + cluster
	}
	return ExecutionIdentity{Provider: provider, Cluster: cluster, Context: context}
}

func (i ExecutionIdentity) Env() []string {
	if i.Provider == resources.ContainerProviderPodman {
		return []string{"KIND_EXPERIMENTAL_PROVIDER=podman"}
	}
	return nil
}

func (i ExecutionIdentity) Archive(actionID string) string {
	safe := strings.NewReplacer("/", "-", ":", "-", " ", "-").Replace(actionID)
	return filepath.Join("/tmp", fmt.Sprintf("devenv-image-%s.tar", safe))
}
