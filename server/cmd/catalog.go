package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/state"
	"github.com/spf13/cobra"
)

// catalogCmd is the bounded, read-only catalog invocation used by headless
// consumers. It loads configuration and the state database, prints the
// canonical project catalog as JSON, and exits. It deliberately does NOT build
// the full service container, so no pollers, container pruning, workflow drains
// or environment mutations run.
var catalogCmd = &cobra.Command{
	Use:   "catalog",
	Short: "Print the configured project catalog as JSON and exit",
	Long: "Print the configured app/library project catalog as JSON. This is a " +
		"bounded read-only invocation: it never starts pollers or mutates state.",
	RunE: func(cmd *cobra.Command, args []string) error {
		configDir := resources.ResolveConfigDir()
		homeDir, err := resources.ResolveHomeDir(configDir)
		if err != nil {
			return fmt.Errorf("resolve devenv home: %w", err)
		}
		store, err := openCatalogStateStore(homeDir)
		if err != nil {
			return err
		}
		if store != nil {
			defer store.Close()
		}

		manager := app.NewManager(homeDir, configDir, store)
		if err := manager.LoadCatalogConfig(); err != nil {
			return fmt.Errorf("load configuration: %w", err)
		}
		projects, err := manager.GetProjectCatalog()
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(os.Stdout)
		return encoder.Encode(app.NewProjectCatalog(projects))
	},
}

func init() {
	rootCmd.AddCommand(catalogCmd)
}

// openCatalogStateStore opens the existing devenv state database through the
// read-only SQLite path: it never creates the directory/database, never runs
// migrations and never writes (no WAL mode switch), so catalog observation
// cannot mutate the environment. When the store does not exist yet, the
// catalog falls back to configured-only runtime state.
func openCatalogStateStore(homeDir string) (state.Store, error) {
	store, err := state.OpenReadOnly(filepath.Join(homeDir, "db"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open state database read-only: %w", err)
	}
	return store, nil
}
