package docker

import (
	"context"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
)

type healthInspector struct{ response container.InspectResponse }
func (f healthInspector) ContainerInspect(context.Context, string) (container.InspectResponse, error) { return f.response, nil }
func inspectState(state *container.State) container.InspectResponse { return container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{State: state}} }

func TestWaitForHealthyHealthy(t *testing.T) {
	state := &container.State{Running: true, Health: &container.Health{Status: "healthy"}}
	if err := WaitForHealthy(context.Background(), healthInspector{inspectState(state)}, "api", time.Second); err != nil { t.Fatal(err) }
}
func TestWaitForHealthyRunningWithoutHealthcheck(t *testing.T) {
	if err := WaitForHealthy(context.Background(), healthInspector{inspectState(&container.State{Running: true})}, "api", time.Second); err != nil { t.Fatal(err) }
}
func TestWaitForHealthyUnhealthy(t *testing.T) {
	state := &container.State{Running: true, Health: &container.Health{Status: "unhealthy"}}
	if err := WaitForHealthy(context.Background(), healthInspector{inspectState(state)}, "api", time.Second); err == nil { t.Fatal("expected unhealthy error") }
}
