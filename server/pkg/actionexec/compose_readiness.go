package actionexec

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type ComposeReadinessProbe struct {
	Runner   CommandRunner
	Name     string
	Args     []string
	Interval time.Duration
}

func (p ComposeReadinessProbe) Wait(ctx context.Context) error {
	return poll(ctx, p.Interval, func() error {
		args := append([]string{}, p.Args...)
		args = append(args, "ps")
		if !strings.HasPrefix(p.Name, "podman-compose") {
			args = append(args, "--all")
		}
		args = append(args, "--format", "{{.State}}")
		result := p.Runner.Run(ctx, CommandSpec{Name: p.Name, Args: args}, nil)
		if result.Err != nil {
			return result.Err
		}
		states := strings.Fields(strings.TrimSpace(result.Stdout))
		if len(states) == 0 {
			return fmt.Errorf("compose has no containers")
		}
		for _, state := range states {
			if !strings.EqualFold(state, "running") {
				return fmt.Errorf("compose container not ready: %s", state)
			}
		}
		return nil
	})
}
