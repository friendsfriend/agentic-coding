package docker

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

// ContainerEvent represents a Docker container lifecycle event
type ContainerEvent struct {
	ContainerID   string
	ContainerName string
	Action        string
	Time          time.Time
}

// Info contains Docker container information
type Info struct {
	Status      string
	ContainerID string
	Ports       string
}

// Client provides Docker container operations.
type Client interface {
	// GetInfo returns Docker information for an application.
	GetInfo(app App) Info
	// GetInfoForInfra returns Docker information for an infrastructure service.
	GetInfoForInfra(infraService InfraService) Info
	// BatchGetInfo returns Docker info for multiple apps and infra services efficiently.
	BatchGetInfo(apps []App, infraServices []InfraService) (map[string]Info, error)
	// GetAllContainerIDsForApp returns all container IDs for an app.
	GetAllContainerIDsForApp(app App) []string
	// GetContainerLogs retrieves logs from a container.
	GetContainerLogs(containerID string) (string, error)
	// StartContainer starts a stopped container.
	StartContainer(containerID string) error
	// StopContainer stops a running container.
	StopContainer(containerID string) error
	// RestartContainer restarts a container.
	RestartContainer(containerID string) error
	// KillAndRemoveContainer kills and removes a container.
	KillAndRemoveContainer(containerID string) error
	// KillAndRemoveAllContainersForApp kills and removes all containers for an app.
	KillAndRemoveAllContainersForApp(app App) error
	// KillAllRunningContainers kills all running containers for given apps and services.
	KillAllRunningContainers(apps []App, infraServices []InfraService) error
	// RefreshCache forces a cache refresh.
	RefreshCache() error
	// InvalidateContainerCache invalidates the container cache.
	InvalidateContainerCache()
	// SubscribeToEvents returns a channel of container lifecycle events.
	// The caller must cancel ctx to stop the subscription; the error channel
	// receives at most one error and is then closed.
	SubscribeToEvents(ctx context.Context) (<-chan ContainerEvent, <-chan error)
	// StreamContainerStats opens a real-time stats stream for a container.
	StreamContainerStats(ctx context.Context, containerID string) (<-chan ContainerStatsEntry, error)
	// StreamContainerLogs streams logs from a container.
	StreamContainerLogs(ctx context.Context, containerID string, tail string) (<-chan string, error)
}

// App represents an application with a Docker container.
type App interface {
	// GetIdent returns the app identifier.
	GetIdent() string
	// GetContainerBaseName returns the container base name.
	GetContainerBaseName() string
}

// InfraService represents an infrastructure service container.
type InfraService interface {
	// GetIdent returns the infrastructure service identifier.
	GetIdent() string
	// GetContainerBaseName returns the container base name.
	GetContainerBaseName() string
}

// dockerClient implements the Client interface
type dockerClient struct {
	cli       *client.Client
	cache     *containerCache
	fallbacks []*dockerClient
	mutex     sync.RWMutex
}

// containerCache for performance optimization
type containerCache struct {
	containers []container.Summary
	lastUpdate time.Time
	ttl        time.Duration
	mutex      sync.RWMutex
}

// noopClient implements Client with safe defaults when no container runtime is available.
type noopClient struct{}

func (noopClient) GetInfo(App) Info                  { return Info{Status: "not found"} }
func (noopClient) GetInfoForInfra(InfraService) Info { return Info{Status: "not found"} }
func (noopClient) BatchGetInfo(apps []App, infra []InfraService) (map[string]Info, error) {
	results := make(map[string]Info, len(apps)+len(infra))
	for _, a := range apps {
		results[a.GetIdent()] = Info{Status: "not found"}
	}
	for _, s := range infra {
		results[s.GetIdent()] = Info{Status: "not found"}
	}
	return results, nil
}
func (noopClient) GetAllContainerIDsForApp(App) []string { return nil }
func (noopClient) GetContainerLogs(string) (string, error) {
	return "", fmt.Errorf("no container runtime available")
}
func (noopClient) StartContainer(string) error   { return fmt.Errorf("no container runtime available") }
func (noopClient) StopContainer(string) error    { return fmt.Errorf("no container runtime available") }
func (noopClient) RestartContainer(string) error { return fmt.Errorf("no container runtime available") }
func (noopClient) KillAndRemoveContainer(string) error {
	return fmt.Errorf("no container runtime available")
}
func (noopClient) KillAndRemoveAllContainersForApp(App) error {
	return fmt.Errorf("no container runtime available")
}
func (noopClient) KillAllRunningContainers([]App, []InfraService) error { return nil }
func (noopClient) RefreshCache() error                                  { return nil }
func (noopClient) InvalidateContainerCache()                            {}
func (noopClient) SubscribeToEvents(ctx context.Context) (<-chan ContainerEvent, <-chan error) {
	eventCh := make(chan ContainerEvent)
	errCh := make(chan error)
	// Block until cancelled to prevent reconnect loops in the event listener.
	go func() {
		<-ctx.Done()
		close(eventCh)
		close(errCh)
	}()
	return eventCh, errCh
}
func (noopClient) StreamContainerStats(ctx context.Context, containerID string) (<-chan ContainerStatsEntry, error) {
	return nil, fmt.Errorf("no container runtime available")
}
func (noopClient) StreamContainerLogs(ctx context.Context, containerID string, tail string) (<-chan string, error) {
	return nil, fmt.Errorf("no container runtime available")
}

// NewClient creates a Docker-compatible client (Docker or Podman).
// When no container runtime is available, returns a noop client that safely
// reports "not found" / errors, allowing the server to start regardless.
func NewClient(configuredRuntime string) (Client, error) {
	rt, err := SelectRuntime(configuredRuntime)
	if err != nil {
		return noopClient{}, nil
	}

	primary, err := newDockerClient(rt)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"docker", "podman"} {
		if name == rt.Name {
			continue
		}
		for _, candidate := range runtimeCandidates(name) {
			if runtimePing(candidate) != nil {
				continue
			}
			fallback, err := newDockerClient(candidate)
			if err == nil {
				primary.fallbacks = append(primary.fallbacks, fallback)
			}
			break
		}
	}
	return primary, nil
}

func newDockerClient(rt Runtime) (*dockerClient, error) {
	opts := []client.Opt{client.WithAPIVersionNegotiation()}
	if rt.Host != "" {
		opts = append(opts, client.WithHost(rt.Host))
	} else {
		opts = append(opts, client.FromEnv)
	}
	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create %s client: %w", rt.Name, err)
	}
	return &dockerClient{cli: cli, cache: &containerCache{ttl: 30 * time.Second}}, nil
}

// getContainers returns cached containers if valid, otherwise fetches from Docker API
func (dc *dockerClient) getContainers() ([]container.Summary, error) {
	dc.cache.mutex.RLock()

	// Check if cache is still valid
	if dc.cache.containers != nil && time.Since(dc.cache.lastUpdate) < dc.cache.ttl {
		containers := dc.cache.containers
		dc.cache.mutex.RUnlock()
		return containers, nil
	}

	dc.cache.mutex.RUnlock()

	// Cache is invalid, need to fetch new data
	return dc.refreshContainerCache()
}

// refreshContainerCache fetches fresh container data and updates cache
func (dc *dockerClient) refreshContainerCache() ([]container.Summary, error) {
	ctx := context.Background()
	containers, err := dc.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	dc.cache.mutex.Lock()
	dc.cache.containers = containers
	dc.cache.lastUpdate = time.Now()
	dc.cache.mutex.Unlock()

	return containers, nil
}

func (dc *dockerClient) allContainers() ([]container.Summary, error) {
	containers, err := dc.getContainers()
	if err != nil {
		return nil, err
	}
	for _, fallback := range dc.fallbacks {
		if more, err := fallback.getContainers(); err == nil {
			containers = append(containers, more...)
		}
	}
	return containers, nil
}

func (dc *dockerClient) refreshAllContainers() ([]container.Summary, error) {
	containers, err := dc.refreshContainerCache()
	if err != nil {
		return nil, err
	}
	for _, fallback := range dc.fallbacks {
		if more, err := fallback.refreshContainerCache(); err == nil {
			containers = append(containers, more...)
		}
	}
	return containers, nil
}

func (dc *dockerClient) RefreshCache() error {
	_, err := dc.refreshAllContainers()
	return err
}

// invalidateCache forces cache refresh on next access
func (dc *dockerClient) invalidateCache() {
	dc.cache.mutex.Lock()
	dc.cache.containers = nil
	dc.cache.lastUpdate = time.Time{}
	dc.cache.mutex.Unlock()
}

func (dc *dockerClient) InvalidateContainerCache() {
	dc.invalidateCache()
	for _, fallback := range dc.fallbacks {
		fallback.invalidateCache()
	}
}

func (dc *dockerClient) SubscribeToEvents(ctx context.Context) (<-chan ContainerEvent, <-chan error) {
	eventCh := make(chan ContainerEvent, 64)
	errCh := make(chan error, 1)

	filterArgs := filters.NewArgs()
	filterArgs.Add("type", string(events.ContainerEventType))
	for _, action := range []string{"start", "stop", "die", "kill", "restart", "pause", "unpause", "oom"} {
		filterArgs.Add("event", action)
	}

	go func() {
		defer close(eventCh)
		defer close(errCh)

		msgCh, dockerErrCh := dc.cli.Events(ctx, events.ListOptions{Filters: filterArgs})
		for {
			select {
			case <-ctx.Done():
				return
			case err, ok := <-dockerErrCh:
				if !ok {
					return
				}
				if err != nil {
					errCh <- err
				}
				return
			case msg, ok := <-msgCh:
				if !ok {
					return
				}
				// Invalidate cache so next GetInfo call fetches fresh data
				dc.invalidateCache()

				name := dc.containerNameFromEvent(msg.Actor.ID, msg.Actor.Attributes)
				eventCh <- ContainerEvent{
					ContainerID:   msg.Actor.ID,
					ContainerName: name,
					Action:        string(msg.Action),
					Time:          time.Unix(msg.Time, 0),
				}
			}
		}
	}()

	return eventCh, errCh
}

func (dc *dockerClient) GetInfo(app App) Info {
	containers, err := dc.allContainers()
	if err != nil {
		return Info{Status: "error"}
	}

	best := Info{Status: "not found"}
	for _, ctr := range containers {
		for _, name := range ctr.Names {
			if ContainerNameMatches(name, app.GetIdent(), app.GetContainerBaseName()) {
				best = preferredContainerInfo(best, Info{
					Status:      ctr.State,
					ContainerID: ctr.ID,
					Ports:       dc.getDockerPorts(ctr),
				})
			}
		}
	}
	return best
}

func (dc *dockerClient) GetInfoForInfra(infraService InfraService) Info {
	containers, err := dc.allContainers()
	if err != nil {
		return Info{Status: "error"}
	}

	best := Info{Status: "not found"}
	for _, ctr := range containers {
		for _, name := range ctr.Names {
			if ContainerNameMatches(name, infraService.GetIdent(), infraService.GetContainerBaseName()) {
				best = preferredContainerInfo(best, Info{
					Status:      ctr.State,
					ContainerID: ctr.ID,
					Ports:       dc.getDockerPorts(ctr),
				})
			}
		}
	}
	return best
}

func (dc *dockerClient) BatchGetInfo(apps []App, infraServices []InfraService) (map[string]Info, error) {
	containers, err := dc.allContainers()
	if err != nil {
		// Return error status for all requested items, but don't propagate error
		// This allows API to return partial data even when Docker is unavailable
		results := make(map[string]Info)
		for _, app := range apps {
			results[app.GetIdent()] = Info{Status: "error"}
		}
		for _, infraApp := range infraServices {
			results[infraApp.GetIdent()] = Info{Status: "error"}
		}
		return results, nil
	}

	results := make(map[string]Info)

	// Initialize all requested items as "not found"
	for _, app := range apps {
		results[app.GetIdent()] = Info{Status: "not found"}
	}
	for _, infraApp := range infraServices {
		results[infraApp.GetIdent()] = Info{Status: "not found"}
	}

	// Single pass through all containers to match all requested apps/infra
	for _, ctr := range containers {
		for _, name := range ctr.Names {
			// Check against regular apps
			for _, app := range apps {
				if ContainerNameMatches(name, app.GetIdent(), app.GetContainerBaseName()) {
					results[app.GetIdent()] = preferredContainerInfo(results[app.GetIdent()], Info{
						Status:      ctr.State,
						ContainerID: ctr.ID,
						Ports:       dc.getDockerPorts(ctr),
					})
				}
			}

			// Check against infrastructure services
			for _, infraApp := range infraServices {
				if ContainerNameMatches(name, infraApp.GetIdent(), infraApp.GetContainerBaseName()) {
					results[infraApp.GetIdent()] = preferredContainerInfo(results[infraApp.GetIdent()], Info{
						Status:      ctr.State,
						ContainerID: ctr.ID,
						Ports:       dc.getDockerPorts(ctr),
					})
				}
			}
		}
	}

	return results, nil
}

func (dc *dockerClient) GetAllContainerIDsForApp(app App) []string {
	// Action readiness must observe containers created by command that just ran,
	// not status cache from before startup.
	containers, err := dc.refreshAllContainers()
	if err != nil {
		return []string{}
	}

	var containerIDs []string

	for _, ctr := range containers {
		if ctr.State != "running" {
			continue
		}
		for _, name := range ctr.Names {
			// Check for main container
			if ContainerNameMatches(name, app.GetIdent(), app.GetContainerBaseName()) {
				containerIDs = append(containerIDs, ctr.ID)
			}
		}
	}

	return containerIDs
}

// getContainerInfo helper function to get container info by ID
func (dc *dockerClient) getContainerInfo(containerID string) Info {
	containers, err := dc.allContainers()
	if err != nil {
		return Info{Status: "error"}
	}

	for _, ctr := range containers {
		if ctr.ID == containerID {
			return Info{
				Status:      ctr.State,
				ContainerID: ctr.ID,
				Ports:       dc.getDockerPorts(ctr),
			}
		}
	}
	return Info{Status: "not found"}
}

func (dc *dockerClient) containerNameFromEvent(containerID string, attrs map[string]string) string {
	for _, key := range []string{"name", "containerName", "io.kubernetes.container.name"} {
		if attrs[key] != "" {
			return attrs[key]
		}
	}
	if containerID == "" {
		return ""
	}
	containers, err := dc.getContainers()
	if err != nil {
		return containerID
	}
	for _, ctr := range containers {
		if ctr.ID == containerID || strings.HasPrefix(ctr.ID, containerID) {
			for _, name := range ctr.Names {
				if name != "" {
					return strings.TrimPrefix(name, "/")
				}
			}
		}
	}
	return containerID
}

func preferredContainerInfo(current, candidate Info) Info {
	if containerStatusRank(candidate.Status) > containerStatusRank(current.Status) {
		return candidate
	}
	return current
}

func containerStatusRank(status string) int {
	switch strings.ToLower(status) {
	case "running":
		return 100
	case "restarting":
		return 90
	case "paused":
		return 80
	case "created":
		return 70
	case "exited", "dead", "removing":
		return 10
	case "not found", "":
		return 0
	case "error":
		return -1
	default:
		return 50
	}
}

func ContainerNameMatches(name, ident, containerBaseName string) bool {
	cleanName := strings.TrimPrefix(name, "/")
	baseName := regexp.MustCompile(`[-_]\d+$`).ReplaceAllString(cleanName, "")
	matches := []string{containerBaseName, ident, "devenv-" + ident, "devenv_" + ident}
	for _, match := range matches {
		if match == "" {
			continue
		}
		normalizedMatch := normalizeContainerName(match)
		normalizedName := normalizeContainerName(cleanName)
		normalizedBase := normalizeContainerName(baseName)
		if cleanName == match || baseName == match || normalizedName == normalizedMatch || normalizedBase == normalizedMatch || strings.HasSuffix(normalizedBase, "-"+normalizedMatch) {
			return true
		}
	}
	return false
}

func normalizeContainerName(name string) string {
	return strings.ReplaceAll(name, "_", "-")
}

// getDockerPorts formats container port information
func (dc *dockerClient) getDockerPorts(ctr container.Summary) string {
	if len(ctr.Ports) == 0 {
		return ""
	}
	var portStrs []string
	seen := make(map[string]bool)
	for _, p := range ctr.Ports {
		var portStr string
		if p.PublicPort != 0 {
			portStr = fmt.Sprintf("%d->%d/%s", p.PublicPort, p.PrivatePort, p.Type)
		} else {
			portStr = fmt.Sprintf("%d/%s", p.PrivatePort, p.Type)
		}
		if !seen[portStr] {
			portStrs = append(portStrs, portStr)
			seen[portStr] = true
		}
	}
	return strings.Join(portStrs, ", ")
}

func (dc *dockerClient) GetContainerLogs(containerID string) (string, error) {
	ctx := context.Background()
	reader, err := dc.cli.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: false,
		Tail:       "1000",
	})
	if err != nil {
		return "", fmt.Errorf("failed to get container logs: %w", err)
	}
	defer reader.Close()

	var stdoutBuf, stderrBuf strings.Builder
	_, err = stdcopy.StdCopy(&stdoutBuf, &stderrBuf, reader)
	if err != nil {
		return "", fmt.Errorf("failed to copy container logs: %w", err)
	}
	return stdoutBuf.String() + stderrBuf.String(), nil
}

func (dc *dockerClient) StreamContainerLogs(ctx context.Context, containerID string, tail string) (<-chan string, error) {
	if tail == "" {
		tail = "100"
	}
	reader, err := dc.cli.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: false,
		Follow:     true,
		Tail:       tail,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open log stream for container %s: %w", containerID, err)
	}

	lineCh := make(chan string, 64)

	go func() {
		defer close(lineCh)
		defer reader.Close()

		pr, pw := io.Pipe()

		go func() {
			_, _ = stdcopy.StdCopy(pw, pw, reader)
			pw.Close()
		}()

		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
		for scanner.Scan() {
			select {
			case lineCh <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()

	return lineCh, nil
}

func (dc *dockerClient) KillAndRemoveContainer(containerID string) error {
	ctx := context.Background()

	err := dc.cli.ContainerKill(ctx, containerID, "SIGKILL")
	if err != nil {
		return fmt.Errorf("failed to kill container %s: %w", containerID, err)
	}

	err = dc.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
	if err != nil {
		return fmt.Errorf("failed to remove container %s: %w", containerID, err)
	}

	// Invalidate cache after container changes
	dc.invalidateCache()
	return nil
}

func (dc *dockerClient) KillAndRemoveAllContainersForApp(app App) error {
	containerIDs := dc.GetAllContainerIDsForApp(app)
	if len(containerIDs) == 0 {
		return fmt.Errorf("no containers found for app %s", app.GetIdent())
	}

	var errors []string
	for _, containerID := range containerIDs {
		if err := dc.KillAndRemoveContainer(containerID); err != nil {
			errors = append(errors, err.Error())
		}
	}

	if len(errors) > 0 {
		return fmt.Errorf("failed to remove some containers: %s", strings.Join(errors, "; "))
	}

	return nil
}

func (dc *dockerClient) KillAllRunningContainers(apps []App, infraServices []InfraService) error {
	ctx := context.Background()

	// Get all running containers for the apps
	var runningContainers []string

	// Check regular apps (including label servers)
	for _, app := range apps {
		containerIDs := dc.GetAllContainerIDsForApp(app)
		for _, containerID := range containerIDs {
			// Check if container is running
			dockerInfo := dc.getContainerInfo(containerID)
			if dockerInfo.Status == "running" {
				runningContainers = append(runningContainers, containerID)
			}
		}
	}

	// Check infrastructure services
	for _, infraService := range infraServices {
		dockerInfo := dc.GetInfoForInfra(infraService)
		if dockerInfo.Status == "running" && dockerInfo.ContainerID != "" {
			runningContainers = append(runningContainers, dockerInfo.ContainerID)
		}
	}

	if len(runningContainers) == 0 {
		return nil // No running containers to kill
	}

	var errors []string
	successCount := 0

	for _, containerID := range runningContainers {
		// Kill container
		err := dc.cli.ContainerKill(ctx, containerID, "SIGKILL")
		if err != nil {
			errors = append(errors, fmt.Sprintf("kill %s: %v", containerID, err))
			continue
		}

		// Remove container
		err = dc.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
		if err != nil {
			errors = append(errors, fmt.Sprintf("remove %s: %v", containerID, err))
			continue
		}

		successCount++
	}

	// Invalidate cache after bulk container operations
	if successCount > 0 {
		dc.invalidateCache()
	}

	if len(errors) > 0 {
		return fmt.Errorf("failed to kill/remove some containers (%d/%d successful): %s",
			successCount, len(runningContainers), strings.Join(errors, "; "))
	}

	return nil
}

func (dc *dockerClient) StartContainer(containerID string) error {
	ctx := context.Background()

	err := dc.cli.ContainerStart(ctx, containerID, container.StartOptions{})
	if err != nil {
		return fmt.Errorf("failed to start container %s: %w", containerID, err)
	}

	// Invalidate cache after container state changes
	dc.invalidateCache()
	return nil
}

func (dc *dockerClient) StopContainer(containerID string) error {
	ctx := context.Background()

	// Stop with 10 second timeout for graceful shutdown
	timeout := 10
	err := dc.cli.ContainerStop(ctx, containerID, container.StopOptions{
		Timeout: &timeout,
	})
	if err != nil {
		return fmt.Errorf("failed to stop container %s: %w", containerID, err)
	}

	// Invalidate cache after container state changes
	dc.invalidateCache()
	return nil
}

func (dc *dockerClient) RestartContainer(containerID string) error {
	ctx := context.Background()

	// Restart with 10 second timeout for graceful shutdown
	timeout := 10
	err := dc.cli.ContainerRestart(ctx, containerID, container.StopOptions{
		Timeout: &timeout,
	})
	if err != nil {
		return fmt.Errorf("failed to restart container %s: %w", containerID, err)
	}

	// Invalidate cache after container state changes
	dc.invalidateCache()
	return nil
}
