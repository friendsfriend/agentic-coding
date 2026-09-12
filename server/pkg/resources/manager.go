package resources

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Manager provides access to configuration resources.
type Manager interface {
	ConfigDir() string
	ExistsDir(path string) (bool, error)
	CreateFolderIfNotExists(path string) error
	ResolveDockerfileForAction(appIdent, localDir string, action ActionType) (string, error)
	ResolveComposeFile(appIdent, localDir string, profile string) (string, error)
	ResolveInfrastructureComposeFile(infraIdent string) (string, error)
	DiscoverProfiles(appIdent, localDir string) ([]string, error)
	DiscoverActionTargets(appIdent, localDir string, action AppAction) ([]ActionTarget, error)
	WriteShellActionScript(appIdent string, action AppAction, profile string, command string) (string, error)
	WritePowerShellActionScript(appIdent string, action AppAction, profile string, command string) (string, error)
	EnvFilePath() (string, bool)
	ComposeMissingEnvVars(appIdent, localDir string, profile string) []string
	CopyTemplatesDir(destDir string) ([]string, error)
	CopyFile(src, dst string) error
}

type manager struct {
	configDir string
}

func NewManager(configDir string) Manager {
	return &manager{
		configDir: configDir,
	}
}

func (m *manager) ConfigDir() string {
	return m.configDir
}

func (m *manager) readResourceFile(name string) ([]byte, error) {
	if m.configDir == "" {
		return nil, fmt.Errorf("resource file %q not found in config dir %q: %w", name, m.configDir, fs.ErrNotExist)
	}

	resourcePath := filepath.Join(m.configDir, name)
	content, err := os.ReadFile(resourcePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("resource file %q not found in config dir %q: %w", name, m.configDir, fs.ErrNotExist)
		}
		return nil, err
	}
	return content, nil
}

func (m *manager) CreateFolderIfNotExists(path string) error {
	exists, err := m.ExistsDir(path)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return os.Mkdir(path, 0777)
}

func (m *manager) ExistsDir(path string) (bool, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
}

// ActionType represents the type of action for Dockerfile/compose resolution.
type ActionType string

const (
	ActionBuild ActionType = "build"
	ActionTest  ActionType = "test"
)

// ResolveDockerfileForAction resolves the Dockerfile for a given action.
//
// Resolution order:
//  1. {configDir}/apps/build/{appIdent}-{action}.Dockerfile  (config dir, per-app)
//  2. Error — no fallback
func (m *manager) ResolveDockerfileForAction(appIdent, localDir string, action ActionType) (string, error) {
	fileName := fmt.Sprintf("%s-%s.Dockerfile", appIdent, string(action))
	// New unified layout: app-specific Dockerfiles live under apps/build
	configPath := filepath.Join(m.configDir, "apps", "build", fileName)
	if _, err := os.Stat(configPath); err == nil {
		return configPath, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}

	return "", fmt.Errorf("no %s dockerfile found for %q: checked %s: %w",
		string(action), appIdent, configPath, fs.ErrNotExist)
}

// ResolveComposeFile resolves the compose file for running an app.
//
// When profile is non-empty, resolution order:
//  1. {configDir}/apps/compose/{appIdent}-{profile}-compose.yml  (config dir, profile-specific)
//  2. Fall back to default (no-profile) resolution below
//
// Default (no-profile) resolution order:
//  1. {configDir}/apps/compose/{appIdent}-compose.yml  (config dir, per-app)
//  2. Error — no fallback
func (m *manager) ResolveComposeFile(appIdent, localDir string, profile string) (string, error) {
	if profile != "" {
		for _, ext := range []string{"yml", "yaml"} {
			profileConfigFileName := fmt.Sprintf("%s-%s-compose.%s", appIdent, profile, ext)
			// App compose files now live under apps/compose
			profileConfigPath := filepath.Join(m.configDir, "apps", "compose", profileConfigFileName)
			if _, err := os.Stat(profileConfigPath); err == nil {
				return profileConfigPath, nil
			} else if !errors.Is(err, fs.ErrNotExist) {
				return "", err
			}
		}
	}

	for _, ext := range []string{"yml", "yaml"} {
		configFileName := fmt.Sprintf("%s-compose.%s", appIdent, ext)
		// App compose files now live under apps/compose
		configPath := filepath.Join(m.configDir, "apps", "compose", configFileName)
		if _, err := os.Stat(configPath); err == nil {
			return configPath, nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
	}

	return "", fmt.Errorf("no compose file found for %q: checked config dir: %w",
		appIdent, fs.ErrNotExist)
}

func (m *manager) ResolveInfrastructureComposeFile(infraIdent string) (string, error) {
	if strings.TrimSpace(infraIdent) == "" {
		return "", fmt.Errorf("infrastructure ident is required")
	}

	composePath := filepath.Join(m.configDir, "infrastructure", "compose", infraIdent+"-compose.yml")
	if _, err := os.Stat(composePath); err == nil {
		return composePath, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}

	return "", fmt.Errorf("no infrastructure compose file found for %q at %s: %w", infraIdent, composePath, fs.ErrNotExist)
}

// DiscoverProfiles scans the config dir for profile-specific
// compose files and returns the discovered profile names.
//
// Config dir pattern: {configDir}/apps/compose/{appIdent}-{profile}-compose.yml
func (m *manager) DiscoverProfiles(appIdent, localDir string) ([]string, error) {
	var profiles []string

	// scan app compose directory under apps/compose for profile-specific files
	composeDir := filepath.Join(m.configDir, "apps", "compose")
	if entries, err := os.ReadDir(composeDir); err == nil {
		prefix := appIdent + "-"
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			for _, suffix := range []string{"-compose.yml", "-compose.yaml"} {
				minLen := len(prefix) + len(suffix) + 1
				if len(name) >= minLen && strings.HasPrefix(name, prefix) && strings.HasSuffix(name, suffix) {
					profile := name[len(prefix) : len(name)-len(suffix)]
					profiles = append(profiles, profile)
				}
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("reading compose directory: %w", err)
	}

	return profiles, nil
}

func (m *manager) EnvFilePath() (string, bool) {
	p := filepath.Join(m.configDir, ".env")
	if _, err := os.Stat(p); err != nil {
		return "", false
	}
	return p, true
}

// ComposeMissingEnvVars returns the names of env variables referenced in
// the app's compose file that are not defined in the .env file.
func (m *manager) ComposeMissingEnvVars(appIdent, localDir string, profile string) []string {
	composePath, err := m.ResolveComposeFile(appIdent, localDir, profile)
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(composePath)
	if err != nil {
		return nil
	}

	var envVars map[string]string
	if envPath, ok := m.EnvFilePath(); ok {
		envVars, _ = LoadEnvFile(envPath)
	}
	if envVars == nil {
		envVars = make(map[string]string)
	}

	_, missing := SubstituteVarsWithWarnings(string(data), envVars)
	return missing
}

func (m *manager) CopyTemplatesDir(destDir string) ([]string, error) {
	templatesDir := filepath.Join(m.configDir, "templates")

	entries, err := os.ReadDir(templatesDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read templates dir %q: %w", templatesDir, err)
	}

	var envVars map[string]string
	if envPath, ok := m.EnvFilePath(); ok {
		envVars, _ = LoadEnvFile(envPath)
	}

	var copied []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		src := filepath.Join(templatesDir, entry.Name())
		dst := filepath.Join(destDir, entry.Name())

		if err := m.copyTemplateFile(src, dst, envVars); err != nil {
			for _, p := range copied {
				_ = os.Remove(p)
			}
			return nil, fmt.Errorf("failed to copy template %q: %w", entry.Name(), err)
		}
		copied = append(copied, dst)
	}

	return copied, nil
}

// copyTemplateFile reads a template file, applies ${VAR} substitution from
// envVars (if any), and writes the result to dst.
func (m *manager) copyTemplateFile(src, dst string, envVars map[string]string) error {
	content, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("failed to read source file: %w", err)
	}

	output := string(content)
	if len(envVars) > 0 {
		output = SubstituteVars(output, envVars)
	}

	if err := os.WriteFile(dst, []byte(output), 0644); err != nil {
		return fmt.Errorf("failed to write destination file: %w", err)
	}
	return nil
}

func (m *manager) CopyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("failed to create destination file: %w", err)
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	if err != nil {
		return fmt.Errorf("failed to copy file content: %w", err)
	}

	err = destFile.Sync()
	if err != nil {
		return fmt.Errorf("failed to flush file content: %w", err)
	}

	return nil
}
