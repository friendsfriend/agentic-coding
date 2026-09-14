package environment

import (
	"context"
	"time"

	"github.com/friendsfriend/devenv/pkg/state"
)

// storePayload is the wire shape of an app_state row. The Bun authority uses
// the same lowercase field names as its own model, so a value round-trips
// without a translation table.
type storePayload struct {
	Ident              string `json:"ident"`
	Branch             string `json:"branch"`
	ActiveWorktree     string `json:"activeWorktree"`
	MainWorktreeBranch string `json:"mainWorktreeBranch"`
}

type runTargetPayload struct {
	Runtime    string `json:"runtime"`
	LaunchMode string `json:"launchMode"`
	Label      string `json:"label"`
	Profile    string `json:"profile"`
	TargetID   string `json:"targetId"`
	SourcePath string `json:"sourcePath"`
	StartedAt  string `json:"startedAt"`
	Display    string `json:"display"`
}

type leasePayload struct {
	TargetID   string `json:"targetId"`
	OwnerRunID string `json:"ownerRunId"`
	OwnerApp   string `json:"ownerApp"`
	Lifecycle  string `json:"lifecycle"`
	UpdatedAt  string `json:"updatedAt"`
}

// eventTimestamp is the exact textual form the state database stores, so a
// range comparison stays a string comparison on the owning side.
func eventTimestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Store adapts the private operations to the state.Store interface, so the
// remaining Go services keep their existing call sites while Bun owns the
// database. `context.Background` is used because the interface the callers
// depend on has no context; each call is bounded by the client's timeout.
type Store struct {
	client *Client
}

// Store returns the state.Store view of the client.
func (c *Client) Store() *Store { return &Store{client: c} }

var _ state.Store = (*Store)(nil)

func (s *Store) GetAppState(ident string) (state.AppState, error) {
	var payload storePayload
	if err := s.client.call(context.Background(), "state.getAppState", map[string]string{"ident": ident}, &payload); err != nil {
		return state.AppState{}, err
	}
	return state.AppState{
		Ident:              payload.Ident,
		Branch:             payload.Branch,
		ActiveWorktree:     payload.ActiveWorktree,
		MainWorktreeBranch: payload.MainWorktreeBranch,
	}, nil
}

func (s *Store) SetBranch(ident, branch string) error {
	return s.client.call(context.Background(), "state.setBranch", map[string]string{
		"ident": ident, "branch": branch,
	}, nil)
}

func (s *Store) SetActiveWorktree(ident, worktree string) error {
	return s.client.call(context.Background(), "state.setActiveWorktree", map[string]string{
		"ident": ident, "worktree": worktree,
	}, nil)
}

func (s *Store) SetMainWorktreeBranch(ident, branch string) error {
	return s.client.call(context.Background(), "state.setMainWorktreeBranch", map[string]string{
		"ident": ident, "branch": branch,
	}, nil)
}

// SetAppState sends the atomic multi-field update as one operation rather than
// three single-field writes.
func (s *Store) SetAppState(appState state.AppState) error {
	return s.client.call(context.Background(), "state.setAppState", storePayload{
		Ident:              appState.Ident,
		Branch:             appState.Branch,
		ActiveWorktree:     appState.ActiveWorktree,
		MainWorktreeBranch: appState.MainWorktreeBranch,
	}, nil)
}

func (s *Store) GetAppRunTargetInfo(ident string) (state.AppRunTargetInfo, bool, error) {
	var payload *runTargetPayload
	if err := s.client.call(context.Background(), "state.getAppRunTargetInfo", map[string]string{"ident": ident}, &payload); err != nil {
		return state.AppRunTargetInfo{}, false, err
	}
	if payload == nil {
		return state.AppRunTargetInfo{}, false, nil
	}
	return state.AppRunTargetInfo{
		Runtime:    payload.Runtime,
		LaunchMode: payload.LaunchMode,
		Label:      payload.Label,
		Profile:    payload.Profile,
		TargetID:   payload.TargetID,
		SourcePath: payload.SourcePath,
		StartedAt:  payload.StartedAt,
		Display:    payload.Display,
	}, true, nil
}

func (s *Store) SetAppRunTargetInfo(ident string, info state.AppRunTargetInfo) error {
	return s.client.call(context.Background(), "state.setAppRunTargetInfo", map[string]any{
		"ident": ident,
		"info": runTargetPayload{
			Runtime:    info.Runtime,
			LaunchMode: info.LaunchMode,
			Label:      info.Label,
			Profile:    info.Profile,
			TargetID:   info.TargetID,
			SourcePath: info.SourcePath,
			StartedAt:  info.StartedAt,
			Display:    info.Display,
		},
	}, nil)
}

func (s *Store) ClearAppRunTargetInfo(ident string) error {
	return s.client.call(context.Background(), "state.clearAppRunTargetInfo", map[string]string{"ident": ident}, nil)
}

func (s *Store) GetScriptArgsHistory(relativePath string, limit int) ([]map[string]string, error) {
	var history []map[string]string
	if err := s.client.call(context.Background(), "state.getScriptArgsHistory", map[string]any{
		"relativePath": relativePath,
		"limit":        limit,
	}, &history); err != nil {
		return nil, err
	}
	return history, nil
}

func (s *Store) AddScriptArgsHistory(relativePath string, values map[string]string, maxEntries int) error {
	if values == nil {
		values = map[string]string{}
	}
	return s.client.call(context.Background(), "state.addScriptArgsHistory", map[string]any{
		"relativePath": relativePath,
		"values":       values,
		"maxEntries":   maxEntries,
	}, nil)
}

func (s *Store) GetDependencyLeases() ([]state.DependencyLease, error) {
	var payload []leasePayload
	if err := s.client.call(context.Background(), "state.getDependencyLeases", struct{}{}, &payload); err != nil {
		return nil, err
	}
	leases := make([]state.DependencyLease, 0, len(payload))
	for _, lease := range payload {
		leases = append(leases, state.DependencyLease{
			TargetID:   lease.TargetID,
			OwnerRunID: lease.OwnerRunID,
			OwnerApp:   lease.OwnerApp,
			Lifecycle:  lease.Lifecycle,
			UpdatedAt:  lease.UpdatedAt,
		})
	}
	return leases, nil
}

func (s *Store) SetDependencyLease(lease state.DependencyLease) error {
	return s.client.call(context.Background(), "state.setDependencyLease", leasePayload{
		TargetID:   lease.TargetID,
		OwnerRunID: lease.OwnerRunID,
		OwnerApp:   lease.OwnerApp,
		Lifecycle:  lease.Lifecycle,
		UpdatedAt:  lease.UpdatedAt,
	}, nil)
}

func (s *Store) DeleteDependencyLease(targetID, ownerRunID string) error {
	return s.client.call(context.Background(), "state.deleteDependencyLease", map[string]string{
		"targetId": targetID, "ownerRunId": ownerRunID,
	}, nil)
}

func (s *Store) AddActionEvent(eventJSON string, maxEntries int) error {
	return s.client.call(context.Background(), "state.addActionEvent", map[string]any{
		"eventJson":  eventJSON,
		"maxEntries": maxEntries,
	}, nil)
}

func (s *Store) GetActionEvents(limit int) ([]string, error) {
	var events []string
	if err := s.client.call(context.Background(), "state.getActionEvents", map[string]any{"limit": limit}, &events); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *Store) GetActionEventsSince(limit int, since time.Time) ([]string, error) {
	var events []string
	if err := s.client.call(context.Background(), "state.getActionEventsSince", map[string]any{
		"limit": limit,
		"since": eventTimestamp(since),
	}, &events); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *Store) GetActionEventsBetween(limit int, since, before time.Time) ([]string, error) {
	var events []string
	if err := s.client.call(context.Background(), "state.getActionEventsBetween", map[string]any{
		"limit":  limit,
		"since":  eventTimestamp(since),
		"before": eventTimestamp(before),
	}, &events); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *Store) AddActionLogEvent(runID, stepID, eventJSON string, maxEntries int) error {
	return s.client.call(context.Background(), "state.addActionLogEvent", map[string]any{
		"runId":      runID,
		"stepId":     stepID,
		"eventJson":  eventJSON,
		"maxEntries": maxEntries,
	}, nil)
}

func (s *Store) GetActionLogEvents(runID, stepID string, limit int) ([]string, error) {
	var events []string
	if err := s.client.call(context.Background(), "state.getActionLogEvents", map[string]any{
		"runId":  runID,
		"stepId": stepID,
		"limit":  limit,
	}, &events); err != nil {
		return nil, err
	}
	return events, nil
}

// Close is a no-op: this process owns no database handle in migrated mode.
func (s *Store) Close() error { return nil }
