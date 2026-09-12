package server

import (
	"context"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/build"
	"github.com/friendsfriend/devenv/pkg/docker"
	gitpkg "github.com/friendsfriend/devenv/pkg/git"
	"github.com/friendsfriend/devenv/pkg/logging"
	"github.com/friendsfriend/devenv/pkg/operations"
	"github.com/friendsfriend/devenv/pkg/provider"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/services"
	"github.com/friendsfriend/devenv/pkg/state"
	statuspkg "github.com/friendsfriend/devenv/pkg/status"
)

// ---- minimal stubs --------------------------------------------------------

// stubDockerClient satisfies docker.Client using zero-value returns.
type stubDockerClient struct{}

func (stubDockerClient) GetInfo(app docker.App) docker.Info { return docker.Info{} }
func (stubDockerClient) GetInfoForInfra(svc docker.InfraService) docker.Info {
	return docker.Info{}
}
func (stubDockerClient) BatchGetInfo(apps []docker.App, infra []docker.InfraService) (map[string]docker.Info, error) {
	return nil, nil
}
func (stubDockerClient) GetAllContainerIDsForApp(app docker.App) []string { return nil }
func (stubDockerClient) GetContainerLogs(id string) (string, error)       { return "", nil }
func (stubDockerClient) StartContainer(id string) error                   { return nil }
func (stubDockerClient) StopContainer(id string) error                    { return nil }
func (stubDockerClient) RestartContainer(id string) error                 { return nil }
func (stubDockerClient) KillAndRemoveContainer(id string) error           { return nil }
func (stubDockerClient) KillAndRemoveAllContainersForApp(app docker.App) error {
	return nil
}
func (stubDockerClient) KillAllRunningContainers(apps []docker.App, infra []docker.InfraService) error {
	return nil
}
func (stubDockerClient) RefreshCache() error       { return nil }
func (stubDockerClient) InvalidateContainerCache() {}
func (stubDockerClient) SubscribeToEvents(ctx context.Context) (<-chan docker.ContainerEvent, <-chan error) {
	return nil, nil
}
func (stubDockerClient) StreamContainerStats(ctx context.Context, id string) (<-chan docker.ContainerStatsEntry, error) {
	return nil, nil
}
func (stubDockerClient) StreamContainerLogs(ctx context.Context, id, tail string) (<-chan string, error) {
	return nil, nil
}

// stubGitRepository satisfies gitpkg.Repository.
// GetCurrentBranch always returns empty string to simulate a freshly created
// linked worktree whose HEAD file is not yet readable.
type stubGitRepository struct{}

func (stubGitRepository) GetBranches(url string) ([]string, error) { return nil, nil }
func (stubGitRepository) GetLocalBranches(app gitpkg.App) ([]string, error) {
	return nil, nil
}
func (stubGitRepository) UpdateOrCreateRepo(app gitpkg.App) (string, error) { return "", nil }
func (stubGitRepository) GetCurrentBranch(app gitpkg.App) string            { return "" } // intentionally empty
func (stubGitRepository) GetStatus(app gitpkg.App) string                   { return "" }
func (stubGitRepository) Push(app gitpkg.App) error                         { return nil }
func (stubGitRepository) Fetch(app gitpkg.App) error                        { return nil }
func (stubGitRepository) Pull(app gitpkg.App) error                         { return nil }
func (stubGitRepository) Checkout(app gitpkg.App, branch string) error      { return nil }
func (stubGitRepository) RefreshCache(path string) error                    { return nil }
func (stubGitRepository) ListWorktrees(app gitpkg.App) ([]gitpkg.WorktreeInfo, error) {
	return nil, nil
}
func (stubGitRepository) AddWorktree(app gitpkg.App, branch string) (string, error) {
	return "", nil
}
func (stubGitRepository) RemoveWorktree(app gitpkg.App, branch string) error { return nil }

// stubServicesContainer satisfies services.Container.
type stubServicesContainer struct {
	dockerClient  docker.Client
	gitRepository gitpkg.Repository
	buildService  build.Service
}

func (c *stubServicesContainer) DockerClient() docker.Client           { return c.dockerClient }
func (c *stubServicesContainer) GitRepository() gitpkg.Repository      { return c.gitRepository }
func (c *stubServicesContainer) Logger() logging.Logger                { return nil }
func (c *stubServicesContainer) HomeDir() string                       { return "" }
func (c *stubServicesContainer) ProviderStore() provider.Store         { return nil }
func (c *stubServicesContainer) StatusManager() statuspkg.Manager      { return nil }
func (c *stubServicesContainer) ResourcesManager() resources.Manager   { return nil }
func (c *stubServicesContainer) AppManager() app.Manager               { return nil }
func (c *stubServicesContainer) StateStore() state.Store               { return nil }
func (c *stubServicesContainer) Executor() *operations.Executor        { return nil }
func (c *stubServicesContainer) BuildService() build.Service           { return c.buildService }
func (c *stubServicesContainer) OperationsService() operations.Service { return nil }

var _ services.Container = (*stubServicesContainer)(nil)

// ---- helpers --------------------------------------------------------------

func newBroadcastTestServer() (*Server, chan Event) {
	ch := make(chan Event, 8)
	s := &Server{
		apps: []app.App{
			{Ident: "my-app", Branch: "feature/new"},
		},
		listeners: map[chan Event]bool{ch: true},
		opStatus:  map[string]*OperationStatus{},
		services: &stubServicesContainer{
			dockerClient:  stubDockerClient{},
			gitRepository: stubGitRepository{},
		},
	}
	return s, ch
}

// ---- tests ----------------------------------------------------------------

// TestBroadcastAppStatusWithBranch_KnownBranch verifies that when a non-empty
// knownBranch is provided the broadcast carries that branch even when
// GetCurrentBranch (reading from disk) returns empty — simulating a freshly
// created linked worktree.
func TestBroadcastAppStatusWithBranch_KnownBranch(t *testing.T) {
	s, ch := newBroadcastTestServer()

	s.broadcastAppStatusWithBranch("my-app", "feature/new")

	select {
	case ev := <-ch:
		if ev.Type != "status.updated" {
			t.Fatalf("expected status.updated event, got %q", ev.Type)
		}
		props, ok := ev.Properties.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map properties, got %T", ev.Properties)
		}
		got, _ := props["branch"].(string)
		if got != "feature/new" {
			t.Errorf("expected branch %q, got %q", "feature/new", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for broadcast event")
	}
}

// TestBroadcastAppStatusWithBranch_FallsBackToGit verifies that when
// knownBranch is empty the function falls back to GetCurrentBranch (which
// returns empty from the stub, but at least the broadcast still fires).
func TestBroadcastAppStatusWithBranch_FallsBackToGit(t *testing.T) {
	s, ch := newBroadcastTestServer()

	s.broadcastAppStatusWithBranch("my-app", "") // empty → falls back to git

	select {
	case ev := <-ch:
		if ev.Type != "status.updated" {
			t.Fatalf("expected status.updated event, got %q", ev.Type)
		}
		// The stub returns "" from GetCurrentBranch, so branch should be ""
		props, _ := ev.Properties.(map[string]interface{})
		got, _ := props["branch"].(string)
		if got != "" {
			t.Errorf("expected empty branch fallback, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for broadcast event")
	}
}

// TestBroadcastAppStatusWithBranch_UnknownApp verifies that when the ident
// is not found no event is broadcast (no panic, graceful no-op for app path).
func TestBroadcastAppStatusWithBranch_UnknownApp(t *testing.T) {
	s, ch := newBroadcastTestServer()

	s.broadcastAppStatusWithBranch("does-not-exist", "main")

	select {
	case ev := <-ch:
		t.Fatalf("expected no event for unknown app, got %v", ev)
	case <-time.After(50 * time.Millisecond):
		// correct: no event sent
	}
}
