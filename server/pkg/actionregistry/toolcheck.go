package actionregistry

import (
	"context"
	"os/exec"
	"time"
)

// ToolSet tracks which command-line tools are available on the system.
type ToolSet struct {
	Docker        bool
	Podman        bool
	DockerCompose bool
	PodmanCompose bool
	Tmux          bool
	Kind          bool
	Kubectl       bool
	Helm          bool
}

// CheckToolAvailability probes for common tools via exec.LookPath.
func CheckToolAvailability() ToolSet {
	return ToolSet{
		Docker:        lookPath("docker") && daemonReachable("docker"),
		Podman:        lookPath("podman") && daemonReachable("podman"),
		DockerCompose: lookPath("docker-compose") || lookPath("docker"),
		PodmanCompose: lookPath("podman-compose"),
		Tmux:          lookPath("tmux"),
		Kind:          lookPath("kind"),
		Kubectl:       lookPath("kubectl"),
		Helm:          lookPath("helm"),
	}
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func daemonReachable(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, name, "info").Run(); err != nil {
		return false
	}
	return true
}
