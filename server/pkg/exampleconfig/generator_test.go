package exampleconfig

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateCreatesExampleConfig(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	g := Generator{ConfigDir: configDir, HomeDir: homeDir}
	if err := g.Generate(); err != nil {
		t.Fatal(err)
	}

	files := []string{
		".env",
		"apps/definitions/go-rest-postgres.json",
		"apps/definitions/bhvr-site.json",
		"apps/definitions/event-worker.json",
		"apps/definitions/runtime-dependency-check.json",
		"libraries/definitions/bun-lib-starter.json",
		"infrastructure/definitions/postgres.json",
		"infrastructure/definitions/redis.json",
		"infrastructure/definitions/mailpit.json",
		"infrastructure/definitions/script-clock.json",
		"infrastructure/definitions/runtime-check-powershell.json",
		"infrastructure/definitions/runtime-check-k8s-docker.json",
		"infrastructure/definitions/runtime-check-k8s-podman.json",
		"infrastructure/definitions/postgres-k8s.json",
		"apps/compose/go-rest-postgres-compose.yml",
		"apps/compose/bhvr-site-compose.yml",
		"apps/compose/bhvr-site-debug-compose.yml",
		"apps/compose/bhvr-site-with-redis-compose.yml",
		"apps/compose/event-worker-compose.yml",
		"infrastructure/compose/postgres-compose.yml",
		"infrastructure/compose/redis-compose.yml",
		"infrastructure/compose/mailpit-compose.yml",
		"infrastructure/scripts/script-clock.sh",
		"infrastructure/scripts/runtime-check-powershell.ps1",
		"apps/k8s/bhvr-site/devenv.k8s.json",
		"apps/k8s/bhvr-site/values.yaml",
		"apps/k8s/bhvr-site/chart/Chart.yaml",
		"apps/k8s/bhvr-site/chart/values.yaml",
		"apps/k8s/bhvr-site/chart/templates/deployment.yaml",
		"apps/k8s/bhvr-site/chart/templates/service.yaml",
		"infrastructure/k8s/postgres/Chart.yaml",
		"infrastructure/k8s/postgres/values.yaml",
		"infrastructure/k8s/postgres/templates/deployment.yaml",
		"infrastructure/k8s/postgres/templates/service.yaml",
		"apps/build/go-rest-postgres-build.Dockerfile",
		"apps/build/go-rest-postgres-test.Dockerfile",
		"apps/build/bhvr-site-build.Dockerfile",
		"apps/build/bhvr-site-test.Dockerfile",
		"apps/build/bhvr-site-build.sh",
		"apps/build/bhvr-site-test.sh",
		"apps/build/bhvr-site-build.ps1",
		"apps/build/bhvr-site-test.ps1",
		"apps/run/bhvr-site-dev.sh",
		"apps/run/bhvr-site-dev.ps1",
		"apps/run/event-worker-dev.sh",
		"apps/run/event-worker-dev.ps1",
		"apps/run/runtime-dependency-check-docker-k8s-powershell.sh",
		"apps/run/runtime-dependency-check-podman-k8s-shell.sh",
		"apps/build/bun-lib-starter-build.Dockerfile",
		"apps/build/bun-lib-starter-test.Dockerfile",
	}
	for _, file := range files {
		if _, err := os.Stat(filepath.Join(configDir, file)); err != nil {
			t.Fatalf("missing %s: %v", file, err)
		}
	}
	for _, executable := range []string{
		filepath.Join(configDir, "apps", "run", "bhvr-site-dev.sh"),
		filepath.Join(configDir, "apps", "run", "event-worker-dev.sh"),
		filepath.Join(configDir, "infrastructure", "scripts", "script-clock.sh"),
		filepath.Join(configDir, "apps", "run", "runtime-dependency-check-docker-k8s-powershell.sh"),
		filepath.Join(configDir, "apps", "run", "runtime-dependency-check-podman-k8s-shell.sh"),
	} {
		info, err := os.Stat(executable)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0111 == 0 {
			t.Fatalf("script is not executable: %s %v", executable, info.Mode())
		}
	}

	bhvrRun, err := os.ReadFile(filepath.Join(configDir, "apps", "run", "bhvr-site-dev.sh"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`{"app":"go-rest-postgres","runtime":"docker","profile":"default"}`, `{"app":"event-worker","runtime":"systemshell","profile":"dev"}`, `{"infra":"redis"}`, `{"infra":"script-clock"}`, `{"infra":"mailpit"}`} {
		if !strings.Contains(string(bhvrRun), want) {
			t.Fatalf("bhvr-site complex deps missing %s:\n%s", want, bhvrRun)
		}
	}
	for file, requires := range map[string][]string{
		"runtime-dependency-check-docker-k8s-powershell.sh": {`"infra":"runtime-check-powershell"`, `"provider":"docker"`, `"infra":"runtime-check-k8s-docker"`, "Docker + Kubernetes + PowerShell dependencies are ready."},
		"runtime-dependency-check-podman-k8s-shell.sh":      {`"infra":"script-clock"`, `"provider":"podman"`, `"infra":"runtime-check-k8s-podman"`, "Podman + Kubernetes + shell dependencies are ready."},
	} {
		content, err := os.ReadFile(filepath.Join(configDir, "apps", "run", file))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range requires {
			if !strings.Contains(string(content), want) {
				t.Fatalf("%s missing %s:\n%s", file, want, content)
			}
		}
	}

	bunBuildDockerfile, err := os.ReadFile(filepath.Join(configDir, "apps", "build", "bhvr-site-build.Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bunBuildDockerfile), `LABEL devenv.artifacts="/src/client/dist"`) {
		t.Fatalf("bhvr-site build Dockerfile has wrong artifact label:\n%s", bunBuildDockerfile)
	}

	eventWorkerCompose, err := os.ReadFile(filepath.Join(configDir, "apps", "compose", "event-worker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(eventWorkerCompose), "x-devenv:") || !strings.Contains(string(eventWorkerCompose), `{"infra":"postgres"}`) || !strings.Contains(string(eventWorkerCompose), `{"infra":"redis"}`) {
		t.Fatalf("event-worker compose deps missing:\n%s", eventWorkerCompose)
	}

	k8sRun, err := os.ReadFile(filepath.Join(configDir, "apps", "k8s", "bhvr-site", "devenv.k8s.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"profile": "k8s-local"`, `"name": "Kubernetes Local (kind)"`, `$CONFIG/apps/k8s/bhvr-site/chart`, `"tag": "latest"`, `"runtime": "kubernetes"`, `"infra": "postgres-k8s"`, `"resource": "svc/bhvr-site"`} {
		if !strings.Contains(string(k8sRun), want) {
			t.Fatalf("bhvr-site Kubernetes run config missing %s:\n%s", want, k8sRun)
		}
	}

	for _, name := range []string{"hello.sh", "hello.ps1", "hello.py", "hello.ts"} {
		path := filepath.Join(homeDir, "scripts", name)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("missing script %s: %v", name, err)
		}
		if info.Mode()&0111 == 0 {
			t.Fatalf("script %s is not executable: %v", name, info.Mode())
		}
		if name == "hello.sh" {
			out, err := exec.Command(path, "--devenv-metadata").Output()
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(out), `"parameters"`) && !strings.Contains(string(out), `"name"`) {
				t.Fatalf("expected metadata output, got %s", out)
			}
		}
	}
}

func TestGenerateAllowsEmptyStartupCreatedDirs(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	for _, dir := range []string{
		filepath.Join(configDir, "providers"),
		filepath.Join(configDir, "apps", "definitions"),
		filepath.Join(configDir, "libraries", "definitions"),
		filepath.Join(configDir, "infrastructure", "definitions"),
		filepath.Join(homeDir, "scripts", "nested"),
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(configDir, "apps", "definitions", "go-rest-postgres.json")); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateIgnoresExistingConfigEnvFile(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	envPath := filepath.Join(configDir, ".env")
	original := "DEVENV_HOME=/custom\nDEVENV_CONTAINER_RUNTIME=podman\n"
	if err := os.WriteFile(envPath, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != original {
		t.Fatalf("env file was overwritten:\n%s", data)
	}
	if _, err := os.Stat(filepath.Join(configDir, "apps", "definitions", "go-rest-postgres.json")); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateRejectsNonEmptyConfigDirWithoutWrites(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "keep"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err == nil {
		t.Fatal("expected error")
	}
	if _, err := os.Stat(filepath.Join(homeDir, "scripts")); !os.IsNotExist(err) {
		t.Fatalf("scripts were written: %v", err)
	}
}

func TestGenerateRejectsNonEmptyScriptsDirWithoutWrites(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	scriptsDir := filepath.Join(homeDir, "scripts")
	if err := os.MkdirAll(scriptsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scriptsDir, "keep"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err == nil {
		t.Fatal("expected error")
	}
	if entries, err := os.ReadDir(configDir); err != nil || len(entries) != 0 {
		t.Fatalf("config was written: entries=%d err=%v", len(entries), err)
	}
}

func TestGenerateIgnoresExistingProviderDirectory(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	providerPath := filepath.Join(configDir, "providers", "github.json")
	if err := os.MkdirAll(filepath.Dir(providerPath), 0755); err != nil {
		t.Fatal(err)
	}
	original := `{"name":"github","type":"github"}` + "\n"
	if err := os.WriteFile(providerPath, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(providerPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != original {
		t.Fatalf("provider file was overwritten:\n%s", data)
	}
	if _, err := os.Stat(filepath.Join(configDir, "apps", "definitions", "go-rest-postgres.json")); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateIgnoresExistingTuiConfig(t *testing.T) {
	configDir := t.TempDir()
	homeDir := t.TempDir()
	tuiPath := filepath.Join(configDir, "tui.json")
	original := `{"theme":"aura"}` + "\n"
	if err := os.WriteFile(tuiPath, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (Generator{ConfigDir: configDir, HomeDir: homeDir}).Generate(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(tuiPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != original {
		t.Fatalf("tui config was overwritten:\n%s", data)
	}
	if _, err := os.Stat(filepath.Join(configDir, "apps", "definitions", "go-rest-postgres.json")); err != nil {
		t.Fatal(err)
	}
}
