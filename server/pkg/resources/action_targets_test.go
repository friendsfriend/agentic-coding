package resources

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverActionTargets(t *testing.T) {
	t.Parallel()

	writeFile := func(t *testing.T, path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0755); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("discovers docker and shell build targets", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "build", "my-app-build.Dockerfile"), "FROM alpine")
		writeFile(t, filepath.Join(configDir, "apps", "build", "my-app-build.sh"), "#!/bin/sh\n# devenv:name=Local Build\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", "", AppActionBuild)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		if len(targets) != 2 {
			t.Fatalf("got %d targets, want 2: %#v", len(targets), targets)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		if seen["app/my-app/build/docker"].SourcePath == "" {
			t.Fatalf("missing docker build target: %#v", targets)
		}
		if seen["app/my-app/build/shell"].Label != "Local Build" || seen["app/my-app/build/shell"].LaunchMode != LaunchModeLogged {
			t.Fatalf("bad shell build target: %#v", seen["app/my-app/build/shell"])
		}
	})

	t.Run("discovers powershell build and run targets", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "build", "my-app-build.ps1"), "# devenv:name=Windows Build\n")
		writeFile(t, filepath.Join(configDir, "apps", "run", "my-app-dev.ps1"), "# devenv:name=Windows Dev\n")

		buildTargets, err := NewManager(configDir).DiscoverActionTargets("my-app", "", AppActionBuild)
		if err != nil {
			t.Fatalf("DiscoverActionTargets build error = %v", err)
		}
		if len(buildTargets) != 1 || buildTargets[0].ID != "app/my-app/build/powershell" || buildTargets[0].Label != "Windows Build" || buildTargets[0].Command == "" {
			t.Fatalf("buildTargets = %#v, want powershell build", buildTargets)
		}

		runTargets, err := NewManager(configDir).DiscoverActionTargets("my-app", "", AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets run error = %v", err)
		}
		if len(runTargets) != 1 || runTargets[0].ID != "app/my-app/run/powershell/dev" || runTargets[0].Label != "Windows Dev" || runTargets[0].LaunchMode != LaunchModeTmux {
			t.Fatalf("runTargets = %#v, want powershell run", runTargets)
		}
	})

	t.Run("discovers root build tool targets", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		localDir := t.TempDir()
		writeFile(t, filepath.Join(localDir, "Makefile"), "build:\n\techo make\n")
		writeFile(t, filepath.Join(localDir, "justfile"), "build:\n\techo just\n")
		writeFile(t, filepath.Join(localDir, "Taskfile.yml"), "version: '3'\ntasks:\n  build:\n    cmds:\n      - echo task\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", localDir, AppActionBuild)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		for _, id := range []string{"app/my-app/build/shell/make", "app/my-app/build/shell/just", "app/my-app/build/shell/task"} {
			if seen[id].Command == "" || len(seen[id].Args) != 1 || seen[id].Args[0] != "build" {
				t.Fatalf("missing root tool target %s: %#v", id, targets)
			}
		}
	})

	t.Run("discovers language build tool defaults", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		localDir := t.TempDir()
		writeFile(t, filepath.Join(localDir, "package.json"), `{"packageManager":"bun@1.3.14","scripts":{"build":"vite build","test":"vitest"}}`)
		writeFile(t, filepath.Join(localDir, "go.mod"), "module example.com/app\n")
		writeFile(t, filepath.Join(localDir, "Cargo.toml"), "[package]\nname = \"app\"\n")
		writeFile(t, filepath.Join(localDir, "pom.xml"), "<project></project>")
		writeFile(t, filepath.Join(localDir, "gradlew"), "#!/bin/sh\n")
		writeFile(t, filepath.Join(localDir, "pyproject.toml"), "[project]\nname = \"app\"\n")
		writeFile(t, filepath.Join(localDir, "uv.lock"), "")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", localDir, AppActionBuild)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		checks := map[string]string{
			"app/my-app/build/shell/package-bun": "bun build (default for package.json)",
			"app/my-app/build/shell/go":          "go build (default for go.mod)",
			"app/my-app/build/shell/cargo":       "cargo build (default for Cargo.toml)",
			"app/my-app/build/shell/maven":       "mvn package (default for pom.xml)",
			"app/my-app/build/shell/gradle":      "./gradlew build (default for Gradle)",
			"app/my-app/build/shell/uv":          "uv build (default for pyproject.toml)",
		}
		for id, label := range checks {
			if seen[id].Label != label {
				t.Fatalf("target %s label = %q, want %q; targets=%#v", id, seen[id].Label, label, targets)
			}
		}
	})

	t.Run("discovers bun lockb package target", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		localDir := t.TempDir()
		writeFile(t, filepath.Join(localDir, "package.json"), `{"scripts":{"test":"vitest"}}`)
		writeFile(t, filepath.Join(localDir, "bun.lockb"), "")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", localDir, AppActionTest)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		if len(targets) != 1 || targets[0].ID != "app/my-app/test/shell/package-bun" || targets[0].Command != "bun" || targets[0].Args[1] != "test" {
			t.Fatalf("targets = %#v, want bun test target", targets)
		}
	})

	t.Run("discovers bun test default without package script", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		localDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "build", "my-app-test.sh"), "#!/bin/sh\n")
		writeFile(t, filepath.Join(localDir, "package.json"), `{"packageManager":"bun@1.3.14","scripts":{"build":"bun run build.ts"}}`)

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", localDir, AppActionTest)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		if seen["app/my-app/test/shell"].SourcePath == "" || seen["app/my-app/test/shell/package-bun"].Label != "bun test (default for package.json)" {
			t.Fatalf("targets = %#v, want shell script and bun default", targets)
		}
	})

	t.Run("discovers default dev run targets", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		localDir := t.TempDir()
		writeFile(t, filepath.Join(localDir, "package.json"), `{"scripts":{"dev":"vite --host"}}`)
		writeFile(t, filepath.Join(localDir, "bun.lock"), "")
		writeFile(t, filepath.Join(localDir, "Makefile"), "run:\n\techo run\n")
		writeFile(t, filepath.Join(localDir, "go.mod"), "module example.com/app\n")
		writeFile(t, filepath.Join(localDir, "Cargo.toml"), "[package]\nname = \"app\"\n")
		writeFile(t, filepath.Join(localDir, "gradlew"), "#!/bin/sh\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", localDir, AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		checks := map[string]string{
			"app/my-app/run/shell/make":        "make run (default for Makefile)",
			"app/my-app/run/shell/package-bun": "bun dev (default for package.json)",
			"app/my-app/run/shell/go":          "go run . (default for go.mod)",
			"app/my-app/run/shell/cargo":       "cargo run (default for Cargo.toml)",
			"app/my-app/run/shell/gradle":      "./gradlew run (default for Gradle)",
		}
		for id, label := range checks {
			if seen[id].Label != label || seen[id].LaunchMode != LaunchModeTmux {
				t.Fatalf("target %s = %#v, want label %q tmux", id, seen[id], label)
			}
		}
	})

	t.Run("discovers docker run default profile and shell profile", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "compose", "my-app-compose.yml"), "services: {}")
		writeFile(t, filepath.Join(configDir, "apps", "compose", "my-app-redis-compose.yml"), "services: {}")
		writeFile(t, filepath.Join(configDir, "apps", "run", "my-app-dev.sh"), "#!/bin/sh\n# devenv:name=Dev TUI\n")
		writeFile(t, filepath.Join(configDir, "apps", "run", "other-app-dev.sh"), "#!/bin/sh\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", "", AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		if len(seen) != 4 {
			t.Fatalf("got targets %#v, want 4 distinct targets", targets)
		}
		if seen["app/my-app/run/docker/default"].Label != "default" {
			t.Fatalf("missing default docker run target: %#v", targets)
		}
		if seen["app/my-app/run/docker/redis"].Profile != "redis" {
			t.Fatalf("missing redis docker run target: %#v", targets)
		}
		if seen["app/my-app/run/shell/dev"].Label != "Dev TUI" || seen["app/my-app/run/shell/dev"].LaunchMode != LaunchModeTmux {
			t.Fatalf("bad shell run target: %#v", seen["app/my-app/run/shell/dev"])
		}
	})

	t.Run("distinguishes duplicate runtime profile ids", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "compose", "my-app-dev-compose.yml"), "services: {}")
		writeFile(t, filepath.Join(configDir, "apps", "run", "my-app-dev.sh"), "#!/bin/sh\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", "", AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]bool{}
		for _, target := range targets {
			seen[target.ID] = true
		}
		if !seen["app/my-app/run/docker/dev"] || !seen["app/my-app/run/shell/dev"] || !seen["app/my-app/run/systemshell/dev"] {
			t.Fatalf("expected distinct docker/shell dev ids, got %#v", targets)
		}
	})

	t.Run("returns no targets when absent", func(t *testing.T) {
		t.Parallel()
		targets, err := NewManager(t.TempDir()).DiscoverActionTargets("my-app", "", AppActionTest)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		if len(targets) != 0 {
			t.Fatalf("got %#v, want no targets", targets)
		}
	})
}

func TestDependencyMetadataParsing(t *testing.T) {
	t.Parallel()

	writeFile := func(t *testing.T, path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0755); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("parses shell powershell and compose requires", func(t *testing.T) {
		t.Parallel()
		configDir := t.TempDir()
		writeFile(t, filepath.Join(configDir, "apps", "run", "frontend-dev.sh"), `#!/bin/sh
# devenv:requires=[{"app":"backend","runtime":"systemshell","profile":"dev"},{"infra":"postgres"}]
`)
		writeFile(t, filepath.Join(configDir, "apps", "run", "frontend-win.ps1"), `# devenv:requires=[{"infra":"redis"}]
`)
		writeFile(t, filepath.Join(configDir, "apps", "compose", "frontend-docker-compose.yml"), `x-devenv:
  requires: [{"app":"backend","runtime":"docker","profile":"dev"}]
services:
  frontend:
    depends_on:
      - ignored
`)

		targets, err := NewManager(configDir).DiscoverActionTargets("frontend", "", AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		if got := seen["app/frontend/run/shell/dev"].Requires; len(got) != 2 || got[0].App != "backend" || got[1].Infra != "postgres" {
			t.Fatalf("shell requires = %#v", got)
		}
		if got := seen["app/frontend/run/powershell/win"].Requires; len(got) != 1 || got[0].Infra != "redis" {
			t.Fatalf("powershell requires = %#v", got)
		}
		if got := seen["app/frontend/run/docker/docker"].Requires; len(got) != 1 || got[0].Runtime != "docker" {
			t.Fatalf("compose requires = %#v", got)
		}
	})

	t.Run("validates malformed and missing app fields", func(t *testing.T) {
		t.Parallel()
		for _, raw := range []string{
			`[{"app":"backend","profile":"dev"}]`,
			`[{"app":"backend","runtime":"systemshell"}]`,
			`not-json`,
		} {
			if _, err := parseDependencyRefs(raw); err == nil {
				t.Fatalf("parseDependencyRefs(%q) expected error", raw)
			}
		}
	})
}

func TestDiscoverKubernetesActionTargets(t *testing.T) {
	writeFile := func(t *testing.T, path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0755); err != nil {
			t.Fatal(err)
		}
	}
	index := func(targets []ActionTarget) map[string]ActionTarget {
		seen := map[string]ActionTarget{}
		for _, target := range targets {
			seen[target.ID] = target
		}
		return seen
	}

	t.Run("single chart discovery", func(t *testing.T) {
		configDir := t.TempDir()
		appDir := t.TempDir()
		writeFile(t, filepath.Join(appDir, "Chart.yaml"), "apiVersion: v2\nname: my-app\nversion: 0.1.0\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", appDir, AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := index(targets)
		target := seen["app/my-app/run/kubernetes/local"]
		if target.Runtime != ActionRuntimeKubernetes || target.Kubernetes == nil {
			t.Fatalf("missing kubernetes target: %#v", targets)
		}
		if target.Kubernetes.ChartPath != appDir || target.Kubernetes.Release != "my-app" {
			t.Fatalf("metadata = %#v", target.Kubernetes)
		}
	})

	t.Run("multiple charts stable ids", func(t *testing.T) {
		configDir := t.TempDir()
		appDir := t.TempDir()
		writeFile(t, filepath.Join(appDir, "charts", "api", "Chart.yaml"), "apiVersion: v2\nname: api\nversion: 0.1.0\n")
		writeFile(t, filepath.Join(appDir, "charts", "worker", "Chart.yaml"), "apiVersion: v2\nname: worker\nversion: 0.1.0\n")

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", appDir, AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		seen := index(targets)
		if seen["app/my-app/run/kubernetes/api"].Profile != "api" || seen["app/my-app/run/kubernetes/worker"].Profile != "worker" {
			t.Fatalf("missing stable chart ids: %#v", targets)
		}
	})

	t.Run("config overrides and redacts secret values", func(t *testing.T) {
		configDir := t.TempDir()
		appDir := t.TempDir()
		writeFile(t, filepath.Join(appDir, "helm", "Chart.yaml"), "apiVersion: v2\nname: repo\nversion: 0.1.0\n")
		writeFile(t, filepath.Join(configDir, "apps", "k8s", "my-app", "values.yaml"), "image: local\n")
		writeFile(t, filepath.Join(configDir, "apps", "k8s", "my-app", KubernetesConfigFileName), `{"targets":[{"profile":"dev","chart":{"path":"$APP/helm","values":["$CONFIG/apps/k8s/my-app/values.yaml"]},"release":"custom","namespace":"apps","secrets":[{"name":"env","keys":["DB_PASS"]}],"requires":[{"infra":"postgres","runtime":"kubernetes","profile":"local"}]}]}`)

		targets, err := NewManager(configDir).DiscoverActionTargets("my-app", appDir, AppActionRun)
		if err != nil {
			t.Fatalf("DiscoverActionTargets error = %v", err)
		}
		target := index(targets)["app/my-app/run/kubernetes/dev"]
		if target.Kubernetes == nil || target.Kubernetes.Release != "custom" || target.Kubernetes.Namespace != "apps" {
			t.Fatalf("metadata = %#v", target.Kubernetes)
		}
		if target.Kubernetes.ChartPath != filepath.Join(appDir, "helm") || target.Kubernetes.ValuesFiles[0] != filepath.Join(configDir, "apps", "k8s", "my-app", "values.yaml") {
			t.Fatalf("paths = %#v", target.Kubernetes)
		}
		if len(target.Kubernetes.Secrets) != 1 || target.Kubernetes.Secrets[0].Keys[0] != "DB_PASS" {
			t.Fatalf("secret metadata leaked or missing: %#v", target.Kubernetes.Secrets)
		}
		if len(target.Requires) != 1 || target.Requires[0].Infra != "postgres" || target.Requires[0].Runtime != "kubernetes" {
			t.Fatalf("requires = %#v", target.Requires)
		}
	})
}
