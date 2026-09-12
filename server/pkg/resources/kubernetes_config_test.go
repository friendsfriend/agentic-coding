package resources

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadKubernetesConfigAppliesProviderIdentityDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, KubernetesConfigFileName)
	if err := os.WriteFile(path, []byte(`{"targets":[{"profile":"local","chart":{"path":"chart"}}],"infrastructure":[{"profile":"dev","chart":{"path":"chart"}}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadKubernetesConfig(path, dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Targets[0].Provider != ContainerProviderDocker || cfg.Targets[0].Cluster != "devenv" || cfg.Targets[0].Context != "kind-devenv" {
		t.Fatalf("target identity=%#v", cfg.Targets[0])
	}
	if cfg.Infrastructure[0].Cluster != "devenv-dev" || cfg.Infrastructure[0].Context != "kind-devenv-dev" {
		t.Fatalf("infra identity=%#v", cfg.Infrastructure[0])
	}
}
