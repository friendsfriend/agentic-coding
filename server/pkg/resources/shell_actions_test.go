package resources

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteShellActionScript(t *testing.T) {
	t.Parallel()

	t.Run("build script template", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		path, err := NewManager(configDir).WriteShellActionScript("my-app", AppActionBuild, "", "bun run build")
		if err != nil {
			t.Fatalf("WriteShellActionScript error = %v", err)
		}
		wantPath := filepath.Join(configDir, "apps", "build", "my-app-build.sh")
		if path != wantPath {
			t.Fatalf("path = %q, want %q", path, wantPath)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(content)
		for _, want := range []string{"#!/usr/bin/env sh", "# devenv:mode=logged", "bun run build"} {
			if !strings.Contains(text, want) {
				t.Fatalf("content missing %q:\n%s", want, text)
			}
		}
	})

	t.Run("powershell build script template", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		path, err := NewManager(configDir).WritePowerShellActionScript("my-app", AppActionBuild, "", "bun run build")
		if err != nil {
			t.Fatalf("WritePowerShellActionScript error = %v", err)
		}
		wantPath := filepath.Join(configDir, "apps", "build", "my-app-build.ps1")
		if path != wantPath {
			t.Fatalf("path = %q, want %q", path, wantPath)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(content)
		for _, want := range []string{"# devenv:mode=logged", "$ErrorActionPreference = \"Stop\"", "bun run build"} {
			if !strings.Contains(text, want) {
				t.Fatalf("content missing %q:\n%s", want, text)
			}
		}
	})

	t.Run("run profile validation prevents traversal", func(t *testing.T) {
		t.Parallel()
		_, err := NewManager(t.TempDir()).WriteShellActionScript("my-app", AppActionRun, "../dev", "bun dev")
		if err == nil {
			t.Fatal("expected validation error")
		}
	})

	t.Run("run script defaults tmux", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		path, err := NewManager(configDir).WriteShellActionScript("my-app", AppActionRun, "dev", "bun dev")
		if err != nil {
			t.Fatalf("WriteShellActionScript error = %v", err)
		}
		if filepath.Base(path) != "my-app-dev.sh" {
			t.Fatalf("path = %q", path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(content), "# devenv:mode=tmux") {
			t.Fatalf("content missing tmux mode:\n%s", content)
		}
	})
}
