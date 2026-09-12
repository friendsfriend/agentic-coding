package resources

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// AppAction identifies a user-invoked app operation.
type AppAction string

const (
	AppActionBuild AppAction = "build"
	AppActionTest  AppAction = "test"
	AppActionRun   AppAction = "run"
)

// ActionRuntime identifies how an action target executes.
type ActionRuntime string

const (
	ActionRuntimeDocker      ActionRuntime = "docker"
	ActionRuntimeShell       ActionRuntime = "shell"
	ActionRuntimePowerShell  ActionRuntime = "powershell"
	ActionRuntimeSystemShell ActionRuntime = "systemshell"
	ActionRuntimeKubernetes  ActionRuntime = "kubernetes"
)

// ContainerProvider identifies a Docker-compatible engine used by a target.
// It is distinct from ActionRuntimeDocker, which identifies a Compose target.
type ContainerProvider string

const (
	ContainerProviderDocker ContainerProvider = "docker"
	ContainerProviderPodman ContainerProvider = "podman"
)

// LaunchMode identifies how a shell action target launches.
type LaunchMode string

const (
	LaunchModeLogged LaunchMode = "logged"
	LaunchModeTmux   LaunchMode = "tmux"
)

// ActionTarget is normalized action target data for clients.
type EndpointExport struct {
	Name      string `json:"name"`
	Protocol  string `json:"protocol"`
	Host      string `json:"host,omitempty"`
	Port      int    `json:"port"`
	Strategy  string `json:"strategy"`
	Resource  string `json:"resource,omitempty"`
	LocalPort int    `json:"localPort,omitempty"`
	Readiness string `json:"readiness,omitempty"`
}

type EndpointBinding struct {
	Name        string `json:"name"`
	Dependency  string `json:"dependency,omitempty"`
	Export      string `json:"export"`
	Destination string `json:"destination"`
	ValuePath   string `json:"valuePath,omitempty"`
}

type ActionTarget struct {
	ID         string                    `json:"id"`
	Action     AppAction                 `json:"action"`
	Runtime    ActionRuntime             `json:"runtime"`
	Label      string                    `json:"label"`
	Profile    string                    `json:"profile,omitempty"`
	Provider   ContainerProvider         `json:"provider,omitempty"`
	Env        map[string]string         `json:"env,omitempty"`
	LaunchMode LaunchMode                `json:"launchMode,omitempty"`
	SourcePath string                    `json:"sourcePath"`
	WorkingDir string                    `json:"workingDir,omitempty"`
	Command    string                    `json:"command,omitempty"`
	Args       []string                  `json:"args,omitempty"`
	Requires   []DependencyRef           `json:"requires,omitempty"`
	Exports    []EndpointExport          `json:"exports,omitempty"`
	Bindings   []EndpointBinding         `json:"bindings,omitempty"`
	Kubernetes *KubernetesTargetMetadata `json:"kubernetes,omitempty"`
}

// KubernetesTargetMetadata contains redacted Kubernetes target explanation data.
type KubernetesTargetMetadata struct {
	Provider    ContainerProvider             `json:"provider,omitempty"`
	ClusterName string                        `json:"clusterName,omitempty"`
	ContextName string                        `json:"contextName,omitempty"`
	ChartPath   string                        `json:"chartPath"`
	Release     string                        `json:"release"`
	Namespace   string                        `json:"namespace"`
	ValuesFiles []string                      `json:"valuesFiles,omitempty"`
	Image       *KubernetesImageConfig        `json:"image,omitempty"`
	Secrets     []KubernetesSecretSummary     `json:"secrets,omitempty"`
	Ports       []KubernetesPortForwardConfig `json:"ports,omitempty"`
	Wait        KubernetesWaitConfig          `json:"wait,omitempty"`
	Exports     []EndpointExport              `json:"exports,omitempty"`
	Bindings    []EndpointBinding             `json:"bindings,omitempty"`
	SourcePath  string                        `json:"sourcePath"`
}

type KubernetesSecretSummary struct {
	Name string   `json:"name"`
	Keys []string `json:"keys"`
}

// DependencyRef identifies app run or infrastructure dependency.
type DependencyRef struct {
	App       string            `json:"app,omitempty"`
	Runtime   string            `json:"runtime,omitempty"`
	Profile   string            `json:"profile,omitempty"`
	Provider  ContainerProvider `json:"provider,omitempty"`
	Lifecycle string            `json:"lifecycle,omitempty"`
	Infra     string            `json:"infra,omitempty"`
}

type shellScriptMetadata struct {
	Name     string
	Mode     LaunchMode
	Requires []DependencyRef
}

// DiscoverActionTargets returns configured action targets for app/action.
func (m *manager) DiscoverActionTargets(appIdent, localDir string, action AppAction) ([]ActionTarget, error) {
	var targets []ActionTarget

	switch action {
	case AppActionBuild, AppActionTest:
		dockerTarget, ok, err := m.discoverDockerBuildTestTarget(appIdent, action)
		if err != nil {
			return nil, err
		}
		if ok {
			targets = append(targets, dockerTarget)
		}
		scriptTargets, err := m.discoverScriptBuildTestTargets(appIdent, action)
		if err != nil {
			return nil, err
		}
		targets = append(targets, scriptTargets...)
		rootTargets, err := m.discoverRootBuildToolTargets(appIdent, localDir, action)
		if err != nil {
			return nil, err
		}
		targets = append(targets, rootTargets...)
		languageTargets, err := m.discoverLanguageBuildToolTargets(appIdent, localDir, action)
		if err != nil {
			return nil, err
		}
		targets = append(targets, languageTargets...)
	case AppActionRun:
		dockerTargets, err := m.discoverDockerRunTargets(appIdent)
		if err != nil {
			return nil, err
		}
		targets = append(targets, dockerTargets...)
		scriptTargets, err := m.discoverScriptRunTargets(appIdent)
		if err != nil {
			return nil, err
		}
		targets = append(targets, scriptTargets...)
		kubernetesTargets, err := m.discoverKubernetesRunTargets(appIdent, localDir)
		if err != nil {
			return nil, err
		}
		targets = append(targets, kubernetesTargets...)
		rootTargets, err := m.discoverRootBuildToolTargets(appIdent, localDir, action)
		if err != nil {
			return nil, err
		}
		targets = append(targets, rootTargets...)
		languageTargets, err := m.discoverLanguageBuildToolTargets(appIdent, localDir, action)
		if err != nil {
			return nil, err
		}
		targets = append(targets, languageTargets...)
	default:
		return nil, fmt.Errorf("unsupported app action %q", action)
	}

	sort.SliceStable(targets, func(i, j int) bool {
		if targets[i].Runtime != targets[j].Runtime {
			return targets[i].Runtime < targets[j].Runtime
		}
		return targets[i].ID < targets[j].ID
	})
	return targets, nil
}

func (m *manager) discoverDockerBuildTestTarget(appIdent string, action AppAction) (ActionTarget, bool, error) {
	path := filepath.Join(m.configDir, "apps", "build", fmt.Sprintf("%s-%s.Dockerfile", appIdent, action))
	if _, err := os.Stat(path); err == nil {
		return ActionTarget{ID: actionTargetID(appIdent, action, ActionRuntimeDocker, ""), Action: action, Runtime: ActionRuntimeDocker, Label: "Docker", SourcePath: path}, true, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return ActionTarget{}, false, err
	}
	return ActionTarget{}, false, nil
}

func (m *manager) discoverScriptBuildTestTargets(appIdent string, action AppAction) ([]ActionTarget, error) {
	var targets []ActionTarget
	for _, candidate := range []struct {
		ext     string
		runtime ActionRuntime
		label   string
		command string
		args    func(string) []string
	}{
		{ext: ".sh", runtime: ActionRuntimeShell, label: "Shell", command: "sh", args: func(path string) []string { return []string{path} }},
		{ext: ".ps1", runtime: ActionRuntimePowerShell, label: "PowerShell", command: powerShellCommand(), args: func(path string) []string { return []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path} }},
	} {
		path := filepath.Join(m.configDir, "apps", "build", fmt.Sprintf("%s-%s%s", appIdent, action, candidate.ext))
		if _, err := os.Stat(path); err == nil {
			meta, err := parseShellScriptMetadata(path, LaunchModeLogged)
			if err != nil {
				return nil, err
			}
			label := meta.Name
			if label == "" {
				label = candidate.label
			}
			targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, action, candidate.runtime, ""), Action: action, Runtime: candidate.runtime, Label: label, LaunchMode: meta.Mode, SourcePath: path, Command: candidate.command, Args: candidate.args(path), Requires: meta.Requires})
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	return targets, nil
}

func (m *manager) discoverRootBuildToolTargets(appIdent, localDir string, action AppAction) ([]ActionTarget, error) {
	if localDir == "" {
		return nil, nil
	}

	var targets []ActionTarget
	for _, candidate := range []struct {
		files   []string
		label   string
		command string
		args    []string
		ok      func(string) (bool, error)
	}{
		{files: []string{"Makefile", "makefile"}, label: "make " + string(action) + " (default for Makefile)", command: "make", args: []string{string(action)}, ok: fileHasMakeTarget(action)},
		{files: []string{"justfile", "Justfile"}, label: "just " + string(action) + " (default for justfile)", command: "just", args: []string{string(action)}, ok: fileHasJustRecipe(action)},
		{files: []string{"Taskfile.yml", "Taskfile.yaml", "Taskfile"}, label: "task " + string(action) + " (default for Taskfile)", command: "task", args: []string{string(action)}, ok: fileHasTask(action)},
	} {
		for _, name := range candidate.files {
			path := filepath.Join(localDir, name)
			if _, err := os.Stat(path); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				return nil, err
			}
			ok, err := candidate.ok(path)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			profile := strings.TrimSuffix(strings.ToLower(name), filepath.Ext(name))
			if strings.HasPrefix(profile, "makefile") {
				profile = "make"
			}
			if strings.HasPrefix(profile, "justfile") {
				profile = "just"
			}
			if strings.HasPrefix(profile, "taskfile") {
				profile = "task"
			}
			mode := LaunchModeLogged
			if action == AppActionRun {
				mode = LaunchModeTmux
			}
			targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, action, ActionRuntimeShell, profile), Action: action, Runtime: ActionRuntimeShell, Label: candidate.label, Profile: profile, LaunchMode: mode, SourcePath: path, Command: candidate.command, Args: candidate.args})
			break
		}
	}
	return targets, nil
}

func (m *manager) discoverLanguageBuildToolTargets(appIdent, localDir string, action AppAction) ([]ActionTarget, error) {
	if localDir == "" {
		return nil, nil
	}
	var targets []ActionTarget
	add := func(profile, label, sourcePath, command string, args ...string) {
		mode := LaunchModeLogged
		if action == AppActionRun {
			mode = LaunchModeTmux
		}
		targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, action, ActionRuntimeShell, profile), Action: action, Runtime: ActionRuntimeShell, Label: label, Profile: profile, LaunchMode: mode, SourcePath: sourcePath, Command: command, Args: args})
	}

	packageJSON := filepath.Join(localDir, "package.json")
	if scripts, ok, err := readPackageScripts(packageJSON); err != nil {
		return nil, err
	} else if ok {
		script := string(action)
		if action == AppActionRun {
			script = "dev"
			if _, ok := scripts[script]; !ok {
				script = "start"
			}
		}
		if _, hasScript := scripts[script]; hasScript {
			pm, args := packageManagerCommand(localDir, script)
			add("package-"+pm, pm+" "+script+" (default for package.json)", packageJSON, pm, args...)
		} else if action == AppActionTest {
			pm, _ := packageManagerCommand(localDir, script)
			if pm == "bun" {
				add("package-bun", "bun test (default for package.json)", packageJSON, "bun", "test")
			}
		}
	}

	if path, ok, err := existingFile(localDir, "go.mod"); err != nil {
		return nil, err
	} else if ok {
		if action == AppActionBuild {
			add("go", "go build (default for go.mod)", path, "go", "build", "./...")
		} else if action == AppActionTest {
			add("go", "go test (default for go.mod)", path, "go", "test", "./...")
		} else {
			add("go", "go run . (default for go.mod)", path, "go", "run", ".")
		}
	}

	if path, ok, err := existingFile(localDir, "Cargo.toml"); err != nil {
		return nil, err
	} else if ok {
		add("cargo", "cargo "+string(action)+" (default for Cargo.toml)", path, "cargo", string(action))
	}

	if path, ok, err := existingFile(localDir, "pom.xml"); err != nil {
		return nil, err
	} else if ok {
		if action == AppActionBuild {
			add("maven", "mvn package (default for pom.xml)", path, "mvn", "package")
		} else if action == AppActionTest {
			add("maven", "mvn test (default for pom.xml)", path, "mvn", "test")
		}
	}

	gradlePath, gradleOK, err := existingAnyFile(localDir, "gradlew", "build.gradle", "build.gradle.kts")
	if err != nil {
		return nil, err
	}
	if gradleOK {
		command := "gradle"
		if filepath.Base(gradlePath) == "gradlew" {
			command = "./gradlew"
		}
		add("gradle", command+" "+string(action)+" (default for Gradle)", gradlePath, command, string(action))
	}

	pyPath, pyOK, err := existingFile(localDir, "pyproject.toml")
	if err != nil {
		return nil, err
	}
	if pyOK && action != AppActionRun {
		if _, uvOK, err := existingFile(localDir, "uv.lock"); err != nil {
			return nil, err
		} else if uvOK {
			if action == AppActionBuild {
				add("uv", "uv build (default for pyproject.toml)", pyPath, "uv", "build")
			} else {
				add("uv", "uv run pytest (default for pyproject.toml)", pyPath, "uv", "run", "pytest")
			}
		} else {
			if action == AppActionBuild {
				add("poetry", "poetry build (default for pyproject.toml)", pyPath, "poetry", "build")
			} else {
				add("poetry", "poetry run pytest (default for pyproject.toml)", pyPath, "poetry", "run", "pytest")
			}
		}
	}

	return targets, nil
}

func readPackageScripts(path string) (map[string]string, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, false, err
	}
	return pkg.Scripts, true, nil
}

func packageManagerCommand(localDir string, script string) (string, []string) {
	if packageManager, ok, _ := readPackageManager(filepath.Join(localDir, "package.json")); ok {
		if strings.HasPrefix(packageManager, "bun@") || packageManager == "bun" {
			return "bun", []string{"run", script}
		}
		if strings.HasPrefix(packageManager, "pnpm@") || packageManager == "pnpm" {
			return "pnpm", []string{"run", script}
		}
		if strings.HasPrefix(packageManager, "yarn@") || packageManager == "yarn" {
			return "yarn", []string{script}
		}
		if strings.HasPrefix(packageManager, "npm@") || packageManager == "npm" {
			return "npm", []string{"run", script}
		}
	}
	if _, ok, _ := existingFile(localDir, "bun.lock"); ok {
		return "bun", []string{"run", script}
	}
	if _, ok, _ := existingFile(localDir, "bun.lockb"); ok {
		return "bun", []string{"run", script}
	}
	if _, ok, _ := existingFile(localDir, "pnpm-lock.yaml"); ok {
		return "pnpm", []string{"run", script}
	}
	if _, ok, _ := existingFile(localDir, "yarn.lock"); ok {
		return "yarn", []string{script}
	}
	return "npm", []string{"run", script}
}

func readPackageManager(path string) (string, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "", false, err
	}
	return pkg.PackageManager, pkg.PackageManager != "", nil
}

func existingFile(dir, name string) (string, bool, error) {
	path := filepath.Join(dir, name)
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return path, false, nil
		}
		return path, false, err
	}
	return path, !info.IsDir(), nil
}

func existingAnyFile(dir string, names ...string) (string, bool, error) {
	for _, name := range names {
		path, ok, err := existingFile(dir, name)
		if err != nil || ok {
			return path, ok, err
		}
	}
	return "", false, nil
}

func fileHasMakeTarget(action AppAction) func(string) (bool, error) {
	return func(path string) (bool, error) { return fileHasLinePrefix(path, string(action)+":") }
}

func fileHasJustRecipe(action AppAction) func(string) (bool, error) {
	return func(path string) (bool, error) { return fileHasLinePrefix(path, string(action)+":") }
}

func fileHasTask(action AppAction) func(string) (bool, error) {
	return func(path string) (bool, error) { return fileHasLinePrefix(path, "  "+string(action)+":") }
}

func fileHasLinePrefix(path, prefix string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, prefix) {
			return true, nil
		}
	}
	return false, scanner.Err()
}

func (m *manager) discoverDockerRunTargets(appIdent string) ([]ActionTarget, error) {
	composeDir := filepath.Join(m.configDir, "apps", "compose")
	entries, err := os.ReadDir(composeDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading compose directory: %w", err)
	}

	var targets []ActionTarget
	defaultNames := map[string]bool{
		appIdent + "-compose.yml":  true,
		appIdent + "-compose.yaml": true,
	}
	prefix := appIdent + "-"
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		path := filepath.Join(composeDir, name)
		if defaultNames[name] {
			requires, err := parseComposeRequires(path)
			if err != nil {
				return nil, err
			}
			targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, AppActionRun, ActionRuntimeDocker, "default"), Action: AppActionRun, Runtime: ActionRuntimeDocker, Label: "default", Profile: "", SourcePath: path, Requires: requires})
			continue
		}
		for _, suffix := range []string{"-compose.yml", "-compose.yaml"} {
			if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, suffix) && len(name) > len(prefix)+len(suffix) {
				profile := name[len(prefix) : len(name)-len(suffix)]
				requires, err := parseComposeRequires(path)
				if err != nil {
					return nil, err
				}
				targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, AppActionRun, ActionRuntimeDocker, profile), Action: AppActionRun, Runtime: ActionRuntimeDocker, Label: profile, Profile: profile, SourcePath: path, Requires: requires})
			}
		}
	}
	return targets, nil
}

func (m *manager) discoverScriptRunTargets(appIdent string) ([]ActionTarget, error) {
	runDir := filepath.Join(m.configDir, "apps", "run")
	entries, err := os.ReadDir(runDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading run directory: %w", err)
	}

	prefix := appIdent + "-"
	var targets []ActionTarget
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		for _, candidate := range []struct {
			ext     string
			runtime ActionRuntime
			command string
			args    func(string) []string
		}{
			{ext: ".sh", runtime: ActionRuntimeShell, command: "sh", args: func(path string) []string { return []string{path} }},
			{ext: ".ps1", runtime: ActionRuntimePowerShell, command: powerShellCommand(), args: func(path string) []string { return []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path} }},
		} {
			if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, candidate.ext) || len(name) <= len(prefix)+len(candidate.ext) {
				continue
			}
			profile := name[len(prefix) : len(name)-len(candidate.ext)]
			path := filepath.Join(runDir, name)
			meta, err := parseShellScriptMetadata(path, LaunchModeTmux)
			if err != nil {
				return nil, err
			}
			label := meta.Name
			if label == "" {
				label = profile
			}
			targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, AppActionRun, candidate.runtime, profile), Action: AppActionRun, Runtime: candidate.runtime, Label: label, Profile: profile, LaunchMode: meta.Mode, SourcePath: path, Command: candidate.command, Args: candidate.args(path), Requires: meta.Requires})
		}
	}
	systemshellTargets, err := m.discoverSystemShellRunTargets(appIdent)
	if err != nil {
		return nil, err
	}
	targets = append(targets, systemshellTargets...)
	return targets, nil
}

func (m *manager) discoverSystemShellRunTargets(appIdent string) ([]ActionTarget, error) {
	runDir := filepath.Join(m.configDir, "apps", "run")
	ext := ".sh"
	command := "sh"
	args := func(path string) []string { return []string{path} }
	labelPrefix := "System Shell"
	if runtime.GOOS == "windows" {
		ext = ".ps1"
		command = powerShellCommand()
		args = func(path string) []string { return []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path} }
		labelPrefix = "System PowerShell"
	}
	entries, err := os.ReadDir(runDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading run directory: %w", err)
	}
	prefix := appIdent + "-"
	var targets []ActionTarget
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ext) || len(name) <= len(prefix)+len(ext) {
			continue
		}
		profile := name[len(prefix) : len(name)-len(ext)]
		path := filepath.Join(runDir, name)
		meta, err := parseShellScriptMetadata(path, LaunchModeTmux)
		if err != nil {
			return nil, err
		}
		label := meta.Name
		if label == "" {
			label = labelPrefix + " " + profile
		}
		targets = append(targets, ActionTarget{ID: actionTargetID(appIdent, AppActionRun, ActionRuntimeSystemShell, profile), Action: AppActionRun, Runtime: ActionRuntimeSystemShell, Label: label, Profile: profile, LaunchMode: meta.Mode, SourcePath: path, Command: command, Args: args(path), Requires: meta.Requires})
	}
	return targets, nil
}

func parseShellScriptMetadata(path string, defaultMode LaunchMode) (shellScriptMetadata, error) {
	file, err := os.Open(path)
	if err != nil {
		return shellScriptMetadata{}, err
	}
	defer file.Close()

	meta := shellScriptMetadata{Mode: defaultMode}
	scanner := bufio.NewScanner(file)
	lines := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		lines++
		if lines > 20 {
			break
		}
		if line == "" || strings.HasPrefix(line, "#!") {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			break
		}
		comment := strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if strings.HasPrefix(comment, "devenv:name=") {
			meta.Name = strings.TrimSpace(strings.TrimPrefix(comment, "devenv:name="))
		}
		if strings.HasPrefix(comment, "devenv:mode=") {
			meta.Mode = LaunchMode(strings.TrimSpace(strings.TrimPrefix(comment, "devenv:mode=")))
		}
		if strings.HasPrefix(comment, "devenv:requires=") {
			requires, err := parseDependencyRefs(strings.TrimSpace(strings.TrimPrefix(comment, "devenv:requires=")))
			if err != nil {
				return shellScriptMetadata{}, fmt.Errorf("parse %s devenv:requires: %w", path, err)
			}
			meta.Requires = requires
		}
	}
	if err := scanner.Err(); err != nil {
		return shellScriptMetadata{}, err
	}
	return meta, nil
}

func parseDependencyRefs(raw string) ([]DependencyRef, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var refs []DependencyRef
	if err := json.Unmarshal([]byte(raw), &refs); err != nil {
		return nil, err
	}
	for i, ref := range refs {
		if ref.App == "" && ref.Infra == "" {
			return nil, fmt.Errorf("dependency %d requires app or infra", i)
		}
		if ref.App != "" && ref.Infra != "" {
			return nil, fmt.Errorf("dependency %d cannot contain both app and infra", i)
		}
		if ref.App != "" {
			if ref.Runtime == "" {
				return nil, fmt.Errorf("dependency %d app %q requires runtime", i, ref.App)
			}
			if ref.Profile == "" {
				return nil, fmt.Errorf("dependency %d app %q requires profile", i, ref.App)
			}
		}
	}
	return refs, nil
}

func parseComposeRequires(path string) ([]DependencyRef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "x-devenv:") {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			child := strings.TrimSpace(lines[j])
			if child == "" || strings.HasPrefix(child, "#") {
				continue
			}
			if !strings.HasPrefix(lines[j], " ") && !strings.HasPrefix(lines[j], "\t") {
				break
			}
			if strings.HasPrefix(child, "requires:") {
				raw := strings.TrimSpace(strings.TrimPrefix(child, "requires:"))
				if raw == "" {
					return nil, fmt.Errorf("%s x-devenv.requires must be inline JSON array", path)
				}
				refs, err := parseDependencyRefs(raw)
				if err != nil {
					return nil, fmt.Errorf("parse %s x-devenv.requires: %w", path, err)
				}
				return refs, nil
			}
		}
	}
	return nil, nil
}

func powerShellCommand() string {
	if _, err := exec.LookPath("pwsh"); err == nil {
		return "pwsh"
	}
	return "powershell"
}

func actionTargetID(appIdent string, action AppAction, runtime ActionRuntime, profile string) string {
	if appIdent == "" {
		if profile == "" {
			return fmt.Sprintf("%s:%s", action, runtime)
		}
		return fmt.Sprintf("%s:%s:%s", action, runtime, profile)
	}
	if profile == "" {
		return fmt.Sprintf("app/%s/%s/%s", appIdent, action, runtime)
	}
	return fmt.Sprintf("app/%s/%s/%s/%s", appIdent, action, runtime, profile)
}
