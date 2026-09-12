package actionexec

import (
	"context"
	"strings"
	"time"
)

type KubernetesPodReadinessProbe struct {
	Runner    CommandRunner
	Context   string
	Namespace string
	Selector  string
	Timeout   string
	Interval  time.Duration
}

func (p KubernetesPodReadinessProbe) Wait(ctx context.Context) error {
	interval := p.Interval
	if interval <= 0 {
		interval = time.Second
	}
	args := []string{}
	if p.Context != "" {
		args = append(args, "--context", p.Context)
	}
	if p.Namespace != "" {
		args = append(args, "--namespace", p.Namespace)
	}
	for {
		get := append(append([]string{}, args...), "get", "pods", "-l", p.Selector, "-o", "name")
		result := p.Runner.Run(ctx, CommandSpec{Name: "kubectl", Args: get}, nil)
		if result.Err != nil {
			return result.Err
		}
		if strings.TrimSpace(result.Stdout) != "" {
			timeout := p.Timeout
			if timeout == "" {
				timeout = "5m"
			}
			wait := append(append([]string{}, args...), "wait", "--for=condition=ready", "pod", "-l", p.Selector, "--timeout", timeout)
			return p.Runner.Run(ctx, CommandSpec{Name: "kubectl", Args: wait}, nil).Err
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
