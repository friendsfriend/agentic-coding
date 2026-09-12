package build

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func kubernetesClusterStepID(appIdent, phase string) string {
	return "kubernetes:cluster:" + appIdent + ":" + phase
}

func (s *service) runKubernetesTarget(a *app.App, target resources.ActionTarget, logPath string, statusCb func(string)) {
	if target.Kubernetes == nil {
		statusCb("Error: missing Kubernetes target metadata")
		return
	}
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	statusCb("checking Kubernetes tools...")
	if err := runner.Preflight(); err != nil {
		statusCb("Error: " + err.Error())
		return
	}
	if !s.ensureKubernetesCluster(a, runner, logPath, statusCb) {
		return
	}
	if !s.applyKubernetesSecrets(a, target, runner, logPath, statusCb) {
		return
	}
	statusCb("uninstalling existing Helm release...")
	uninstall := runner.HelmCommandFor("uninstall", target.Kubernetes.Release, "--namespace", target.Kubernetes.Namespace, "--ignore-not-found")
	if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, uninstall.Name, uninstall.Args, uninstall.Env, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: " + runErr.Error())
		return
	}
	args := []string{"install", target.Kubernetes.Release, target.Kubernetes.ChartPath, "--namespace", target.Kubernetes.Namespace, "--create-namespace"}
	for _, values := range target.Kubernetes.ValuesFiles {
		args = append(args, "-f", values)
	}
	if target.Kubernetes.Image != nil {
		cleanupDockerfile := s.prepareKubernetesDockerfile(a, target, statusCb)
		if cleanupDockerfile != nil {
			defer cleanupDockerfile()
		}
		if plan, ok := k8s.ResolveImageBuild(a.Ident, a.LocalDirectoryPath, target.Kubernetes.Image, docker.RuntimeCommand()); ok {
			statusCb("building Kubernetes image...")
			if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, plan.Command.Name, plan.Command.Args, plan.Command.Env, a.LocalDirectoryPath, logPath); runErr != nil {
				statusCb("Error: " + runErr.Error())
				return
			}
			statusCb("loading image into kind...")
			if !s.loadKubernetesImage(a, runner, plan.Image, logPath, statusCb) {
				return
			}
			args = append(args, k8s.HelmImageOverrides(*target.Kubernetes.Image, plan)...)
		} else if plan, ok := k8s.ResolveImageReference(a.Ident, target.Kubernetes.Image, docker.RuntimeCommand()); ok {
			statusCb("loading existing image into kind...")
			if !s.loadKubernetesImage(a, runner, plan.Image, logPath, statusCb) {
				return
			}
			args = append(args, k8s.HelmImageOverrides(*target.Kubernetes.Image, plan)...)
		}
	}
	args = append(args, kubernetesWaitArgs(target.Kubernetes.Wait)...)
	statusCb("installing Helm release...")
	install := runner.HelmCommandFor(args...)
	if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, install.Name, install.Args, install.Env, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: Helm install failed: " + runErr.Error())
		return
	}
	s.startKubernetesPortForwards(a.Ident, target, runner, statusCb)
	s.setLastKubernetesTarget(a.Ident, target.Kubernetes)
	s.SetLastRunRuntime(a.Ident, resources.ActionRuntimeKubernetes)
	statusCb("run successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}
}

func (s *service) StopKubernetesRun(a app.App, target resources.ActionTarget) error {
	if target.Kubernetes == nil {
		return fmt.Errorf("missing Kubernetes target metadata")
	}
	s.stopKubernetesPortForwards(a.Ident)
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	cmd := runner.HelmCommandFor("uninstall", target.Kubernetes.Release, "--namespace", target.Kubernetes.Namespace, "--ignore-not-found")
	if err, _ := s.executor.RunCommandWithLogging(a.Ident, cmd.Name, cmd.Args, cmd.Env, a.LocalDirectoryPath); err != nil {
		return err
	}
	return nil
}

func (s *service) ensureKubernetesCluster(a *app.App, runner k8s.Runner, logPath string, statusCb func(string)) bool {
	checkID := kubernetesClusterStepID(a.Ident, "check")
	createID := kubernetesClusterStepID(a.Ident, "create")
	exportID := kubernetesClusterStepID(a.Ident, "export")
	s.SetActionStep(checkID)
	s.emitActionStep(checkID, string(actionrun.StepKindKubernetesClusterCheck), "started", "")
	statusCb("checking kind cluster...")
	get := runner.KindGetClustersCommand()
	err, output := s.runKubernetesActionCommand(a, get, logPath)
	if err == nil {
		for _, line := range strings.Split(output, "\n") {
			if strings.TrimSpace(line) == k8s.DefaultClusterName {
				statusCb("using existing kind cluster")
				s.emitActionStep(checkID, "", "completed", "")
				if !s.refreshKindKubeconfig(a, runner, logPath, exportID) {
					return false
				}
				return true
			}
		}
	}
	s.emitActionStep(checkID, "", "completed", "cluster missing")
	s.SetActionStep(createID)
	s.emitActionStep(createID, string(actionrun.StepKindKubernetesClusterCreate), "started", "")
	statusCb("creating kind cluster...")
	create := runner.KindCreateClusterCommand()
	if runErr, output := s.runKubernetesActionCommand(a, create, logPath); runErr != nil {
		if strings.Contains(output, "already exist") || strings.Contains(output, "already exists") {
			statusCb("using existing kind cluster")
		} else {
			s.emitActionStep(createID, "", "failed", runErr.Error())
			statusCb("Error: " + runErr.Error())
			return false
		}
	}
	s.emitActionStep(createID, "", "completed", "")
	if !s.refreshKindKubeconfig(a, runner, logPath, exportID) {
		return false
	}
	return true
}

func (s *service) runActionSilent(appIdent, command string, args, env []string, workingDir string) (error, string) {
	if runner, ok := s.executor.(actionSilentRunner); ok {
		return runner.RunCommandSilentForAction(appIdent, command, args, env, workingDir)
	}
	return s.executor.RunCommandSilent(command, args, env, workingDir)
}

func (s *service) runKubernetesActionCommand(a *app.App, cmd k8s.Command, logPath string) (error, string) {
	return s.executor.RunCommandWithLoggingToFile(a.Ident, cmd.Name, cmd.Args, cmd.Env, a.LocalDirectoryPath, logPath)
}

func (s *service) refreshKindKubeconfig(a *app.App, runner k8s.Runner, logPath, stepID string) bool {
	s.SetActionStep(stepID)
	s.emitActionStep(stepID, string(actionrun.StepKindKubernetesClusterExport), "started", "")
	cmd := runner.KindExportKubeconfigCommand()
	err, _ := s.runKubernetesActionCommand(a, cmd, logPath)
	if err != nil {
		s.emitActionStep(stepID, "", "failed", err.Error())
		return false
	}
	s.emitActionStep(stepID, "", "completed", "")
	return true
}

func (s *service) applyKubernetesSecrets(a *app.App, target resources.ActionTarget, runner k8s.Runner, logPath string, statusCb func(string)) bool {
	if target.Kubernetes == nil || len(target.Kubernetes.Secrets) == 0 {
		return true
	}
	env := map[string]string{}
	if envPath, ok := s.resourceMgr.EnvFilePath(); ok {
		loaded, err := resources.LoadEnvFile(envPath)
		if err != nil {
			statusCb("Error: " + err.Error())
			return false
		}
		env = loaded
	}
	secrets := make([]resources.KubernetesSecretConfig, 0, len(target.Kubernetes.Secrets))
	for _, secret := range target.Kubernetes.Secrets {
		secrets = append(secrets, resources.KubernetesSecretConfig{Name: secret.Name, Keys: secret.Keys})
	}
	plans, err := k8s.BuildSecretPlans(runner, target.Kubernetes.Namespace, secrets, env)
	if err != nil {
		statusCb("Error: " + err.Error())
		return false
	}
	for _, plan := range plans {
		statusCb(fmt.Sprintf("creating Kubernetes Secret %s with keys %s...", plan.Name, strings.Join(plan.Keys, ",")))
		deleteCmd := runner.KubectlCommandFor("delete", "secret", plan.Name, "--namespace", plan.Namespace, "--ignore-not-found")
		secretStepID := fmt.Sprintf("kubernetes:secret:%s:delete", plan.Name)
		s.SetActionStep(secretStepID)
		s.emitActionStep(secretStepID, actionrun.EncodeStepKind(actionrun.StepKindKubernetesSecretDelete, plan.Name), "started", "")
		deleteErr, deleteOut := s.runActionSilent(a.Ident, deleteCmd.Name, deleteCmd.Args, deleteCmd.Env, a.LocalDirectoryPath)
		s.logSilentCommand(logPath, deleteCmd.Name, deleteCmd.Args, deleteCmd.Env, a.LocalDirectoryPath, deleteOut, deleteErr)
		if deleteErr != nil {
			s.emitActionStep(secretStepID, "", "failed", deleteErr.Error())
			statusCb("Error: " + deleteErr.Error())
			return false
		}
		createCmd := plan.Command
		valueArgs, cleanupValues, valueErr := secretValueFiles(plan)
		if valueErr != nil {
			s.emitActionStep(secretStepID, "", "failed", valueErr.Error())
			statusCb("Error: " + valueErr.Error())
			return false
		}
		createCmd.Args = secretCreateArgs(plan, valueArgs)
		s.emitActionStep(secretStepID, "", "completed", "")
		secretStepID = fmt.Sprintf("kubernetes:secret:%s:create", plan.Name)
		s.SetActionStep(secretStepID)
		s.emitActionStep(secretStepID, actionrun.EncodeStepKind(actionrun.StepKindKubernetesSecretCreate, plan.Name), "started", "")
		var createErr error
		var createOut string
		displayArgs := redactSecretValueArgs(createCmd.Args)
		if actionRunner, ok := s.executor.(actionSilentRunner); ok {
			createErr, createOut = actionRunner.RunCommandSilentForActionDisplay(a.Ident, createCmd.Name, createCmd.Args, displayArgs, createCmd.Env, a.LocalDirectoryPath)
		} else {
			createErr, createOut = s.executor.RunCommandSilent(createCmd.Name, createCmd.Args, createCmd.Env, a.LocalDirectoryPath)
		}
		cleanupValues()
		s.logSilentCommand(logPath, createCmd.Name, displayArgs, createCmd.Env, a.LocalDirectoryPath, createOut, createErr)
		if createErr != nil {
			s.emitActionStep(secretStepID, "", "failed", createErr.Error())
			statusCb("Error: " + createErr.Error())
			return false
		}
		s.emitActionStep(secretStepID, "", "completed", "")
	}
	return true
}

// secretValueFiles materialises each secret value into its own 0600 file in a
// private temporary directory and returns the matching --from-file arguments.
// This keeps plaintext secrets off the kubectl argv, where other local
// processes could read them via ps/proc. The caller must invoke cleanup once
// kubectl has exited.
func secretValueFiles(plan k8s.SecretApplyPlan) ([]string, func(), error) {
	dir, err := os.MkdirTemp("", "devenv-secret-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	args := make([]string, 0, len(plan.Keys))
	for i, key := range plan.Keys {
		path := filepath.Join(dir, fmt.Sprintf("value-%d", i))
		if writeErr := os.WriteFile(path, []byte(plan.Values[key]), 0600); writeErr != nil {
			cleanup()
			return nil, nil, writeErr
		}
		args = append(args, "--from-file="+key+"="+path)
	}
	return args, cleanup, nil
}

func secretCreateArgs(plan k8s.SecretApplyPlan, valueArgs []string) []string {
	args := []string{"--context", k8s.DefaultContextName, "create", "secret", "generic", plan.Name, "--namespace", plan.Namespace}
	return append(args, valueArgs...)
}

// redactSecretValueArgs hides the temp-file path of each --from-file argument
// for display and logging.
func redactSecretValueArgs(args []string) []string {
	out := append([]string{}, args...)
	for i, arg := range out {
		if !strings.HasPrefix(arg, "--from-file=") {
			continue
		}
		if eq := strings.LastIndex(arg, "="); eq >= 0 {
			out[i] = arg[:eq] + "=<redacted>"
		}
	}
	return out
}

func kubernetesWaitArgs(wait resources.KubernetesWaitConfig) []string {
	if wait.Enabled != nil && !*wait.Enabled {
		return nil
	}
	timeout := wait.Timeout
	if timeout == "" {
		timeout = "5m"
	}
	return []string{"--wait", "--timeout", timeout}
}

func (s *service) startKubernetesPortForwards(appIdent string, target resources.ActionTarget, runner k8s.Runner, statusCb func(string)) {
	if target.Kubernetes == nil || len(target.Kubernetes.Ports) == 0 {
		return
	}
	s.stopKubernetesPortForwards(appIdent)
	for _, port := range target.Kubernetes.Ports {
		cmdSpec := k8s.PortForwardCommand(runner, target.Kubernetes.Namespace, port)
		stepID := fmt.Sprintf("kubernetes:port-forward:%s", port.Name)
		s.SetActionStep(stepID)
		s.emitActionStep(stepID, actionrun.EncodeStepKind(actionrun.StepKindKubernetesPortForward, port.Name), "started", "")
		s.actionMu.RLock()
		binding := s.actionBindings[appIdent]
		s.actionMu.RUnlock()
		if binding.command != nil {
			binding.command(stepID, cmdSpec.Name, cmdSpec.Args)
		}
		cmd := exec.Command(cmdSpec.Name, cmdSpec.Args...)
		cmd.Env = append(cmd.Env, cmdSpec.Env...)
		startErr := cmd.Start()
		if binding.done != nil {
			binding.done(stepID, startErr)
		}
		if startErr != nil {
			s.emitActionStep(stepID, "", "failed", startErr.Error())
			statusCb("Port-forward failed: " + startErr.Error())
			continue
		}
		s.portForwardMu.Lock()
		if s.portForwards == nil {
			s.portForwards = make(map[string][]*exec.Cmd)
		}
		s.portForwards[appIdent] = append(s.portForwards[appIdent], cmd)
		s.portForwardMu.Unlock()
		s.emitActionStep(stepID, "", "completed", "")
		statusCb(fmt.Sprintf("port-forward %s localhost:%d -> %s:%d", port.Name, port.LocalPort, port.Resource, port.RemotePort))
	}
}

func (s *service) stopKubernetesPortForwards(appIdent string) {
	s.portForwardMu.Lock()
	cmds := s.portForwards[appIdent]
	delete(s.portForwards, appIdent)
	s.portForwardMu.Unlock()
	for _, cmd := range cmds {
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	}
}

func (s *service) ClearKubernetesRuntimeState() {
	s.portForwardMu.Lock()
	all := s.portForwards
	s.portForwards = make(map[string][]*exec.Cmd)
	s.portForwardMu.Unlock()
	for _, cmds := range all {
		for _, cmd := range cmds {
			if cmd != nil && cmd.Process != nil {
				_ = cmd.Process.Kill()
				_, _ = cmd.Process.Wait()
			}
		}
	}
	s.lastRunMu.Lock()
	for appIdent, runtime := range s.lastRunRuntime {
		if runtime == resources.ActionRuntimeKubernetes {
			delete(s.lastRunRuntime, appIdent)
		}
	}
	s.lastKubernetes = make(map[string]*resources.KubernetesTargetMetadata)
	s.lastRunMu.Unlock()
}

func (s *service) logSilentCommand(_ string, command string, args []string, _ []string, _ string, output string, err error) {
	// RunCommandSilentForAction already publishes start/output/completion. The
	// legacy bridge below exists only for non-action-aware executors; emitting
	// both creates duplicate action steps for inspect/create/cp/rm commands.
	if _, ok := s.executor.(actionSilentRunner); ok {
		return
	}
	s.actionMu.RLock()
	binding := s.actionBindings[s.actionAppIdent]
	s.actionMu.RUnlock()
	if binding.command != nil {
		binding.command(binding.step, command, args)
	}
	if binding.output != nil && output != "" {
		binding.output(binding.step, "stdout", output)
	}
	if binding.done != nil {
		binding.done(binding.step, err)
	}
}

func shellQuoteForActionLog(command string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, strconv.Quote(command))
	for _, arg := range args {
		parts = append(parts, strconv.Quote(arg))
	}
	return strings.Join(parts, " ")
}

func (s *service) prepareKubernetesDockerfile(a *app.App, target resources.ActionTarget, statusCb func(string)) func() {
	if target.Kubernetes == nil || target.Kubernetes.Image == nil || target.Kubernetes.Image.Build == nil {
		return nil
	}
	dockerfile := target.Kubernetes.Image.Build.Dockerfile
	if dockerfile == "" || !filepath.IsAbs(dockerfile) || strings.HasPrefix(filepath.Clean(dockerfile), filepath.Clean(a.LocalDirectoryPath)+string(os.PathSeparator)) {
		return nil
	}
	localDockerfile := filepath.Join(a.LocalDirectoryPath, ".devenv-k8s.Dockerfile")
	if err := s.resourceMgr.CopyFile(dockerfile, localDockerfile); err != nil {
		statusCb("Error: " + err.Error())
		return nil
	}
	target.Kubernetes.Image.Build.Dockerfile = localDockerfile
	return func() {
		_ = os.Remove(localDockerfile)
	}
}

func (s *service) loadKubernetesImage(a *app.App, runner k8s.Runner, image, logPath string, statusCb func(string)) bool {
	if docker.RuntimeName() == "podman" {
		archive := filepath.Join(os.TempDir(), fmt.Sprintf("devenv-%s-%d.tar", strings.ReplaceAll(a.Ident, string(os.PathSeparator), "-"), time.Now().UnixNano()))
		defer os.Remove(archive)
		saveArgs := []string{"save", "-o", archive, image}
		if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, docker.RuntimeCommand(), saveArgs, []string{}, a.LocalDirectoryPath, logPath); runErr != nil {
			statusCb("Error: " + runErr.Error())
			return false
		}
		load := runner.KindLoadImageArchiveCommand(archive)
		if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, load.Name, load.Args, load.Env, a.LocalDirectoryPath, logPath); runErr != nil {
			statusCb("Error: " + runErr.Error())
			return false
		}
		return true
	}
	load := runner.KindLoadImageCommand(image)
	if runErr, _ := s.executor.RunCommandWithLoggingToFile(a.Ident, load.Name, load.Args, load.Env, a.LocalDirectoryPath, logPath); runErr != nil {
		statusCb("Error: " + runErr.Error())
		return false
	}
	return true
}
