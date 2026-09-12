package actionexec

import (
	"context"
	"fmt"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type ProbeFactory interface {
	Probe(actiondef.StepContext, actiondef.Step) (ReadinessProbe, error)
}
type ReadinessHandler struct{ Factory ProbeFactory }

func (ReadinessHandler) Supports(kind actiondef.StepKind) bool {
	return kind == actiondef.StepKindReadiness
}
func (h ReadinessHandler) Execute(ctx actiondef.StepContext, definition actiondef.StepDefinition) actiondef.StepResult {
	step, ok := definition.(actiondef.Step)
	if !ok {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: fmt.Errorf("unsupported readiness descriptor")}
	}
	probe, err := h.Factory.Probe(ctx, step)
	if err == nil {
		err = probe.Wait(ctx.Context())
	}
	if err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	if exports, ok := step.Configuration["endpointExports"].([]actiondef.EndpointValue); ok {
		for _, endpoint := range exports {
			if err := ctx.Set(actiondef.ValueKey("endpoint."+endpoint.Name), actiondef.Value{Type: actiondef.ValueTypeEndpoint, Visibility: actiondef.VisibilityPublic, Data: endpoint}); err != nil {
				return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
			}
		}
	}
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
}

type StandardProbeFactory struct {
	Processes  ProcessStore
	PaneAlive  func(string) bool
	Container  func(string) ReadinessProbe
	Compose    func(actiondef.Step) ReadinessProbe
	Kubernetes func(actiondef.Step) ReadinessProbe
}

func (f StandardProbeFactory) Probe(_ actiondef.StepContext, step actiondef.Step) (ReadinessProbe, error) {
	kind, _ := step.Configuration["probe"].(string)
	switch kind {
	case "tcp":
		address, _ := step.Configuration["address"].(string)
		return TCPProbe{Address: address}, nil
	case "http":
		url, _ := step.Configuration["url"].(string)
		return HTTPProbe{URL: url}, nil
	case "container-health":
		id, _ := step.Configuration["containerId"].(string)
		if f.Container == nil {
			return nil, fmt.Errorf("container readiness unavailable")
		}
		return f.Container(id), nil
	case "kubernetes":
		if f.Kubernetes == nil {
			return nil, fmt.Errorf("kubernetes readiness unavailable")
		}
		return f.Kubernetes(step), nil
	case "compose":
		if f.Compose == nil {
			return nil, fmt.Errorf("compose readiness unavailable")
		}
		return f.Compose(step), nil
	default:
		key, _ := step.Configuration["processStepId"].(string)
		if key != "" {
			handle, ok := f.Processes.Get(key)
			if !ok {
				return nil, fmt.Errorf("process handle %s unavailable", key)
			}
			interval := DefaultStabilizationInterval
			if raw, ok := step.Configuration["stabilizationMs"].(float64); ok {
				interval = time.Duration(raw) * time.Millisecond
			}
			probe := ProcessSurvivalProbe{PID: handle.PID, Interval: interval}
			if handle.PaneID != "" && f.PaneAlive != nil {
				probe.PaneAlive = func() bool { return f.PaneAlive(handle.PaneID) }
			}
			return probe, nil
		}
		// No specific probe configured — use a brief stabilization delay.
		// This covers Docker-compose and other dependency targets where the
		// start command already succeeded and containers just need time to settle.
		interval := DefaultStabilizationInterval
		if raw, ok := step.Configuration["stabilizationMs"].(float64); ok {
			interval = time.Duration(raw) * time.Millisecond
		}
		return ProbeFunc(func(ctx context.Context) error {
			timer := time.NewTimer(interval)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}), nil
	}
}
