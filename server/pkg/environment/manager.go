package environment

import (
	"context"
	"sync"

	"github.com/friendsfriend/devenv/pkg/app"
)

// snapshot is the published configured-environment state: the definition files
// plus the runtime overlay, projected by the Bun authority.
type snapshot struct {
	Apps          []app.App          `json:"apps"`
	InfraServices []app.InfraService `json:"infraServices"`
}

// Manager adapts the private manager/catalog operations to app.Manager, so the
// Go services that read or mutate configuration keep their call sites while
// Bun owns the definition files and the runtime overlay.
//
// The published snapshot is cached: an operation that reloads or mutates
// returns the new snapshot in the same response, so a caller never reads a
// half-updated view and the Go side never re-parses configuration itself.
type Manager struct {
	client *Client

	mu            sync.RWMutex
	apps          []app.App
	infraServices []app.InfraService
}

var _ app.Manager = (*Manager)(nil)

// Manager returns the app.Manager view of the client.
func (c *Client) Manager() *Manager { return &Manager{client: c} }

func (m *Manager) publish(next snapshot) {
	apps := next.Apps
	if apps == nil {
		apps = []app.App{}
	}
	services := next.InfraServices
	if services == nil {
		services = []app.InfraService{}
	}
	m.mu.Lock()
	m.apps = apps
	m.infraServices = services
	m.mu.Unlock()
}

// load runs a manager operation and publishes the snapshot it returns.
func (m *Manager) load(operation string, params any) error {
	var next snapshot
	if err := m.client.call(context.Background(), operation, params, &next); err != nil {
		return err
	}
	m.publish(next)
	return nil
}

// refresh publishes the current authority state. It is the fallback for a
// caller that reads before any load has happened.
func (m *Manager) refresh() error {
	return m.load("manager.getApps", struct{}{})
}

func (m *Manager) GetApps() []app.App {
	if apps := m.cached(); apps != nil {
		return apps
	}
	if err := m.refresh(); err != nil {
		return []app.App{}
	}
	return m.cached()
}

func (m *Manager) GetInfraServices() []app.InfraService {
	if services := m.cachedServices(); services != nil {
		return services
	}
	if err := m.refresh(); err != nil {
		return []app.InfraService{}
	}
	return m.cachedServices()
}

func (m *Manager) GetAppByIdent(ident string) (app.App, bool) {
	for _, target := range m.GetApps() {
		if target.Ident == ident {
			return target, true
		}
	}
	return app.App{}, false
}

func (m *Manager) GetInfraServiceByIdent(ident string) (app.InfraService, bool) {
	for _, service := range m.GetInfraServices() {
		if service.Ident == ident {
			return service, true
		}
	}
	return app.InfraService{}, false
}

func (m *Manager) GetDisplayName(ident string) string {
	if target, found := m.GetAppByIdent(ident); found {
		return target.DisplayName
	}
	if service, found := m.GetInfraServiceByIdent(ident); found {
		return service.DisplayName
	}
	return ident
}

// GetProjectCatalog returns the Bun-projected catalog. The projection (and its
// revision) is computed by the authority, never re-derived here.
func (m *Manager) GetProjectCatalog() ([]app.Project, error) {
	var catalog app.ProjectCatalog
	if err := m.client.call(context.Background(), "manager.getProjectCatalog", struct{}{}, &catalog); err != nil {
		return nil, err
	}
	return catalog.Projects, nil
}

// LoadConfig delegates the reload to the Bun authority and refreshes this
// process's snapshot from the same response. A failed reload returns the
// diagnostic and leaves the previous snapshot published.
func (m *Manager) LoadConfig() error {
	return m.load("manager.loadConfig", struct{}{})
}

// LoadCatalogConfig is the read-only reload: it refreshes the snapshot without
// letting the authority write runtime state as a side effect of observation.
func (m *Manager) LoadCatalogConfig() error {
	return m.load("manager.loadCatalogConfig", struct{}{})
}

// AddApp creates the definition and its runtime row as one authority
// operation, then publishes the returned snapshot.
func (m *Manager) AddApp(newApp app.App) error {
	return m.load("manager.addApp", map[string]any{"app": newApp})
}

func (m *Manager) RemoveApp(ident string, deleteDir bool) error {
	return m.load("manager.removeApp", map[string]any{
		"ident":     ident,
		"deleteDir": deleteDir,
	})
}

func (m *Manager) SaveConfig() error {
	return m.load("manager.saveConfig", struct{}{})
}

func (m *Manager) UpdateAppActiveWorktree(ident, branch string) error {
	return m.load("manager.updateAppActiveWorktree", map[string]string{
		"ident":  ident,
		"branch": branch,
	})
}

func (m *Manager) SetMainWorktreeBranch(ident, branch string) error {
	return m.load("manager.setMainWorktreeBranch", map[string]string{
		"ident":  ident,
		"branch": branch,
	})
}

func (m *Manager) cached() []app.App {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.apps == nil {
		return nil
	}
	return append([]app.App(nil), m.apps...)
}

func (m *Manager) cachedServices() []app.InfraService {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.infraServices == nil {
		return nil
	}
	return append([]app.InfraService(nil), m.infraServices...)
}
