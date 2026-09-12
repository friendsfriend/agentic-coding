package resources

import (
	"os"
	"path/filepath"
)

// ResolveConfigDir returns the DevEnv config directory.
// Priority: DEVENV_CONFIG_DIR env var → ~/.config/devenv fallback.
func ResolveConfigDir() string {
	if dir := os.Getenv("DEVENV_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "config"
	}
	return filepath.Join(home, ".config", "devenv")
}
