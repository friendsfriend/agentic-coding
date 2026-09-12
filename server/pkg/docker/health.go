package docker

import (
	"context"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
)

type ContainerInspector interface {
	ContainerInspect(context.Context, string) (container.InspectResponse, error)
}
type HealthUpdate func(status string)

func WaitForHealthy(ctx context.Context, inspector ContainerInspector, containerName string, timeout time.Duration) error {
	return waitForHealthy(ctx, inspector, containerName, timeout, nil)
}

func waitForHealthy(ctx context.Context, inspector ContainerInspector, containerName string, timeout time.Duration, update HealthUpdate) error {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	last := ""
	report := func(status string) {
		if update != nil && status != last {
			update(status)
			last = status
		}
	}
	for {
		info, err := inspector.ContainerInspect(ctx, containerName)
		if err != nil {
			report("inspect error: " + err.Error())
			return err
		}
		if info.State == nil {
			return fmt.Errorf("container %q has no state", containerName)
		}
		ready := false
		if info.State.Health == nil {
			if info.State.Running {
				report("running (no healthcheck)")
				ready = true
			} else {
				report("waiting for running")
			}
		} else {
			status := info.State.Health.Status
			report("health: " + status)
			if status == "healthy" {
				ready = true
			}
			if status == "unhealthy" {
				return fmt.Errorf("container %q is unhealthy", containerName)
			}
		}
		if ready {
			return nil
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			if ctx.Err() == context.DeadlineExceeded {
				return fmt.Errorf("container %q readiness timeout after %s", containerName, timeout)
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (dc *dockerClient) WaitForHealthy(ctx context.Context, containerName string, timeout time.Duration) error {
	return waitForHealthy(ctx, dc.cli, containerName, timeout, nil)
}
func (dc *dockerClient) WaitForHealthyWithUpdates(ctx context.Context, containerName string, timeout time.Duration, update HealthUpdate) error {
	return waitForHealthy(ctx, dc.cli, containerName, timeout, update)
}
