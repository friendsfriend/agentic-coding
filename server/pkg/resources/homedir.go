package resources

import (
	"os"
	"path/filepath"
	"strings"
)

// ResolveHomeDir returns the devenv home directory.
// Priority: DEVENV_HOME env var → DEVENV_HOME in <configDir>/.env → ~/devenv fallback.
func ResolveHomeDir(configDir string) (string, error) {
	if dir := os.Getenv("DEVENV_HOME"); dir != "" {
		return dir, nil
	}

	// Try reading DEVENV_HOME from the .env file in the config directory.
	if configDir != "" {
		envFilePath := filepath.Join(configDir, ".env")
		if vars, err := LoadEnvFile(envFilePath); err == nil {
			if dir, ok := vars["DEVENV_HOME"]; ok && dir != "" {
				// Expand $HOME / ${HOME} substitutions that LoadEnvFile doesn't handle yet.
				if userDir, err := os.UserHomeDir(); err == nil {
					dir = strings.ReplaceAll(dir, "${HOME}", userDir)
					dir = strings.ReplaceAll(dir, "$HOME", userDir)
				}
				return dir, nil
			}
		}
	}

	userDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userDir, "devenv"), nil
}
