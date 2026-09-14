package services

import (
	"fmt"
	"path/filepath"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/environment"
	"github.com/friendsfriend/devenv/pkg/state"
)

// EnvironmentOwnership describes which runtime owns the environment state.
type EnvironmentOwnership struct {
	// Migrated is true when Bun owns the state database and the configuration
	// authority (DEVENV_ENVIRONMENT_URL is set).
	Migrated bool
	State    state.Store
	Manager  app.Manager
}

// openEnvironment wires the environment state/config access for this process.
//
// Legacy: this process opens $DEVENV_HOME/db/state.db and parses configuration
// itself. Migrated: Bun owns both, and this process reaches them exclusively
// through the bounded private operations — it opens no writable handle, so
// there is exactly one state writer.
func openEnvironment(homeDir, configDir string) (EnvironmentOwnership, error) {
	if client, migrated := environment.FromEnv(); migrated {
		return EnvironmentOwnership{
			Migrated: true,
			State:    client.Store(),
			Manager:  client.Manager(),
		}, nil
	}
	store, err := state.Open(filepath.Join(homeDir, "db"))
	if err != nil {
		return EnvironmentOwnership{}, fmt.Errorf("failed to open state database: %w", err)
	}
	return EnvironmentOwnership{
		Migrated: false,
		State:    store,
		Manager:  app.NewManager(homeDir, configDir, store),
	}, nil
}
