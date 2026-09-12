package actionexec

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type ContainerHealthProbe struct {
	Runner    CommandRunner
	Runtime   string
	Container string
	Interval  time.Duration
}

func (p ContainerHealthProbe) Wait(ctx context.Context) error {
	runtime := p.Runtime
	if runtime == "" {
		runtime = "docker"
	}
	return poll(ctx, p.Interval, func() error {
		result := p.Runner.Run(ctx, CommandSpec{Name: runtime, Args: []string{"inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", p.Container}}, nil)
		if result.Err != nil {
			return result.Err
		}
		status := strings.TrimSpace(result.Stdout)
		if strings.HasPrefix(status, "running") && (strings.Contains(status, "healthy") || !strings.Contains(status, "starting")) {
			return nil
		}
		return fmt.Errorf("container %s not ready: %s", p.Container, status)
	})
}
