package resources

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var shellActionProfilePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// WriteShellActionScript creates or replaces a per-app shell action script in the config dir.
func (m *manager) WriteShellActionScript(appIdent string, action AppAction, profile string, command string) (string, error) {
	return m.writeActionScript(appIdent, action, profile, command, ".sh", shellActionScriptTemplate)
}

// WritePowerShellActionScript creates or replaces a per-app PowerShell action script in the config dir.
func (m *manager) WritePowerShellActionScript(appIdent string, action AppAction, profile string, command string) (string, error) {
	return m.writeActionScript(appIdent, action, profile, command, ".ps1", powerShellActionScriptTemplate)
}

func (m *manager) writeActionScript(appIdent string, action AppAction, profile string, command string, ext string, tmpl func(string, LaunchMode, string) string) (string, error) {
	if strings.TrimSpace(appIdent) == "" {
		return "", fmt.Errorf("app ident is required")
	}
	if action != AppActionBuild && action != AppActionTest && action != AppActionRun {
		return "", fmt.Errorf("unsupported shell action %q", action)
	}
	if action == AppActionRun {
		if !shellActionProfilePattern.MatchString(profile) {
			return "", fmt.Errorf("profile must contain only letters, numbers, underscores, and dashes")
		}
	} else {
		profile = ""
	}

	dir := filepath.Join(m.configDir, "apps", "build")
	name := fmt.Sprintf("%s-%s%s", appIdent, action, ext)
	mode := LaunchModeLogged
	label := strings.Title(string(action))
	if action == AppActionRun {
		dir = filepath.Join(m.configDir, "apps", "run")
		name = fmt.Sprintf("%s-%s%s", appIdent, profile, ext)
		mode = LaunchModeTmux
		label = profile
	}

	path := filepath.Join(dir, name)
	cleanDir := filepath.Clean(dir)
	cleanPath := filepath.Clean(path)
	if filepath.Dir(cleanPath) != cleanDir {
		return "", fmt.Errorf("script path escapes config directory")
	}
	if err := os.MkdirAll(cleanDir, 0755); err != nil {
		return "", err
	}
	content := tmpl(label, mode, command)
	if err := os.WriteFile(cleanPath, []byte(content), 0755); err != nil {
		return "", err
	}
	return cleanPath, nil
}

func shellActionScriptTemplate(label string, mode LaunchMode, command string) string {
	command = strings.TrimSpace(command)
	if command == "" {
		command = "echo \"TODO: replace with your command\""
	}
	return fmt.Sprintf("#!/usr/bin/env sh\n# devenv:name=%s\n# devenv:mode=%s\nset -eu\n\n%s\n", label, mode, command)
}

func powerShellActionScriptTemplate(label string, mode LaunchMode, command string) string {
	command = strings.TrimSpace(command)
	if command == "" {
		command = "Write-Host \"TODO: replace with your command\""
	}
	return fmt.Sprintf("# devenv:name=%s\n# devenv:mode=%s\n$ErrorActionPreference = \"Stop\"\nSet-StrictMode -Version Latest\n\n%s\n", label, mode, command)
}
