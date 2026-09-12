package resources

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveDockerfileForAction(t *testing.T) {
	t.Parallel()

	t.Run("resolves from config dir", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		if err := os.MkdirAll(filepath.Join(configDir, "apps", "build"), 0755); err != nil {
			t.Fatal(err)
		}
		configDF := filepath.Join(configDir, "apps", "build", "my-app-build.Dockerfile")
		if err := os.WriteFile(configDF, []byte("FROM config"), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		gotPath, err := manager.ResolveDockerfileForAction("my-app", localDir, ActionBuild)
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if gotPath != configDF {
			t.Fatalf("got %q, want %q", gotPath, configDF)
		}
	})

	t.Run("returns error when no dockerfile found", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		manager := NewManager(configDir)
		_, err := manager.ResolveDockerfileForAction("unknown-app", localDir, ActionBuild)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("expected fs.ErrNotExist, got: %v", err)
		}
	})
}

func TestResolveComposeFile(t *testing.T) {
	t.Parallel()

	t.Run("resolves from config dir", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		if err := os.MkdirAll(filepath.Join(configDir, "apps", "compose"), 0755); err != nil {
			t.Fatal(err)
		}
		configCompose := filepath.Join(configDir, "apps", "compose", "my-app-compose.yml")
		if err := os.WriteFile(configCompose, []byte("version: '3'"), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		gotPath, err := manager.ResolveComposeFile("my-app", localDir, "")
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if gotPath != configCompose {
			t.Fatalf("got %q, want %q", gotPath, configCompose)
		}
	})

	t.Run("returns error when no compose file found", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		manager := NewManager(configDir)
		_, err := manager.ResolveComposeFile("unknown-app", localDir, "")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("expected fs.ErrNotExist, got: %v", err)
		}
	})

	t.Run("resolves profile-specific compose from config dir", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		if err := os.MkdirAll(filepath.Join(configDir, "apps", "compose"), 0755); err != nil {
			t.Fatal(err)
		}
		profileCompose := filepath.Join(configDir, "apps", "compose", "my-app-staging-compose.yml")
		if err := os.WriteFile(profileCompose, []byte("version: '3'"), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		gotPath, err := manager.ResolveComposeFile("my-app", localDir, "staging")
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if gotPath != profileCompose {
			t.Fatalf("got %q, want %q", gotPath, profileCompose)
		}
	})
}

func TestDiscoverProfiles(t *testing.T) {
	t.Parallel()

	t.Run("discovers profiles from config dir", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		composeDir := filepath.Join(configDir, "apps", "compose")
		if err := os.MkdirAll(composeDir, 0755); err != nil {
			t.Fatal(err)
		}

		for _, name := range []string{
			"my-app-compose.yml",
			"my-app-staging-compose.yml",
			"my-app-prod-compose.yml",
		} {
			if err := os.WriteFile(filepath.Join(composeDir, name), []byte(""), 0644); err != nil {
				t.Fatal(err)
			}
		}

		manager := NewManager(configDir)
		profiles, err := manager.DiscoverProfiles("my-app", localDir)
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if len(profiles) != 2 {
			t.Fatalf("expected 2 profiles, got %d: %v", len(profiles), profiles)
		}

		seen := map[string]bool{}
		for _, p := range profiles {
			seen[p] = true
		}
		if !seen["staging"] || !seen["prod"] {
			t.Fatalf("expected staging and prod, got %v", profiles)
		}
	})

	t.Run("returns nil when no profiles found", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		localDir := t.TempDir()

		manager := NewManager(configDir)
		profiles, err := manager.DiscoverProfiles("my-app", localDir)
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if profiles != nil {
			t.Fatalf("expected nil, got %v", profiles)
		}
	})
}

func TestResolveInfrastructureComposeFile(t *testing.T) {
	t.Parallel()

	t.Run("resolves infrastructure compose from config dir", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(configDir, "infrastructure", "compose"), 0755); err != nil {
			t.Fatal(err)
		}

		composePath := filepath.Join(configDir, "infrastructure", "compose", "redis-compose.yml")
		if err := os.WriteFile(composePath, []byte("services:\n  redis:\n    image: redis:latest\n"), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		gotPath, err := manager.ResolveInfrastructureComposeFile("redis")
		if err != nil {
			t.Fatalf("error = %v", err)
		}

		if gotPath != composePath {
			t.Fatalf("got %q, want %q", gotPath, composePath)
		}
	})

	t.Run("returns error when infrastructure compose file is missing", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		manager := NewManager(configDir)
		_, err := manager.ResolveInfrastructureComposeFile("redis")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("expected fs.ErrNotExist, got: %v", err)
		}
	})
}

func TestReadResourceFileUserOverride(t *testing.T) {
	t.Parallel()

	userConfigDir := t.TempDir()

	customContent := []byte("FROM custom")
	customFilePath := filepath.Join(userConfigDir, "my-dockerfile")
	if err := os.WriteFile(customFilePath, customContent, 0644); err != nil {
		t.Fatalf("failed to write custom override file: %v", err)
	}

	// Need access to the concrete manager to call internal helper readResourceFile
	mgr := NewManager(userConfigDir).(*manager)

	got, err := mgr.readResourceFile("my-dockerfile")
	if err != nil {
		t.Fatalf("readResourceFile() error = %v", err)
	}
	if string(got) != string(customContent) {
		t.Fatalf("readResourceFile() = %q, want %q", string(got), string(customContent))
	}
}

func TestCopyTemplatesDir(t *testing.T) {
	t.Parallel()

	t.Run("missing templates dir is a no-op", func(t *testing.T) {
		t.Parallel()

		emptyConfigDir := t.TempDir()
		manager := NewManager(emptyConfigDir)
		destDir := t.TempDir()

		copied, err := manager.CopyTemplatesDir(destDir)
		if err != nil {
			t.Fatalf("CopyTemplatesDir() with missing templates dir error = %v, want nil", err)
		}
		if len(copied) != 0 {
			t.Fatalf("expected no files copied, got %v", copied)
		}
	})

	t.Run("substitutes env vars in template content", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		destDir := t.TempDir()

		if err := os.MkdirAll(filepath.Join(configDir, "templates"), 0755); err != nil {
			t.Fatal(err)
		}

		templateContent := `<username>${MY_USER}</username>
<password>${MY_PASS}</password>
<literal>no-vars-here</literal>`

		if err := os.WriteFile(filepath.Join(configDir, "templates", "settings.xml"), []byte(templateContent), 0644); err != nil {
			t.Fatal(err)
		}

		envContent := "MY_USER=alice\nMY_PASS=secret123\n"
		if err := os.WriteFile(filepath.Join(configDir, ".env"), []byte(envContent), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		copied, err := manager.CopyTemplatesDir(destDir)
		if err != nil {
			t.Fatalf("CopyTemplatesDir() error = %v", err)
		}
		if len(copied) != 1 {
			t.Fatalf("expected 1 file copied, got %d", len(copied))
		}

		got, err := os.ReadFile(copied[0])
		if err != nil {
			t.Fatalf("failed to read copied file: %v", err)
		}

		want := `<username>alice</username>
<password>secret123</password>
<literal>no-vars-here</literal>`

		if string(got) != want {
			t.Fatalf("substituted content mismatch:\ngot:  %q\nwant: %q", string(got), want)
		}
	})

	t.Run("copies without substitution when no env file exists", func(t *testing.T) {
		t.Parallel()

		configDir := t.TempDir()
		destDir := t.TempDir()

		if err := os.MkdirAll(filepath.Join(configDir, "templates"), 0755); err != nil {
			t.Fatal(err)
		}

		templateContent := `<username>${KEEP_ME}</username>`
		if err := os.WriteFile(filepath.Join(configDir, "templates", "test.xml"), []byte(templateContent), 0644); err != nil {
			t.Fatal(err)
		}

		manager := NewManager(configDir)
		copied, err := manager.CopyTemplatesDir(destDir)
		if err != nil {
			t.Fatalf("CopyTemplatesDir() error = %v", err)
		}

		got, err := os.ReadFile(copied[0])
		if err != nil {
			t.Fatalf("failed to read copied file: %v", err)
		}

		if string(got) != templateContent {
			t.Fatalf("expected unmodified content %q, got %q", templateContent, string(got))
		}
	})
}
