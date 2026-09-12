package runstatus

import (
	"strconv"
	"strings"
)

type RuntimeState string

const (
	StateRunning  RuntimeState = "running"
	StateStarting RuntimeState = "starting"
	StateFailed   RuntimeState = "failed"
	StateStopped  RuntimeState = "stopped"
	StateUnknown  RuntimeState = "unknown"
)

// Status separates machine-readable state from provider detail.
type Status struct {
	State  RuntimeState `json:"state"`
	Detail string       `json:"detail,omitempty"`
}

func (s Status) String() string {
	if s.Detail == "" {
		return string(s.State)
	}
	return string(s.State) + " (" + s.Detail + ")"
}

// Candidate is one runtime's current observation for an application.
type Candidate struct {
	Source string
	Status string
}

// Rank orders user-visible runtime states. Runtime type never affects priority.
func Rank(status string) int {
	switch State(status) {
	case StateRunning:
		return 5
	case StateStarting:
		return 4
	case StateFailed:
		return 3
	case StateStopped:
		return 2
	default:
		return 1
	}
}

// State normalizes detailed provider output, such as "running (1/1 pods)".
func State(status string) RuntimeState {
	value := strings.ToLower(strings.TrimSpace(status))
	switch {
	case strings.HasPrefix(value, "running"), strings.HasPrefix(value, "healthy"), strings.HasPrefix(value, "up"):
		return StateRunning
	case strings.HasPrefix(value, "starting"), strings.HasPrefix(value, "pending"), strings.HasPrefix(value, "creating"), strings.HasPrefix(value, "restarting"):
		return StateStarting
	case strings.HasPrefix(value, "failed"), strings.HasPrefix(value, "error"), strings.HasPrefix(value, "unhealthy"), strings.Contains(value, "crash"):
		return StateFailed
	case strings.HasPrefix(value, "stopped"), strings.HasPrefix(value, "exited"), strings.HasPrefix(value, "not found"), strings.HasPrefix(value, "unknown"), strings.HasPrefix(value, "down"), value == "":
		return StateStopped
	default:
		return StateUnknown
	}
}

// Normalize converts provider text such as "running (1/1 pods)" into typed state.
func Normalize(status string) Status {
	state := State(status)
	value := strings.TrimSpace(status)
	lower := strings.ToLower(value)
	for _, prefix := range []string{"running", "healthy", "up", "starting", "pending", "creating", "restarting", "failed", "error", "unhealthy", "crash", "stopped", "exited", "not found", "unknown", "down"} {
		if strings.HasPrefix(lower, prefix) {
			detail := strings.TrimSpace(value[len(prefix):])
			if strings.HasPrefix(detail, "(") && strings.HasSuffix(detail, ")") {
				detail = strings.TrimSpace(detail[1 : len(detail)-1])
			}
			return Status{State: state, Detail: detail}
		}
	}
	return Status{State: state}
}

// SelectStatus returns highest-priority observed state. Equal highest states are
// aggregated so no runtime receives accidental precedence.
func SelectStatus(candidates []Candidate) Status {
	if len(candidates) == 0 {
		return Status{State: StateStopped}
	}
	bestRank := -1
	best := []Candidate{}
	for _, candidate := range candidates {
		rank := Rank(candidate.Status)
		if rank > bestRank {
			bestRank = rank
			best = []Candidate{candidate}
			continue
		}
		if rank == bestRank {
			best = append(best, candidate)
		}
	}
	state := State(best[0].Status)
	if state == StateStopped || state == StateUnknown {
		return Status{State: StateStopped}
	}
	if len(best) > 1 {
		return Status{State: state, Detail: strconv.Itoa(len(best)) + " targets"}
	}
	return Normalize(best[0].Status)
}

// Select preserves legacy string callers while typed consumers migrate.
func Select(candidates []Candidate) string {
	return SelectStatus(candidates).String()
}
