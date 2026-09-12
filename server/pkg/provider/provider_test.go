package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveStoresCredentialPlaceholdersAndEnvEntries(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "providers"), filepath.Join(dir, ".env"))

	if err := store.Save(Provider{Name: "work-git", Type: TypeGitLab, Username: "alice", Token: "secret-token"}); err != nil {
		t.Fatal(err)
	}

	data := readFile(t, filepath.Join(dir, "providers", "work-git.json"))
	if strings.Contains(data, "alice") || strings.Contains(data, "secret-token") {
		t.Fatalf("provider file contains raw credentials:\n%s", data)
	}
	if !strings.Contains(data, "${DEVENV_PROVIDER_WORK_GIT_USERNAME}") || !strings.Contains(data, "${DEVENV_PROVIDER_WORK_GIT_TOKEN}") {
		t.Fatalf("provider file missing placeholders:\n%s", data)
	}

	env := readFile(t, filepath.Join(dir, ".env"))
	if !strings.Contains(env, "DEVENV_PROVIDER_WORK_GIT_USERNAME=") || !strings.Contains(env, "DEVENV_PROVIDER_WORK_GIT_TOKEN=") {
		t.Fatalf("env missing credential entries:\n%s", env)
	}

	if err := store.Load(); err != nil {
		t.Fatal(err)
	}
	p, ok := store.Get("work-git")
	if !ok || p.Username != "alice" || p.Token != "secret-token" {
		t.Fatalf("credentials not resolved: %#v ok=%v", p, ok)
	}
}

func TestLoadReportsClearTextProviderCredentials(t *testing.T) {
	dir := t.TempDir()
	providers := filepath.Join(dir, "providers")
	if err := os.MkdirAll(providers, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(providers, "legacy.json"), []byte(`{"name":"legacy","type":"github","username":"bob","token":"old"}`), 0600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(providers, filepath.Join(dir, ".env"))
	if err := store.Load(); err != nil {
		t.Fatalf("load should not fail for invalid provider file: %v", err)
	}
	if _, ok := store.Get("legacy"); ok {
		t.Fatal("invalid provider should not be usable")
	}
	invalid := store.InvalidProviders()
	if len(invalid) != 1 || invalid[0].Name != "legacy" || !strings.Contains(invalid[0].Message, "clear-text") {
		t.Fatalf("invalid provider not reported: %#v", invalid)
	}
	username, token := store.CredentialsFor("legacy")
	if username != "" || token != "" {
		t.Fatalf("invalid provider credentials should be guarded, got %q %q", username, token)
	}
}

func TestSavePreservesTokenWhenEmptyAndReplacesWhenSet(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "providers"), filepath.Join(dir, ".env"))
	if err := store.Save(Provider{Name: "work", Type: TypeGitHub, Username: "alice", Token: "old"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(Provider{Name: "work", Type: TypeGitHub, Username: "alice2"}); err != nil {
		t.Fatal(err)
	}
	p, _ := store.Get("work")
	if p.Username != "alice2" || p.Token != "old" {
		t.Fatalf("token not preserved: %#v", p)
	}
	if err := store.Save(Provider{Name: "work", Type: TypeGitHub, Username: "alice2", Token: "new"}); err != nil {
		t.Fatal(err)
	}
	p, _ = store.Get("work")
	if p.Token != "new" {
		t.Fatalf("token not replaced: %#v", p)
	}
	if strings.Contains(readFile(t, filepath.Join(dir, "providers", "work.json")), "new") {
		t.Fatal("raw replacement token written to provider JSON")
	}
}

func TestDeleteRemovesOnlyProviderEnvEntries(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("KEEP=1\nDEVENV_PROVIDER_OTHER_TOKEN=stay\n"), 0600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(filepath.Join(dir, "providers"), envPath)
	if err := store.Save(Provider{Name: "work", Type: TypeGitLab, Username: "alice", Token: "secret"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("work"); err != nil {
		t.Fatal(err)
	}
	env := readFile(t, envPath)
	if strings.Contains(env, "DEVENV_PROVIDER_WORK_") || !strings.Contains(env, "KEEP=1") || !strings.Contains(env, "DEVENV_PROVIDER_OTHER_TOKEN=stay") {
		t.Fatalf("unexpected env after delete:\n%s", env)
	}
}

func TestLoadReportsMissingEnvVars(t *testing.T) {
	dir := t.TempDir()
	providers := filepath.Join(dir, "providers")
	if err := os.MkdirAll(providers, 0755); err != nil {
		t.Fatal(err)
	}
	// Write a provider with env placeholder
	providerJSON := `{"name":"work","type":"github","username":"${DEVENV_PROVIDER_WORK_USERNAME}","token":"${DEVENV_PROVIDER_WORK_TOKEN}"}`
	if err := os.WriteFile(filepath.Join(providers, "work.json"), []byte(providerJSON), 0600); err != nil {
		t.Fatal(err)
	}
	// Write .env with only username, missing token
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("DEVENV_PROVIDER_WORK_USERNAME=alice\n"), 0600); err != nil {
		t.Fatal(err)
	}

	store := NewStore(providers, envPath)
	if err := store.Load(); err != nil {
		t.Fatal(err)
	}
	p, ok := store.Get("work")
	if !ok {
		t.Fatal("provider not loaded")
	}
	if p.Username != "alice" {
		t.Fatalf("expected username alice, got %q", p.Username)
	}
	if p.Token != "" {
		t.Fatalf("expected empty token, got %q", p.Token)
	}
	if len(p.MissingVars) != 1 || p.MissingVars[0] != "DEVENV_PROVIDER_WORK_TOKEN" {
		t.Fatalf("expected [DEVENV_PROVIDER_WORK_TOKEN] missing, got %v", p.MissingVars)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
