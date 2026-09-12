package actionrun

import (
	"fmt"
	"sync"
	"time"
)

const HistoryRetention = 24 * time.Hour

type Registry struct {
	mu   sync.Mutex
	runs map[string]Run
	keys map[string]string
	refs map[string]string
}

func NewRegistry() *Registry {
	return &Registry{runs: map[string]Run{}, keys: map[string]string{}, refs: map[string]string{}}
}
func (r *Registry) Reserve(appIdent, action string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := appIdent + "\x00" + action
	if existing, ok := r.keys[key]; ok {
		return fmt.Errorf("%s action already active for %s (run %s)", action, appIdent, existing)
	}
	r.keys[key] = "reserved"
	return nil
}
func (r *Registry) Start(run Run, appIdent, action string, dependencies []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := appIdent + "\x00" + action
	if existing, ok := r.keys[key]; ok && existing != "reserved" {
		return fmt.Errorf("%s action already active for %s (run %s)", action, appIdent, existing)
	}
	for _, dep := range dependencies {
		if _, ok := r.refs[dep]; !ok {
			r.refs[dep] = run.ID
		}
	}
	r.keys[key] = run.ID
	run.AppIdent, run.Action = appIdent, action
	if run.StartedAt == nil {
		now := time.Now()
		run.StartedAt = &now
	}
	r.runs[run.ID] = run
	return nil
}
func (r *Registry) Release(appIdent, action string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.keys, appIdent+"\x00"+action)
}
func (r *Registry) ActiveForApp(appIdent string) []Run {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Run{}
	for _, run := range r.runs {
		if run.AppIdent == appIdent && (run.Status == StatusActive || run.Status == StatusPending) {
			out = append(out, run)
		}
	}
	return out
}
func (r *Registry) Cancel(id string) { r.Complete(id, Status("canceled")) }

// HasStep reports whether run id already has a step with the given ID, so
// dynamic step creation stays idempotent instead of duplicating pre-declared
// steps (dependency/target steps already carry their own label and parent).
func (r *Registry) HasStep(id, stepID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[id]
	if !ok {
		return false
	}
	for _, step := range run.Steps {
		if step.ID == stepID {
			return true
		}
	}
	return false
}

// AddStep appends a dynamically discovered step. It is a no-op if a step
// with the same ID already exists so callers can call it unconditionally
// without risking duplicate/mislabeled entries for pre-declared steps.
func (r *Registry) AddStep(id string, step Step) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if run, ok := r.runs[id]; ok {
		for _, existing := range run.Steps {
			if existing.ID == step.ID {
				return
			}
		}
		run.Steps = append(run.Steps, step)
		r.runs[id] = run
	}
}
func (r *Registry) UpdateRun(runID string, update func(*Run)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[runID]
	if !ok {
		return
	}
	update(&run)
	r.runs[runID] = run
}

func (r *Registry) UpdateStep(runID, stepID string, update func(*Step)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[runID]
	if !ok {
		return
	}
	for i := range run.Steps {
		if run.Steps[i].ID == stepID {
			update(&run.Steps[i])
			r.runs[runID] = run
			return
		}
	}
}

func (r *Registry) Complete(id string, status Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if run, ok := r.runs[id]; ok {
		now := time.Now()
		run.Status, run.FinishedAt = status, &now
		r.runs[id] = run
		for key, owner := range r.keys {
			if owner == id {
				delete(r.keys, key)
			}
		}
		for dep, owner := range r.refs {
			if owner == id {
				delete(r.refs, dep)
			}
		}
	}
}
func (r *Registry) Get(id string) (Run, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[id]
	return run, ok
}
func (r *Registry) Active() []Run {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Run{}
	for _, run := range r.runs {
		if run.Status == StatusActive || run.Status == StatusPending {
			out = append(out, run)
		}
	}
	return out
}
func (r *Registry) Cleanup(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, run := range r.runs {
		if run.FinishedAt != nil && now.Sub(*run.FinishedAt) >= HistoryRetention {
			delete(r.runs, id)
			for key, owner := range r.keys {
				if owner == id {
					delete(r.keys, key)
				}
			}
			for dep, owner := range r.refs {
				if owner == id {
					delete(r.refs, dep)
				}
			}
		}
	}
}
