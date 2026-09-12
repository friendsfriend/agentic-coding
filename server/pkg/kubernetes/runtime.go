package kubernetes

import (
	"fmt"
	"os/exec"

	"github.com/friendsfriend/devenv/pkg/docker"
)

const (
	DefaultClusterName = "devenv"
	DefaultContextName = "kind-devenv"
)

type Runner struct {
	KindCommand    string
	KubectlCommand string
	HelmCommand    string
	ClusterName    string
	ContextName    string
	Container      docker.Runtime
	LookPath       func(string) (string, error)
}

func NewRunner(container docker.Runtime) Runner {
	return Runner{KindCommand: "kind", KubectlCommand: "kubectl", HelmCommand: "helm", ClusterName: DefaultClusterName, ContextName: DefaultContextName, Container: container, LookPath: exec.LookPath}
}

func (r Runner) withDefaults() Runner {
	if r.KindCommand == "" {
		r.KindCommand = "kind"
	}
	if r.KubectlCommand == "" {
		r.KubectlCommand = "kubectl"
	}
	if r.HelmCommand == "" {
		r.HelmCommand = "helm"
	}
	if r.ClusterName == "" {
		r.ClusterName = DefaultClusterName
	}
	if r.ContextName == "" {
		r.ContextName = DefaultContextName
	}
	if r.LookPath == nil {
		r.LookPath = exec.LookPath
	}
	return r
}

func (r Runner) Preflight() error {
	r = r.withDefaults()
	for _, tool := range []string{r.KindCommand, r.KubectlCommand, r.HelmCommand} {
		if _, err := r.LookPath(tool); err != nil {
			return fmt.Errorf("missing required Kubernetes tool %q: %w", tool, err)
		}
	}
	if r.Container.Command == "" {
		return fmt.Errorf("missing container runtime command")
	}
	if _, err := r.LookPath(r.Container.Command); err != nil {
		return fmt.Errorf("missing container runtime %q: %w", r.Container.Command, err)
	}
	return nil
}

type Command struct {
	Name string
	Args []string
	Env  []string
}

func (r Runner) KindGetClustersCommand() Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"get", "clusters"}, Env: r.kindEnv()}
}
func (r Runner) KindCreateClusterCommand() Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"create", "cluster", "--name", r.ClusterName}, Env: r.kindEnv()}
}

func (r Runner) KindDeleteClusterCommand() Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"delete", "cluster", "--name", r.ClusterName}, Env: r.kindEnv()}
}

func (r Runner) KubectlCommandFor(args ...string) Command {
	r = r.withDefaults()
	return Command{Name: r.KubectlCommand, Args: append([]string{"--context", r.ContextName}, args...)}
}
func (r Runner) HelmCommandFor(args ...string) Command {
	r = r.withDefaults()
	return Command{Name: r.HelmCommand, Args: append([]string{"--kube-context", r.ContextName}, args...)}
}
func (r Runner) KindLoadImageCommand(image string) Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"load", "docker-image", image, "--name", r.ClusterName}, Env: r.kindEnv()}
}

func (r Runner) KindLoadImageArchiveCommand(path string) Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"load", "image-archive", path, "--name", r.ClusterName}, Env: r.kindEnv()}
}

func (r Runner) KindExportKubeconfigCommand() Command {
	r = r.withDefaults()
	return Command{Name: r.KindCommand, Args: []string{"export", "kubeconfig", "--name", r.ClusterName}, Env: r.kindEnv()}
}

func (r Runner) kindEnv() []string {
	if r.Container.Name == "podman" {
		return []string{"KIND_EXPERIMENTAL_PROVIDER=podman"}
	}
	return nil
}
