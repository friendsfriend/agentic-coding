package docker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/docker/docker/client"
)

// Runtime describes configured Docker-compatible container runtime.
type Runtime struct {
	Name    string
	Command string
	Host    string
}

var selectedRuntime = Runtime{Name: "docker", Command: "docker"}

func RuntimeCommand() string {
	return selectedRuntime.Command
}

func RuntimeName() string {
	return selectedRuntime.Name
}

func ComposeCommand() string {
	return ComposeCommandForRuntime(selectedRuntime.Name)
}

func RuntimeCommandForRuntime(name string) string {
	if name == "podman" {
		return "podman"
	}
	return "docker"
}

func ComposeCommandForRuntime(name string) string {
	if name == "podman" {
		return "podman-compose"
	}
	return "docker-compose"
}

func SetRuntimeForTest(rt Runtime) func() {
	previous := selectedRuntime
	selectedRuntime = rt
	return func() { selectedRuntime = previous }
}

func SelectRuntime(configured string) (Runtime, error) {
	name := strings.ToLower(strings.TrimSpace(configured))
	if name == "" {
		name = "docker"
	}
	if name != "docker" && name != "podman" {
		return Runtime{}, fmt.Errorf("unsupported DEVENV_CONTAINER_RUNTIME %q (expected docker or podman)", configured)
	}

	candidates := runtimeCandidates(name)
	var errs []string
	for _, rt := range candidates {
		if err := runtimePing(rt); err == nil {
			selectedRuntime = rt
			return rt, nil
		} else {
			errs = append(errs, err.Error())
		}
	}
	return Runtime{}, fmt.Errorf("configured container runtime %q is not available or has no running server/machine: %s", name, strings.Join(errs, "; "))
}

func runtimeCandidates(name string) []Runtime {
	if name == "docker" {
		return []Runtime{{Name: "docker", Command: "docker", Host: os.Getenv("DOCKER_HOST")}}
	}

	if host := os.Getenv("DEVENV_PODMAN_HOST"); host != "" {
		return []Runtime{{Name: "podman", Command: "podman", Host: host}}
	}
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		return []Runtime{{Name: "podman", Command: "podman", Host: host}}
	}
	if runtime.GOOS == "windows" {
		return []Runtime{{Name: "podman", Command: "podman"}}
	}

	uid := os.Getuid()
	home, _ := os.UserHomeDir()
	return []Runtime{
		{Name: "podman", Command: "podman", Host: fmt.Sprintf("unix:///run/user/%d/podman/podman.sock", uid)},
		{Name: "podman", Command: "podman", Host: "unix:///run/podman/podman.sock"},
		{Name: "podman", Command: "podman", Host: "unix://" + filepath.Join(home, ".local/share/containers/podman/machine/podman.sock")},
	}
}

func runtimePing(rt Runtime) error {
	opts := []client.Opt{client.WithAPIVersionNegotiation()}
	if rt.Host != "" {
		opts = append(opts, client.WithHost(rt.Host))
	} else {
		opts = append(opts, client.FromEnv)
	}
	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return err
	}
	defer cli.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	_, err = cli.Ping(ctx)
	return err
}
