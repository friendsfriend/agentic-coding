package build

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	osExec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/runstatus"
	"github.com/friendsfriend/devenv/pkg/state"
	"github.com/friendsfriend/devenv/pkg/status"
)

type actionContextExecutor interface {
	ConfigureActionForApp(app string, output func(string, string, string), command func(string, string, []string), done func(string, error))
	SetActionStepForApp(app, stepID string)
	ClearActionForApp(app string)
	CancelActionForApp(app string)
}

type dependencyLease struct {
	id   string
	done chan struct{}
	err  error
}

type actionBinding struct {
	output  func(string, string, string)
	command func(string, string, []string)
	done    func(string, error)
	step    string
}

type actionCommandRunner interface {
	RunCommandWithActionLoggingToFile(ctx context.Context, appIdent, command string, args []string, envVars []string, workingDir, logPath string, output func(stream, chunk string)) (error, string)
}

type actionSilentRunner interface {
	RunCommandSilentForAction(appIdent, command string, args []string, envVars []string, workingDir string) (error, string)
	RunCommandSilentForActionDisplay(appIdent, command string, args, displayArgs []string, envVars []string, workingDir string) (error, string)
}

type commandRunner interface {
	RunCommandWithLogging(appIdent, command string, args []string, envVars []string, workingDir string) (error, string)
	RunCommandWithLoggingToFile(appIdent, command string, args []string, envVars []string, workingDir string, logPath string) (error, string)
	RunCommandSilent(command string, args []string, envVars []string, workingDir string) (error, string)
}

type appRegistry interface {
	GetApps() []app.App
	GetInfraServices() []app.InfraService
	GetAppByIdent(ident string) (app.App, bool)
}

type runTargetStateStore interface {
	GetAppRunTargetInfo(ident string) (state.AppRunTargetInfo, bool, error)
	SetAppRunTargetInfo(ident string, info state.AppRunTargetInfo) error
	ClearAppRunTargetInfo(ident string) error
}

type HealthWaiter interface {
	WaitForHealthy(ctx context.Context, containerName string, timeout time.Duration) error
}
type healthUpdateWaiter interface {
	WaitForHealthyWithUpdates(ctx context.Context, containerName string, timeout time.Duration, update docker.HealthUpdate) error
}
type dependencyLogReader interface {
	GetAllContainerIDsForApp(a docker.App) []string
	GetContainerLogs(containerID string) (string, error)
}

type infraStarter interface {
	StartInfrastructureServiceWithStatus(infra app.InfraService)
	StartScriptInfrastructureServiceWithStatus(infra app.InfraService, runner string) error
	StartKubernetesInfrastructureServiceWithStatus(infra app.InfraService) error
	StartKubernetesInfrastructureServiceWithLog(infra app.InfraService, logPath string) error
}

type resourceManager interface {
	ExistsDir(string) (bool, error)
	ResolveDockerfileForAction(appIdent, localDir string, action resources.ActionType) (string, error)
	ResolveComposeFile(appIdent, localDir string, profile string) (string, error)
	ResolveInfrastructureComposeFile(infraIdent string) (string, error)
	DiscoverProfiles(appIdent, localDir string) ([]string, error)
	DiscoverActionTargets(appIdent, localDir string, action resources.AppAction) ([]resources.ActionTarget, error)
	EnvFilePath() (string, bool)
	ComposeMissingEnvVars(appIdent, localDir string, profile string) []string
	CopyTemplatesDir(destDir string) ([]string, error)
	CopyFile(src, dst string) error
}

// Service provides build, test, and run operations for applications.
type Service interface {
	BuildAppWithStatus(a *app.App)
	BuildAppTargetWithStatus(a *app.App, targetID string)
	TestAppWithStatus(a *app.App)
	TestAppTargetWithStatus(a *app.App, targetID string)
	RunAppWithStatus(a *app.App, profile string)
	RunAppTargetWithStatus(a *app.App, targetID string)
	StopAppWithStatus(a *app.App, targetID string)
	StopShellTmuxRun(appIdent string) error
	RestartShellTmuxRun(a *app.App) error
	IsShellTmuxRunActive(appIdent string) bool
	RecoverShellTmuxRuns(apps []app.App)
	LastRunRuntime(appIdent string) string
	RunTargetInfo(appIdent string) (*RunTargetInfo, bool)
	SetRunTargetInfo(appIdent string, target resources.ActionTarget)
	ClearRunTargetInfo(appIdent string)
	KubernetesRunStatus(appIdent string) string
	KubernetesRunLogs(appIdent, localDir string) (string, error)
	DiscoverKubernetesRunStatus(appIdent, localDir string) string
	ClearKubernetesRuntimeState()
	SetLastRunRuntime(appIdent string, runtime resources.ActionRuntime)
	SetOnComplete(callback func(appIdent string))
	ConfigureRunDependencies(apps appRegistry, infra infraStarter)
	ConfigureStateStore(store runTargetStateStore)
	ConfigureDockerHealth(waiter HealthWaiter, timeout time.Duration)
	ConfigureActionOutput(appIdent, runID, stepID string, output func(stepID, stream, chunk string))
	ConfigureActionCommand(appIdent string, command func(stepID, command string, args []string))
	ConfigureActionCommandDone(appIdent string, done func(stepID string, err error))
	ConfigureActionStepEvent(appIdent string, event func(stepID, kind, status, message string))
	SetActionStep(stepID string)
	ClearActionOutput()
	ComposeMissingEnvVars(appIdent, localDir, profile string) []string
	ResolveRunActionSteps(a *app.App, targetID, profile string) ([]actionrun.Step, error)
	CancelAction(appIdent string)
}

type service struct {
	resourceMgr       resourceManager
	executor          commandRunner
	statusMgr         status.Manager
	OnComplete        func(appIdent string)
	homeDir           string
	tmuxMu            sync.Mutex
	tmuxRuns          map[string]ShellTmuxRunState
	portForwardMu     sync.Mutex
	portForwards      map[string][]*osExec.Cmd
	activeLogMu       sync.RWMutex
	activeLogMap      map[string]string
	lastRunMu         sync.RWMutex
	lastRunRuntime    map[string]resources.ActionRuntime
	runTargetInfo     map[string]RunTargetInfo
	lastKubernetes    map[string]*resources.KubernetesTargetMetadata
	stateStore        runTargetStateStore
	appRegistry       appRegistry
	infraStarter      infraStarter
	healthWaiter      HealthWaiter
	readinessTimeout  time.Duration
	dependencyMu      sync.Mutex
	dependencyLeases  map[string]*dependencyLease
	actionMu          sync.RWMutex
	actionRunID       string
	actionStepID      string
	actionOutput      func(stepID, stream, chunk string)
	actionCommand     func(stepID, command string, args []string)
	actionCommandDone func(stepID string, err error)
	actionStepEvent   func(stepID, kind, status, message string)
	actionAppIdent    string
	actionBindings    map[string]actionBinding
}

func NewService(resourceMgr resourceManager, exec commandRunner, statusMgr status.Manager, homeDir string) Service {
	return &service{
		resourceMgr:      resourceMgr,
		executor:         exec,
		statusMgr:        statusMgr,
		homeDir:          homeDir,
		tmuxRuns:         make(map[string]ShellTmuxRunState),
		activeLogMap:     make(map[string]string),
		lastRunRuntime:   make(map[string]resources.ActionRuntime),
		runTargetInfo:    make(map[string]RunTargetInfo),
		lastKubernetes:   make(map[string]*resources.KubernetesTargetMetadata),
		portForwards:     make(map[string][]*osExec.Cmd),
		actionBindings:   make(map[string]actionBinding),
		dependencyLeases: make(map[string]*dependencyLease),
		readinessTimeout: 60 * time.Second,
	}
}

// ShellTmuxRunState tracks active shell run launched in tmux.
type ShellTmuxRunState struct {
	AppIdent  string
	TargetID  string
	Profile   string
	WindowID  string
	PID       int
	StartedAt time.Time
}

// RunTargetInfo tracks app run target metadata exposed through status APIs.
type RunTargetInfo struct {
	Runtime    string    `json:"runtime"`
	LaunchMode string    `json:"launchMode,omitempty"`
	Label      string    `json:"label,omitempty"`
	Profile    string    `json:"profile,omitempty"`
	TargetID   string    `json:"targetId,omitempty"`
	SourcePath string    `json:"sourcePath,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	Display    string    `json:"display"`
}

func (s *service) CancelAction(appIdent string) {
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.CancelActionForApp(appIdent)
	}
}

func (s *service) ConfigureActionOutput(appIdent, runID, stepID string, output func(stepID, stream, chunk string)) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	s.actionRunID, s.actionStepID, s.actionOutput, s.actionAppIdent = runID, stepID, output, appIdent
	binding := s.actionBindings[appIdent]
	binding.output, binding.step = output, stepID
	s.actionBindings[appIdent] = binding
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.SetActionStepForApp(appIdent, stepID)
		executor.ConfigureActionForApp(appIdent, output, binding.command, binding.done)
	}
}

func (s *service) ConfigureActionCommand(appIdent string, command func(string, string, []string)) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	binding := s.actionBindings[appIdent]
	binding.command = command
	s.actionBindings[appIdent] = binding
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.ConfigureActionForApp(appIdent, binding.output, command, binding.done)
	}
}

func (s *service) ConfigureActionCommandDone(appIdent string, done func(string, error)) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	binding := s.actionBindings[appIdent]
	binding.done = done
	s.actionBindings[appIdent] = binding
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.ConfigureActionForApp(appIdent, binding.output, binding.command, done)
	}
}

func (s *service) ConfigureActionStepEvent(appIdent string, event func(string, string, string, string)) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	s.actionStepEvent = event
	s.actionAppIdent = appIdent
}

func (s *service) emitActionStep(stepID, kind, status, message string) {
	s.actionMu.RLock()
	event := s.actionStepEvent
	s.actionMu.RUnlock()
	if event != nil {
		event(stepID, kind, status, message)
	}
}

func (s *service) bindActionApp(appIdent, stepID string) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	if s.actionBindings == nil {
		s.actionBindings = make(map[string]actionBinding)
	}
	root := s.actionBindings[s.actionAppIdent]
	root.step = stepID
	s.actionBindings[appIdent] = root
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.SetActionStepForApp(appIdent, stepID)
		executor.ConfigureActionForApp(appIdent, root.output, root.command, root.done)
	}
}

func (s *service) SetActionStep(stepID string) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	s.actionStepID = stepID
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.SetActionStepForApp(s.actionAppIdent, stepID)
	}
}

func (s *service) ClearActionOutput() {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	appIdent := s.actionAppIdent
	s.actionRunID, s.actionStepID, s.actionOutput, s.actionCommand, s.actionCommandDone, s.actionStepEvent, s.actionAppIdent = "", "", nil, nil, nil, nil, ""
	delete(s.actionBindings, appIdent)
	if executor, ok := s.executor.(actionContextExecutor); ok {
		executor.ClearActionForApp(appIdent)
	}
}

func (s *service) ConfigureDockerHealth(waiter HealthWaiter, timeout time.Duration) {
	s.healthWaiter = waiter
	if timeout > 0 {
		s.readinessTimeout = timeout
	}
}

func (s *service) SetOnComplete(callback func(appIdent string)) {
	s.OnComplete = callback
}

// ComposeMissingEnvVars returns env variable names referenced in the app's
// compose file that are not defined in the .env file.
func (s *service) ComposeMissingEnvVars(appIdent, localDir, profile string) []string {
	return s.resourceMgr.ComposeMissingEnvVars(appIdent, localDir, profile)
}

func (s *service) LastRunRuntime(appIdent string) string {
	s.lastRunMu.RLock()
	defer s.lastRunMu.RUnlock()
	return string(s.lastRunRuntime[appIdent])
}

func (s *service) SetLastRunRuntime(appIdent string, runtime resources.ActionRuntime) {
	s.lastRunMu.Lock()
	defer s.lastRunMu.Unlock()
	if s.lastRunRuntime == nil {
		s.lastRunRuntime = make(map[string]resources.ActionRuntime)
	}
	s.lastRunRuntime[appIdent] = runtime
}

func (s *service) RunTargetInfo(appIdent string) (*RunTargetInfo, bool) {
	s.lastRunMu.RLock()
	info, ok := s.runTargetInfo[appIdent]
	s.lastRunMu.RUnlock()
	if ok {
		return &info, true
	}
	if s.stateStore == nil {
		return nil, false
	}
	stored, ok, err := s.stateStore.GetAppRunTargetInfo(appIdent)
	if err != nil || !ok {
		return nil, false
	}
	info = runTargetInfoFromState(stored)
	s.lastRunMu.Lock()
	if s.runTargetInfo == nil {
		s.runTargetInfo = make(map[string]RunTargetInfo)
	}
	s.runTargetInfo[appIdent] = info
	s.lastRunMu.Unlock()
	return &info, true
}

func (s *service) SetRunTargetInfo(appIdent string, target resources.ActionTarget) {
	runtime := string(target.Runtime)
	if target.Runtime == resources.ActionRuntimeDocker && target.Provider != "" {
		runtime = string(target.Provider)
	}
	info := RunTargetInfo{
		Runtime:    runtime,
		LaunchMode: string(target.LaunchMode),
		Label:      target.Label,
		Profile:    target.Profile,
		TargetID:   target.ID,
		SourcePath: target.SourcePath,
		StartedAt:  time.Now().UTC(),
		Display:    FormatRunTargetDisplay(target),
	}
	s.lastRunMu.Lock()
	if s.runTargetInfo == nil {
		s.runTargetInfo = make(map[string]RunTargetInfo)
	}
	s.runTargetInfo[appIdent] = info
	s.lastRunMu.Unlock()
	if s.stateStore != nil {
		_ = s.stateStore.SetAppRunTargetInfo(appIdent, runTargetInfoToState(info))
	}
}

func (s *service) ClearRunTargetInfo(appIdent string) {
	s.lastRunMu.Lock()
	delete(s.runTargetInfo, appIdent)
	s.lastRunMu.Unlock()
	if s.stateStore != nil {
		_ = s.stateStore.ClearAppRunTargetInfo(appIdent)
	}
}

func runTargetInfoToState(info RunTargetInfo) state.AppRunTargetInfo {
	return state.AppRunTargetInfo{
		Runtime:    info.Runtime,
		LaunchMode: info.LaunchMode,
		Label:      info.Label,
		Profile:    info.Profile,
		TargetID:   info.TargetID,
		SourcePath: info.SourcePath,
		StartedAt:  info.StartedAt.UTC().Format(time.RFC3339),
		Display:    info.Display,
	}
}

func runTargetInfoFromState(info state.AppRunTargetInfo) RunTargetInfo {
	startedAt, _ := time.Parse(time.RFC3339, info.StartedAt)
	return RunTargetInfo{
		Runtime:    info.Runtime,
		LaunchMode: info.LaunchMode,
		Label:      info.Label,
		Profile:    info.Profile,
		TargetID:   info.TargetID,
		SourcePath: info.SourcePath,
		StartedAt:  startedAt,
		Display:    info.Display,
	}
}

func FormatRunTargetDisplay(target resources.ActionTarget) string {
	badge := string(target.Runtime)
	if target.Runtime == resources.ActionRuntimeDocker && target.Provider != "" {
		badge = string(target.Provider)
	}
	if target.Runtime == resources.ActionRuntimeShell && target.LaunchMode == resources.LaunchModeTmux {
		badge = "tmux"
	}
	label := strings.TrimSpace(target.Label)
	if label == "" {
		label = strings.TrimSpace(target.Profile)
	}
	if label == "" {
		label = string(target.Runtime)
	}
	display := fmt.Sprintf("[%s] %s", badge, label)
	profile := strings.TrimSpace(target.Profile)
	if profile == "" && target.Runtime == resources.ActionRuntimeDocker && strings.EqualFold(label, "default") {
		profile = "default"
	}
	if profile != "" {
		display += " (" + profile + ")"
	}
	return display
}

func (s *service) setLastKubernetesTarget(appIdent string, target *resources.KubernetesTargetMetadata) {
	s.lastRunMu.Lock()
	defer s.lastRunMu.Unlock()
	if s.lastKubernetes == nil {
		s.lastKubernetes = make(map[string]*resources.KubernetesTargetMetadata)
	}
	s.lastKubernetes[appIdent] = target
}

func (s *service) KubernetesRunStatus(appIdent string) string {
	s.lastRunMu.RLock()
	target := s.lastKubernetes[appIdent]
	s.lastRunMu.RUnlock()
	if target == nil {
		return "stopped"
	}
	return s.kubernetesTargetStatus(target)
}

func (s *service) DiscoverKubernetesRunStatus(appIdent, localDir string) string {
	targets, err := s.resourceMgr.DiscoverActionTargets(appIdent, localDir, resources.AppActionRun)
	if err != nil {
		return "stopped"
	}
	candidates := []runstatus.Candidate{}
	metadata := map[string]*resources.KubernetesTargetMetadata{}
	for _, target := range targets {
		if target.Runtime != resources.ActionRuntimeKubernetes || target.Kubernetes == nil {
			continue
		}
		status := s.kubernetesTargetStatus(target.Kubernetes)
		candidates = append(candidates, runstatus.Candidate{Source: target.ID, Status: status})
		metadata[target.ID] = target.Kubernetes
	}
	if len(candidates) == 0 {
		return "stopped (0 pods)"
	}
	selected := runstatus.Select(candidates)
	for _, candidate := range candidates {
		if candidate.Status == selected {
			s.setLastKubernetesTarget(appIdent, metadata[candidate.Source])
			break
		}
	}
	return selected
}

func (s *service) kubernetesTargetStatus(target *resources.KubernetesTargetMetadata) string {
	contextName := target.ContextName
	if contextName == "" {
		contextName = "kind-devenv"
	}
	cmd := "kubectl"
	args := []string{"--context", contextName, "get", "pods", "--namespace", target.Namespace, "-l", "app.kubernetes.io/instance=" + target.Release, "--no-headers"}
	err, output := s.executor.RunCommandSilent(cmd, args, []string{}, "")
	output = strings.TrimSpace(output)
	if err != nil || output == "" || strings.HasPrefix(strings.ToLower(output), "no resources found") {
		return "stopped (0 pods)"
	}
	lines := strings.Split(output, "\n")
	total, running, failed := 0, 0, 0
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		total++
		phase := strings.ToLower(fields[2])
		if phase == "running" || phase == "succeeded" {
			running++
		}
		if phase == "failed" || phase == "error" || strings.Contains(phase, "crash") {
			failed++
		}
	}
	if total == 0 {
		return "stopped (0 pods)"
	}
	if failed > 0 {
		return fmt.Sprintf("failed (%d/%d pods)", running, total)
	}
	if running == total {
		return fmt.Sprintf("running (%d/%d pods)", running, total)
	}
	return fmt.Sprintf("starting (%d/%d pods)", running, total)
}

func (s *service) ConfigureRunDependencies(apps appRegistry, infra infraStarter) {
	s.appRegistry = apps
	s.infraStarter = infra
}

func (s *service) ConfigureStateStore(store runTargetStateStore) {
	s.stateStore = store
}

func (s *service) BuildAppWithStatus(a *app.App) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpBuild)
	s.buildAppInternal(a, "", callback)
}

func (s *service) BuildAppTargetWithStatus(a *app.App, targetID string) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpBuild)
	s.buildAppInternal(a, targetID, callback)
}

func (s *service) cleanupContainerArtifacts(appIdent string) {
	// Docker has a distinct BuildKit cache; Podman's builder prune aliases
	// image prune. Never use --all so current tagged application images survive.
	s.runActionSilent(appIdent, "docker", []string{"builder", "prune", "--force"}, []string{}, "")
	for _, cmd := range []string{"docker", "podman"} {
		s.runActionSilent(appIdent, cmd, []string{"image", "prune", "--force"}, []string{}, "")
		s.runActionSilent(appIdent, cmd, []string{"volume", "prune", "--force"}, []string{}, "")
	}
}

func (s *service) removeImage(appIdent, imageName string) {
	// Remove image from both Docker and Podman
	s.runActionSilent(appIdent, "docker", []string{"rmi", "-f", imageName}, []string{}, "")
	s.runActionSilent(appIdent, "podman", []string{"rmi", "-f", imageName}, []string{}, "")
}

func (s *service) TestAppWithStatus(a *app.App) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpTest)
	s.testAppInternal(a, "", callback)
}

func (s *service) TestAppTargetWithStatus(a *app.App, targetID string) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpTest)
	s.testAppInternal(a, targetID, callback)
}

func (s *service) RunAppWithStatus(a *app.App, profile string) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpRun)
	s.runAppInternal(a, profile, "", callback)
}

func (s *service) RunAppTargetWithStatus(a *app.App, targetID string) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpRun)
	s.runAppInternal(a, "", targetID, callback)
}

func (s *service) buildAppInternal(a *app.App, targetID string, statusCb func(string)) {
	folderExists, _ := s.resourceMgr.ExistsDir(a.LocalDirectoryPath)
	if !folderExists {
		statusCb("Error: Checkout needed")
		return
	}

	target, ok, err := s.selectActionTarget(a, resources.AppActionBuild, targetID, "")
	if err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	if !ok {
		statusCb("Error: no build target configured")
		return
	}
	if target.Runtime != resources.ActionRuntimeDocker {
		s.runShellLogged(a, target, "build", statusCb)
		return
	}

	statusCb("resolving dockerfile...")

	dockerFilePath := target.SourcePath

	copied, err := s.resourceMgr.CopyTemplatesDir(a.LocalDirectoryPath)
	if err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	defer func() {
		for _, p := range copied {
			_ = os.Remove(p)
		}
	}()

	imageName := fmt.Sprintf("devenv-%s:latest", a.Ident)

	// Copy Dockerfile into build context so Docker Desktop can access it
	// (Docker does not allow -f paths outside the build context on some drivers)
	localDockerfilePath := filepath.Join(a.LocalDirectoryPath, ".devenv-build.Dockerfile")
	if err := s.resourceMgr.CopyFile(dockerFilePath, localDockerfilePath); err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	defer os.Remove(localDockerfilePath)

	logPath := ""

	statusCb("building image...")
	buildArgs, buildEnv := s.dockerBuildCommandArgs(imageName, localDockerfilePath, a.LocalDirectoryPath)
	if buildErr, _ := s.runActionCommand(a.Ident, docker.RuntimeCommand(), buildArgs, buildEnv, a.LocalDirectoryPath, logPath); buildErr != nil {
		statusCb("Error: " + buildErr.Error())
		return
	}

	statusCb("extracting artifacts...")
	artifactsPath, err := s.readArtifactsLabel(a.Ident, imageName, logPath)
	if err != nil {
		statusCb("Error: " + err.Error())
		return
	}

	if artifactsPath != "" {
		if err := s.extractArtifacts(a.Ident, a.LocalDirectoryPath, imageName, artifactsPath, logPath); err != nil {
			statusCb("Error: artifact extraction failed: " + err.Error())
			return
		}
	}

	statusCb("build successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}

	// Step 1: Prune build cache and old images after every build
	go s.cleanupContainerArtifacts(a.Ident)
}

func (s *service) dockerBuildCommandArgs(imageName, dockerfilePath, workingDir string) ([]string, []string) {
	args := []string{"build", "--rm"}
	envVars := []string{}

	switch docker.RuntimeName() {
	case "docker":
		envVars = append(envVars, "DOCKER_BUILDKIT=1")
		args = append(args, "--progress=plain", "--cache-from", imageName, "--build-arg", "BUILDKIT_INLINE_CACHE=1")
	case "podman":
		if s.containerBuildSupportsFlag("--layers", workingDir) {
			args = append(args, "--layers")
		}
		if s.containerBuildSupportsFlag("--cache-from", workingDir) {
			args = append(args, "--cache-from", podmanCacheRepository(imageName))
		}
	}

	args = append(args, "-f", dockerfilePath, "-t", imageName, ".")
	return args, envVars
}

func (s *service) containerBuildSupportsFlag(flag, workingDir string) bool {
	err, output := s.executor.RunCommandSilent(docker.RuntimeCommand(), []string{"build", "--help"}, []string{}, workingDir)
	if err != nil {
		return false
	}
	return strings.Contains(output, flag)
}

func podmanCacheRepository(imageName string) string {
	if at := strings.Index(imageName, "@"); at >= 0 {
		return imageName[:at]
	}
	lastSlash := strings.LastIndex(imageName, "/")
	lastColon := strings.LastIndex(imageName, ":")
	if lastColon > lastSlash {
		return imageName[:lastColon]
	}
	return imageName
}

func (s *service) selectActionTarget(a *app.App, action resources.AppAction, targetID, profile string) (resources.ActionTarget, bool, error) {
	targets, err := s.resourceMgr.DiscoverActionTargets(a.Ident, a.LocalDirectoryPath, action)
	if err != nil {
		return resources.ActionTarget{}, false, err
	}
	if len(targets) == 0 {
		return resources.ActionTarget{}, false, nil
	}
	if targetID != "" {
		for _, target := range targets {
			if target.ID == targetID {
				return target, true, nil
			}
		}
		return resources.ActionTarget{}, false, nil
	}
	if action == resources.AppActionRun {
		for _, target := range targets {
			if target.Runtime == resources.ActionRuntimeDocker && target.Profile == profile {
				return target, true, nil
			}
			if target.Runtime == resources.ActionRuntimeDocker && profile == "default" && target.Profile == "" && strings.EqualFold(target.Label, "default") {
				return target, true, nil
			}
		}
		if profile != "" {
			return resources.ActionTarget{ID: fmt.Sprintf("app/%s/%s/%s/%s", a.Ident, resources.AppActionRun, resources.ActionRuntimeDocker, profile), Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Label: profile, Profile: profile}, true, nil
		}
		return resources.ActionTarget{}, false, nil
	}
	if len(targets) == 1 {
		return targets[0], true, nil
	}
	for _, target := range targets {
		if target.Runtime == resources.ActionRuntimeDocker {
			return target, true, nil
		}
	}
	return targets[0], true, nil
}

func parseTmuxWindowAndPID(output string) (string, int) {
	windowID, _, pid := parseTmuxWindowLine(output)
	return windowID, pid
}

func parseTmuxWindowLine(output string) (string, string, int) {
	parts := strings.Split(strings.TrimSpace(output), ":")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		return "", "", 0
	}
	if len(parts) == 2 {
		pid := 0
		_, _ = fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &pid)
		return strings.TrimSpace(parts[0]), "", pid
	}
	pid := 0
	if len(parts) > 2 {
		_, _ = fmt.Sscanf(strings.TrimSpace(parts[len(parts)-1]), "%d", &pid)
	}
	windowName := ""
	if len(parts) > 2 {
		windowName = strings.TrimSpace(strings.Join(parts[1:len(parts)-1], ":"))
	}
	return strings.TrimSpace(parts[0]), windowName, pid
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func (s *service) runShellTmux(a *app.App, target resources.ActionTarget, statusCb func(string)) {
	if target.LaunchMode != resources.LaunchModeTmux {
		statusCb("Error: unsupported shell run launch mode " + string(target.LaunchMode))
		return
	}
	command, args := scriptCommandForTarget(target)
	if err := ensureCommandAvailable(command, a.LocalDirectoryPath); err != nil {
		statusCb("Error: required tool not found: " + command)
		return
	}
	if strings.TrimSpace(os.Getenv("TMUX")) == "" {
		statusCb("tmux unavailable; running logged")
		s.runShellLogged(a, target, "run", statusCb)
		return
	}

	windowName := fmt.Sprintf("devenv - %s - %s", a.Ident, target.Profile)
	statusCb("opening tmux window...")
	tmuxArgs := []string{"new-window", "-P", "-F", "#{window_id}:#{pane_pid}", "-n", windowName, "-c", a.LocalDirectoryPath, command}
	tmuxArgs = append(tmuxArgs, args...)
	if err, output := s.runTmuxActionCommand(a.Ident, tmuxArgs, a.LocalDirectoryPath); err != nil {
		statusCb("Error: tmux launch failed: " + err.Error())
		return
	} else {
		windowID, panePID := parseTmuxWindowAndPID(output)
		if windowID == "" {
			statusCb("Error: tmux launch did not return a window id")
			return
		}
		s.tmuxMu.Lock()
		if s.tmuxRuns == nil {
			s.tmuxRuns = make(map[string]ShellTmuxRunState)
		}
		s.tmuxRuns[a.Ident] = ShellTmuxRunState{AppIdent: a.Ident, TargetID: target.ID, Profile: target.Profile, WindowID: windowID, PID: panePID, StartedAt: time.Now()}
		s.tmuxMu.Unlock()
	}
	s.SetLastRunRuntime(a.Ident, resources.ActionRuntimeShell)
	statusCb("run successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}
}

func (s *service) runTmuxActionCommand(appIdent string, args []string, workingDir string) (error, string) {
	s.actionMu.RLock()
	binding := s.actionBindings[appIdent]
	s.actionMu.RUnlock()
	if binding.command != nil {
		binding.command(binding.step, "tmux", args)
	}
	err, output := s.executor.RunCommandSilent("tmux", args, []string{}, workingDir)
	if binding.output != nil && output != "" {
		binding.output(binding.step, "stdout", output)
	}
	if binding.done != nil {
		binding.done(binding.step, err)
	}
	return err, output
}

func (s *service) StopShellTmuxRun(appIdent string) error {
	s.tmuxMu.Lock()
	state, ok := s.tmuxRuns[appIdent]
	if ok {
		delete(s.tmuxRuns, appIdent)
	}
	s.tmuxMu.Unlock()
	if !ok {
		return fmt.Errorf("no active shell tmux run for %s", appIdent)
	}
	if err, _ := s.runTmuxActionCommand(appIdent, []string{"kill-window", "-t", state.WindowID}, ""); err != nil {
		return err
	}
	s.ClearRunTargetInfo(appIdent)
	return nil
}

func (s *service) IsShellTmuxRunActive(appIdent string) bool {
	s.tmuxMu.Lock()
	state, ok := s.tmuxRuns[appIdent]
	s.tmuxMu.Unlock()
	if !ok {
		return false
	}
	if err, output := s.executor.RunCommandSilent("tmux", []string{"display-message", "-p", "-t", state.WindowID, "#{window_id}:#{pane_pid}"}, []string{}, ""); err != nil {
		s.tmuxMu.Lock()
		delete(s.tmuxRuns, appIdent)
		s.tmuxMu.Unlock()
		s.ClearRunTargetInfo(appIdent)
		return false
	} else if _, panePID := parseTmuxWindowAndPID(output); panePID > 0 {
		state.PID = panePID
		s.tmuxMu.Lock()
		s.tmuxRuns[appIdent] = state
		s.tmuxMu.Unlock()
	}
	if state.PID > 0 && !processAlive(state.PID) {
		s.tmuxMu.Lock()
		delete(s.tmuxRuns, appIdent)
		s.tmuxMu.Unlock()
		s.ClearRunTargetInfo(appIdent)
		return false
	}
	return true
}

func (s *service) RecoverShellTmuxRuns(apps []app.App) {
	if strings.TrimSpace(os.Getenv("TMUX")) == "" {
		return
	}
	err, output := s.executor.RunCommandSilent("tmux", []string{"list-windows", "-a", "-F", "#{window_id}:#{window_name}:#{pane_pid}"}, []string{}, "")
	if err != nil {
		return
	}
	known := make(map[string]app.App, len(apps))
	for _, a := range apps {
		known[a.Ident] = a
	}
	for _, line := range strings.Split(output, "\n") {
		windowID, windowName, panePID := parseTmuxWindowLine(line)
		if windowID == "" || !strings.HasPrefix(windowName, "devenv - ") || strings.HasPrefix(windowName, "devenv - infra - ") {
			continue
		}
		parts := strings.Split(windowName, " - ")
		if len(parts) < 3 {
			continue
		}
		ident, profile := strings.TrimSpace(parts[1]), strings.TrimSpace(parts[2])
		if _, ok := known[ident]; !ok {
			continue
		}
		if panePID > 0 && !processAlive(panePID) {
			continue
		}
		s.tmuxMu.Lock()
		if s.tmuxRuns == nil {
			s.tmuxRuns = make(map[string]ShellTmuxRunState)
		}
		if _, exists := s.tmuxRuns[ident]; !exists {
			s.tmuxRuns[ident] = ShellTmuxRunState{AppIdent: ident, Profile: profile, WindowID: windowID, PID: panePID, StartedAt: time.Now()}
		}
		s.tmuxMu.Unlock()
	}
}

func (s *service) RestartShellTmuxRun(a *app.App) error {
	s.tmuxMu.Lock()
	state, ok := s.tmuxRuns[a.Ident]
	s.tmuxMu.Unlock()
	if !ok {
		return fmt.Errorf("no active shell tmux run for %s", a.Ident)
	}
	_ = s.StopShellTmuxRun(a.Ident)
	s.RunAppTargetWithStatus(a, state.TargetID)
	return nil
}

func (s *service) runShellLogged(a *app.App, target resources.ActionTarget, operation string, statusCb func(string)) {
	statusCb("running shell " + operation + " script...")
	logPath := ""
	command, args := scriptCommandForTarget(target)
	if err := ensureCommandAvailable(command, a.LocalDirectoryPath); err != nil {
		statusCb("Error: required tool not found: " + command)
		return
	}
	if runErr, _ := s.runActionCommand(a.Ident, command, args, []string{}, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: " + runErr.Error())
		return
	}
	if operation == "run" {
		s.SetLastRunRuntime(a.Ident, target.Runtime)
	}
	statusCb(operation + " successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}
}

func scriptCommandForTarget(target resources.ActionTarget) (string, []string) {
	if target.Command != "" {
		return target.Command, target.Args
	}
	if target.Runtime == resources.ActionRuntimePowerShell {
		command := "powershell"
		if _, err := osExec.LookPath("pwsh"); err == nil {
			command = "pwsh"
		}
		return command, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target.SourcePath}
	}
	return "sh", []string{target.SourcePath}
}

func ensureCommandAvailable(command, workingDir string) error {
	if strings.ContainsAny(command, `/\\`) {
		path := command
		if !filepath.IsAbs(path) {
			path = filepath.Join(workingDir, path)
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.IsDir() || info.Mode()&0111 == 0 {
			return fmt.Errorf("not executable")
		}
		return nil
	}
	_, err := osExec.LookPath(command)
	return err
}

func (s *service) runActionCommand(appIdent, command string, args []string, envVars []string, workingDir, logPath string) (error, string) {
	if runner, ok := s.executor.(actionCommandRunner); ok {
		s.actionMu.RLock()
		binding := s.actionBindings[appIdent]
		output, commandCallback, doneCallback, stepID := binding.output, binding.command, binding.done, binding.step
		if output == nil {
			output, commandCallback, doneCallback, stepID = s.actionOutput, s.actionCommand, s.actionCommandDone, s.actionStepID
		}
		s.actionMu.RUnlock()
		if commandCallback != nil {
			commandCallback(stepID, command, args)
		}
		if output != nil {
			err, result := runner.RunCommandWithActionLoggingToFile(context.Background(), appIdent, command, args, envVars, workingDir, logPath, func(stream, chunk string) { output(stepID, stream, chunk) })
			if doneCallback != nil {
				doneCallback(stepID, err)
			}
			return err, result
		}
	}
	return s.executor.RunCommandWithLoggingToFile(appIdent, command, args, envVars, workingDir, logPath)
}

func (s *service) readArtifactsLabel(appIdent, imageName string, logPath string) (string, error) {
	args := []string{"inspect", "--format", "{{json .Config.Labels}}", imageName}
	inspectErr, output := s.runActionSilent(appIdent, docker.RuntimeCommand(), args, []string{}, "")
	s.logSilentCommand(logPath, docker.RuntimeCommand(), args, []string{}, "", output, inspectErr)
	if inspectErr != nil {
		return "", fmt.Errorf("failed to inspect image %s: %w", imageName, inspectErr)
	}

	var labels map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &labels); err != nil {
		return "", fmt.Errorf("failed to parse image labels: %w", err)
	}

	return labels["devenv.artifacts"], nil
}

func (s *service) extractArtifacts(appIdent, localDir, imageName, artifactsPath string, logPath string) error {
	containerName := fmt.Sprintf("%s-extract", appIdent)

	createArgs := []string{"create", "--name", containerName, imageName}
	createErr, createOut := s.runActionSilent(appIdent, docker.RuntimeCommand(), createArgs, []string{}, "")
	s.logSilentCommand(logPath, docker.RuntimeCommand(), createArgs, []string{}, "", createOut, createErr)
	if createErr != nil {
		return fmt.Errorf("failed to create extraction container: %w", createErr)
	}

	defer func() {
		rmArgs := []string{"rm", containerName}
		rmErr, rmOut := s.runActionSilent(appIdent, docker.RuntimeCommand(), rmArgs, []string{}, "")
		s.logSilentCommand(logPath, docker.RuntimeCommand(), rmArgs, []string{}, "", rmOut, rmErr)
	}()

	destPath := filepath.Join(localDir, artifactsPath)
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	containerSrc := fmt.Sprintf("%s:%s", containerName, artifactsPath)
	cpArgs := []string{"cp", containerSrc, destPath}
	cpErr, cpOut := s.runActionSilent(appIdent, docker.RuntimeCommand(), cpArgs, []string{}, "")
	s.logSilentCommand(logPath, docker.RuntimeCommand(), cpArgs, []string{}, "", cpOut, cpErr)
	if cpErr != nil {
		return fmt.Errorf("failed to copy artifacts: %w", cpErr)
	}

	return nil
}

func (s *service) testAppInternal(a *app.App, targetID string, statusCb func(string)) {
	folderExists, _ := s.resourceMgr.ExistsDir(a.LocalDirectoryPath)
	if !folderExists {
		statusCb("Error: Checkout needed")
		return
	}

	target, ok, err := s.selectActionTarget(a, resources.AppActionTest, targetID, "")
	if err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	if !ok {
		statusCb("Error: no test target configured")
		return
	}
	if target.Runtime != resources.ActionRuntimeDocker {
		s.runShellLogged(a, target, "test", statusCb)
		return
	}

	statusCb("resolving test dockerfile...")

	dockerFilePath := target.SourcePath

	testImageName := fmt.Sprintf("devenv-%s-test:latest", a.Ident)

	localDockerfilePath := filepath.Join(a.LocalDirectoryPath, ".devenv-test.Dockerfile")
	if err := s.resourceMgr.CopyFile(dockerFilePath, localDockerfilePath); err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	defer os.Remove(localDockerfilePath)

	logPath := ""

	statusCb("building test image...")
	buildArgs, buildEnv := s.dockerBuildCommandArgs(testImageName, localDockerfilePath, a.LocalDirectoryPath)
	if buildErr, _ := s.runActionCommand(a.Ident, docker.RuntimeCommand(), buildArgs, buildEnv, a.LocalDirectoryPath, logPath); buildErr != nil {
		statusCb("Error: " + buildErr.Error())
		return
	}

	statusCb("running tests...")
	if runErr, _ := s.runActionCommand(a.Ident, docker.RuntimeCommand(), []string{"run", "--rm", testImageName}, []string{}, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: tests failed")
		return
	}

	statusCb("tests passed")

	// Step 1+3: Remove test image and prune build cache after test
	go s.removeImage(a.Ident, testImageName)
	go s.cleanupContainerArtifacts(a.Ident)
}

func (s *service) runAppInternal(a *app.App, profile string, targetID string, statusCb func(string)) {
	logPath := ""
	folderExists, _ := s.resourceMgr.ExistsDir(a.LocalDirectoryPath)
	if !folderExists {
		statusCb("Error: Checkout needed")
		return
	}

	target, ok, err := s.selectActionTarget(a, resources.AppActionRun, targetID, profile)
	if err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	if !ok {
		statusCb("Error: no run target configured")
		return
	}
	if s.appRegistry != nil && s.infraStarter != nil {
		if err := s.startRunDependencies(target, logPath, statusCb); err != nil {
			statusCb("Error: " + err.Error())
			return
		}
	}
	s.SetRunTargetInfo(a.Ident, target)
	s.SetActionStep(target.ID)
	s.emitActionStep(target.ID, "", "started", "")
	s.startRunTarget(a, target, logPath, statusCb)
	if err := s.waitForRunTarget(a, target); err != nil {
		s.emitActionStep(target.ID, "", "failed", err.Error())
		return
	}
	s.appendDependencyLogs(a)
	s.emitActionStep(target.ID, "", "completed", "")
}

func (s *service) startRunTarget(a *app.App, target resources.ActionTarget, logPath string, statusCb func(string)) {
	if target.Runtime == resources.ActionRuntimeKubernetes {
		s.runKubernetesTarget(a, target, logPath, statusCb)
		return
	}
	if target.Runtime != resources.ActionRuntimeDocker {
		s.runShellTmux(a, target, statusCb)
		return
	}

	statusCb("resolving compose file...")

	composeFilePath := target.SourcePath

	composeArgs := []string{"-p", "devenv", "-f", composeFilePath}

	if envFilePath, ok := s.resourceMgr.EnvFilePath(); ok {
		composeArgs = append(composeArgs, "--env-file", envFilePath)
	}

	// Check for missing env vars and report before starting.
	if missing := s.resourceMgr.ComposeMissingEnvVars(a.Ident, a.LocalDirectoryPath, target.Profile); len(missing) > 0 {
		statusCb(fmt.Sprintf("Missing env vars: %s", strings.Join(missing, ", ")))
	}

	composeArgs = append(composeArgs, "up", "-d")

	statusCb("starting containers...")
	if runErr, _ := s.runActionCommand(a.Ident, docker.ComposeCommand(), composeArgs, []string{}, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: " + runErr.Error())
		return
	}

	s.SetLastRunRuntime(a.Ident, resources.ActionRuntimeDocker)
	statusCb("run successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}
}

func (s *service) ResolveRunActionSteps(a *app.App, targetID, profile string) ([]actionrun.Step, error) {
	target, ok, err := s.selectActionTarget(a, resources.AppActionRun, targetID, profile)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []actionrun.Step{{ID: "app:" + a.Ident, Label: "Start application: " + a.DisplayName, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}}, nil
	}
	registry, err := s.buildTargetRegistry()
	if err != nil {
		return nil, err
	}
	plan, err := registry.ResolveStartPlan(target.ID)
	if err != nil {
		return nil, err
	}
	planned := make(map[string]bool, len(plan))
	for _, item := range plan {
		planned[item.ID] = true
	}
	steps := make([]actionrun.Step, 0, len(plan))
	visited := make(map[string]bool, len(plan))
	var visit func(string, string, int) error
	visit = func(id, parent string, depth int) error {
		// A dependency may be reachable both directly and through another
		// dependency. It executes once per action, so render one matching step
		// instead of duplicate tree nodes with only one command history.
		if visited[id] {
			return nil
		}
		visited[id] = true
		item, ok := registry.Target(id)
		if !ok {
			return nil
		}
		deps, err := registry.Dependencies(id)
		if err != nil {
			return err
		}
		for _, dep := range deps {
			if planned[dep.ID] {
				if err := visit(dep.ID, id, depth+1); err != nil {
					return err
				}
			}
		}
		name, label := item.App, "Start dependency: "
		if item.Kind == resources.TargetKindInfra {
			name = item.Infra
		}
		if item.ID == target.ID {
			name, label = a.DisplayName, "Start application: "
		}
		steps = append(steps, actionrun.Step{ID: item.ID, ParentID: parent, Depth: depth, Label: label + name, Status: actionrun.StatusPending, Commands: []actionrun.Command{}})
		return nil
	}
	if err := visit(target.ID, "", 0); err != nil {
		return nil, err
	}
	return steps, nil
}

func (s *service) acquireDependency(id string) (*dependencyLease, bool) {
	s.dependencyMu.Lock()
	if s.dependencyLeases == nil {
		s.dependencyLeases = make(map[string]*dependencyLease)
	}
	if lease, ok := s.dependencyLeases[id]; ok {
		s.dependencyMu.Unlock()
		<-lease.done
		return lease, false
	}
	lease := &dependencyLease{id: id, done: make(chan struct{})}
	s.dependencyLeases[id] = lease
	s.dependencyMu.Unlock()
	return lease, true
}
func (s *service) finishDependency(lease *dependencyLease, err error) {
	s.dependencyMu.Lock()
	lease.err = err
	if current := s.dependencyLeases[lease.id]; current == lease {
		delete(s.dependencyLeases, lease.id)
	}
	close(lease.done)
	s.dependencyMu.Unlock()
}

func (s *service) startRunDependencies(target resources.ActionTarget, logPath string, statusCb func(string)) error {
	registry, err := s.buildTargetRegistry()
	if err != nil {
		return err
	}
	plan, err := registry.ResolveStartPlan(target.ID)
	if err != nil {
		return err
	}
	for _, item := range plan {
		if item.ID == target.ID {
			continue
		}
		lease, owner := s.acquireDependency(item.ID)
		if !owner {
			if lease.err != nil {
				return lease.err
			}
			continue
		}
		dependencyIdent := item.App
		if item.Kind == resources.TargetKindInfra {
			dependencyIdent = item.Infra
		}
		s.bindActionApp(dependencyIdent, item.ID)
		s.SetActionStep(item.ID)
		s.emitActionStep(item.ID, "", "started", "")
		statusCb("starting dependency " + item.ID + "...")
		if item.Kind == resources.TargetKindInfra {
			infra, ok := s.findInfra(item.Infra)
			if !ok {
				err := fmt.Errorf("unknown infrastructure service %q", item.Infra)
				s.finishDependency(lease, err)
				return err
			}
			if infra.Type == app.InfraServiceTypeScript {
				if err := s.infraStarter.StartScriptInfrastructureServiceWithStatus(infra, ""); err != nil {
					s.finishDependency(lease, err)
					return err
				}
			} else if infra.Type == app.InfraServiceTypeKubernetes {
				if err := s.infraStarter.StartKubernetesInfrastructureServiceWithLog(infra, logPath); err != nil {
					s.finishDependency(lease, err)
					return err
				}
			} else {
				s.infraStarter.StartInfrastructureServiceWithStatus(infra)
			}
			// Script infrastructure is process/tmux-backed, not container-backed.
			// Its launch result is the readiness signal; probing a fabricated
			// container name marks a successfully started script as failed.
			if infra.Type != app.InfraServiceTypeScript {
				if err := s.waitForDependency(infra.GetContainerBaseName()); err != nil {
					s.emitActionStep(item.ID, "", "failed", err.Error())
					err := fmt.Errorf("dependency %q failed readiness: %w", item.ID, err)
					s.finishDependency(lease, err)
					return err
				}
				s.appendDependencyLogs(infra)
			}
			s.emitActionStep(item.ID, "", "completed", "")
			s.finishDependency(lease, nil)
			continue
		}
		depApp, ok := s.appRegistry.GetAppByIdent(item.App)
		if !ok {
			err := fmt.Errorf("unknown app %q", item.App)
			s.finishDependency(lease, err)
			return err
		}
		depTarget, ok, err := s.selectActionTarget(&depApp, resources.AppActionRun, item.ID, item.Profile)
		if err != nil {
			s.finishDependency(lease, err)
			return err
		}
		if !ok {
			err := fmt.Errorf("unknown app run target %q", item.ID)
			s.finishDependency(lease, err)
			return err
		}
		s.bindActionApp(depApp.Ident, item.ID)
		s.startRunTarget(&depApp, depTarget, logPath, statusCb)
		if err := s.waitForRunTarget(&depApp, depTarget); err != nil {
			s.emitActionStep(item.ID, "", "failed", err.Error())
			wrapped := fmt.Errorf("dependency %q failed readiness: %w", item.ID, err)
			s.finishDependency(lease, wrapped)
			return wrapped
		}
		s.appendDependencyLogs(&depApp)
		s.emitActionStep(item.ID, "", "completed", "")
		s.finishDependency(lease, nil)
	}
	return nil
}

func (s *service) emitActionDiagnostic(stream, message string) {
	s.actionMu.RLock()
	output, stepID := s.actionOutput, s.actionStepID
	s.actionMu.RUnlock()
	if output != nil {
		output(stepID, stream, fmt.Sprintf("[%s] %s\n", time.Now().Format("15:04:05"), message))
	}
}

func (s *service) emitActionOutput(stream, chunk string) {
	s.actionMu.RLock()
	output, stepID := s.actionOutput, s.actionStepID
	s.actionMu.RUnlock()
	if output != nil && chunk != "" {
		output(stepID, stream, chunk)
	}
}

func (s *service) waitForRunTarget(a *app.App, target resources.ActionTarget) error {
	if target.Runtime != resources.ActionRuntimeDocker {
		return nil
	}
	if reader, ok := s.healthWaiter.(dependencyLogReader); ok {
		containerIDs := reader.GetAllContainerIDsForApp(a)
		if len(containerIDs) > 0 {
			for _, containerID := range containerIDs {
				if err := s.waitForDependency(containerID); err != nil {
					return err
				}
			}
			return nil
		}
	}
	return s.waitForDependency(a.GetContainerBaseName())
}

func (s *service) waitForDependency(containerName string) error {
	if s.healthWaiter == nil || strings.TrimSpace(containerName) == "" {
		return nil
	}
	if waiter, ok := s.healthWaiter.(healthUpdateWaiter); ok {
		return waiter.WaitForHealthyWithUpdates(context.Background(), containerName, s.readinessTimeout, func(status string) { s.emitActionDiagnostic("stdout", "readiness "+containerName+": "+status) })
	}
	return s.healthWaiter.WaitForHealthy(context.Background(), containerName, s.readinessTimeout)
}

func (s *service) appendDependencyLogs(subject docker.App) {
	reader, ok := s.healthWaiter.(dependencyLogReader)
	if !ok {
		return
	}
	for _, containerID := range reader.GetAllContainerIDsForApp(subject) {
		logs, err := reader.GetContainerLogs(containerID)
		if err != nil {
			s.emitActionDiagnostic("stderr", "container logs unavailable: "+err.Error())
			continue
		}
		if strings.TrimSpace(logs) != "" {
			s.emitActionDiagnostic("stdout", "container logs ("+containerID+"):\n"+logs)
		}
	}
}

func (s *service) buildTargetRegistry() (resources.TargetRegistry, error) {
	var items []resources.RegistryTarget
	for _, a := range s.appRegistry.GetApps() {
		targets, err := s.resourceMgr.DiscoverActionTargets(a.Ident, a.LocalDirectoryPath, resources.AppActionRun)
		if err != nil {
			return resources.TargetRegistry{}, err
		}
		for _, target := range targets {
			provider := target.Provider
			if provider == "" && (target.Runtime == resources.ActionRuntimeDocker || target.Runtime == resources.ActionRuntimeKubernetes) {
				provider = resources.ContainerProviderDocker
			}
			items = append(items, resources.RegistryTarget{ID: target.ID, Kind: resources.TargetKindAppRun, App: a.Ident, Runtime: target.Runtime, Profile: target.Profile, Provider: provider, Requires: target.Requires, Running: s.isRunTargetActive(a.Ident, target.ID)})
		}
	}
	for _, infra := range s.appRegistry.GetInfraServices() {
		id := resources.InfraTargetID(infra.Ident)
		runtime := resources.ActionRuntimeDocker
		provider := resources.ContainerProviderDocker
		profile := "default"
		if infra.Type == app.InfraServiceTypeKubernetes && infra.Kubernetes != nil {
			runtime = resources.ActionRuntimeKubernetes
			provider = resources.ContainerProviderDocker
			profile = infra.Kubernetes.Profile
			id = resources.InfraRuntimeTargetID(infra.Ident, string(runtime), profile)
		}
		items = append(items, resources.RegistryTarget{ID: id, Kind: resources.TargetKindInfra, Infra: infra.Ident, Runtime: runtime, Profile: profile, Provider: provider, Running: infra.Status == app.InfraStatusRunning})
	}
	return resources.NewTargetRegistry(items), nil
}

func (s *service) findInfra(ident string) (app.InfraService, bool) {
	for _, infra := range s.appRegistry.GetInfraServices() {
		if infra.Ident == ident {
			return infra, true
		}
	}
	return app.InfraService{}, false
}

func (s *service) isRunTargetActive(appIdent, targetID string) bool {
	s.tmuxMu.Lock()
	state, ok := s.tmuxRuns[appIdent]
	s.tmuxMu.Unlock()
	return ok && state.TargetID == targetID
}
