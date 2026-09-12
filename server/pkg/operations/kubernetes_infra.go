package operations

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/status"
)

func (s *service) StartKubernetesInfrastructureServiceWithStatus(infra app.InfraService) error {
	logPath := ""
	return s.startKubernetesInfrastructureService(infra, logPath)
}

func (s *service) StartKubernetesInfrastructureServiceWithLog(infra app.InfraService, logPath string) error {
	return s.startKubernetesInfrastructureService(infra, logPath)
}

func (s *service) startKubernetesInfrastructureService(infra app.InfraService, logPath string) error {
	callback := s.statusMgr.StartOperation(infra.Ident, status.OpStart)
	callback("starting Kubernetes infrastructure...")
	if infra.Kubernetes == nil {
		callback("Error: missing Kubernetes infrastructure config")
		return nil
	}
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	if err := runner.Preflight(); err != nil {
		callback("Error: " + err.Error())
		return err
	}
	if err := s.ensureKubernetesInfraCluster(infra.Ident, runner, logPath, callback); err != nil {
		return err
	}
	statusCmd := runner.HelmCommandFor("status", infra.Kubernetes.Release, "--namespace", infra.Kubernetes.Namespace)
	statusErr, statusOut := s.executor.RunCommandSilentForAction(infra.Ident, statusCmd.Name, statusCmd.Args, statusCmd.Env, "")
	appendCommandLog(logPath, statusCmd.Name, statusCmd.Args, statusCmd.Env, "", statusOut, statusErr)
	if statusErr == nil {
		if strings.HasPrefix(s.KubernetesInfrastructureStatus(infra), app.InfraStatusRunning) {
			callback("start successful (already running)")
			return nil
		}
		callback("resetting stale Kubernetes infrastructure release...")
		uninstall := runner.HelmCommandFor("uninstall", infra.Kubernetes.Release, "--namespace", infra.Kubernetes.Namespace, "--ignore-not-found")
		if err, _ := s.executor.RunCommandWithLoggingToFile(infra.Ident, uninstall.Name, uninstall.Args, uninstall.Env, "", logPath); err != nil {
			callback("Error: " + err.Error())
			return err
		}
	}
	args := []string{"install", infra.Kubernetes.Release, infra.Kubernetes.ChartPath, "--namespace", infra.Kubernetes.Namespace, "--create-namespace"}
	for _, values := range infra.Kubernetes.Values {
		args = append(args, "-f", values)
	}
	if infra.Kubernetes.Wait {
		timeout := infra.Kubernetes.Timeout
		if timeout == "" {
			timeout = "5m"
		}
		args = append(args, "--wait", "--timeout", timeout)
	}
	cmd := runner.HelmCommandFor(args...)
	if err, _ := s.executor.RunCommandWithLoggingToFile(infra.Ident, cmd.Name, cmd.Args, cmd.Env, "", logPath); err != nil {
		callback("Error: " + err.Error())
		return err
	}
	callback("start successful")
	if s.OnComplete != nil {
		s.OnComplete(infra.Ident)
	}
	return nil
}

func (s *service) StopKubernetesInfrastructureServiceWithStatus(infra app.InfraService) error {
	callback := s.statusMgr.StartOperation(infra.Ident, status.OpStop)
	callback("stopping Kubernetes infrastructure...")
	logPath := ""
	if infra.Kubernetes == nil {
		callback("Error: missing Kubernetes infrastructure config")
		return nil
	}
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	cmd := runner.HelmCommandFor("uninstall", infra.Kubernetes.Release, "--namespace", infra.Kubernetes.Namespace, "--ignore-not-found")
	if err, _ := s.executor.RunCommandWithLoggingToFile(infra.Ident, cmd.Name, cmd.Args, cmd.Env, "", logPath); err != nil {
		callback("Error: " + err.Error())
		return err
	}
	callback("stop successful")
	if s.OnComplete != nil {
		s.OnComplete(infra.Ident)
	}
	return nil
}

func appendCommandLog(logPath, command string, args []string, envVars []string, workingDir, output string, err error) {
	if logPath == "" {
		return
	}
	file, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if openErr != nil {
		return
	}
	defer file.Close()
	timestamp := time.Now().Format("2006-01-02 15:04:05")
	_, _ = fmt.Fprintf(file, "[%s] Command: %s\n", timestamp, quoteCommand(command, args))
	if workingDir != "" {
		_, _ = fmt.Fprintf(file, "[%s] Working directory: %s\n", timestamp, workingDir)
	}
	if len(envVars) > 0 {
		_, _ = fmt.Fprintf(file, "[%s] Environment overrides: %s\n", timestamp, strings.Join(envVars, " "))
	}
	_, _ = fmt.Fprintf(file, "[%s] Output:\n%s", timestamp, output)
	if output != "" && !strings.HasSuffix(output, "\n") {
		_, _ = fmt.Fprintln(file)
	}
	if err != nil {
		_, _ = fmt.Fprintf(file, "[%s] Exit: ERROR (%s)\n", timestamp, err.Error())
	} else {
		_, _ = fmt.Fprintf(file, "[%s] Exit: SUCCESS\n", timestamp)
	}
	_, _ = fmt.Fprintf(file, "[%s] ---\n\n", timestamp)
}

func quoteCommand(command string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, strconv.Quote(command))
	for _, arg := range args {
		parts = append(parts, strconv.Quote(arg))
	}
	return strings.Join(parts, " ")
}

func (s *service) ensureKubernetesInfraCluster(appIdent string, runner k8s.Runner, logPath string, callback func(string)) error {
	callback("checking kind cluster...")
	get := runner.KindGetClustersCommand()
	getErr, getOut := s.executor.RunCommandSilentForAction(appIdent, get.Name, get.Args, get.Env, "")
	appendCommandLog(logPath, get.Name, get.Args, get.Env, "", getOut, getErr)
	if getErr == nil {
		for _, line := range strings.Split(getOut, "\n") {
			if strings.TrimSpace(line) == k8s.DefaultClusterName {
				return s.exportKubernetesInfraKubeconfig(appIdent, runner, logPath)
			}
		}
	}
	callback("creating kind cluster...")
	create := runner.KindCreateClusterCommand()
	createErr, createOut := s.executor.RunCommandWithLoggingToFile(appIdent, create.Name, create.Args, create.Env, "", logPath)
	if createErr != nil {
		if strings.Contains(createOut, "already exist") || strings.Contains(createOut, "already exists") {
			return s.exportKubernetesInfraKubeconfig(appIdent, runner, logPath)
		}
		callback("Error: " + createErr.Error())
		return createErr
	}
	return s.exportKubernetesInfraKubeconfig(appIdent, runner, logPath)
}

func (s *service) exportKubernetesInfraKubeconfig(appIdent string, runner k8s.Runner, logPath string) error {
	cmd := runner.KindExportKubeconfigCommand()
	err, output := s.executor.RunCommandSilentForAction(appIdent, cmd.Name, cmd.Args, cmd.Env, "")
	appendCommandLog(logPath, cmd.Name, cmd.Args, cmd.Env, "", output, err)
	return err
}

func (s *service) KubernetesInfrastructureStatus(infra app.InfraService) string {
	if infra.Kubernetes == nil {
		return app.InfraStatusStopped + " (0 pods)"
	}
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	selector := "app.kubernetes.io/instance=" + infra.Kubernetes.Release
	cmd := runner.KubectlCommandFor("get", "pods", "--namespace", infra.Kubernetes.Namespace, "-l", selector, "--no-headers")
	err, output := s.executor.RunCommandSilent(cmd.Name, cmd.Args, cmd.Env, "")
	if err != nil || strings.TrimSpace(output) == "" {
		return app.InfraStatusStopped + " (0 pods)"
	}
	running, total, failed := 0, 0, 0
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
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
		return app.InfraStatusStopped + " (0 pods)"
	}
	if failed > 0 {
		return fmt.Sprintf("%s (%d/%d pods)", app.InfraStatusFailed, running, total)
	}
	if running == total {
		return fmt.Sprintf("%s (%d/%d pods)", app.InfraStatusRunning, running, total)
	}
	return fmt.Sprintf("starting (%d/%d pods)", running, total)
}

func (s *service) KubernetesInfrastructureLogs(infra app.InfraService) (string, error) {
	if infra.Kubernetes == nil {
		return "", fmt.Errorf("infrastructure %s has no Kubernetes config", infra.Ident)
	}
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	selector := "app.kubernetes.io/instance=" + infra.Kubernetes.Release
	list := runner.KubectlCommandFor("get", "pods", "--namespace", infra.Kubernetes.Namespace, "-l", selector, "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}")
	err, output := s.executor.RunCommandSilent(list.Name, list.Args, list.Env, "")
	if err != nil {
		return "", err
	}
	pods := strings.Fields(output)
	if len(pods) == 0 {
		return fmt.Sprintf("No pods found for release %s in namespace %s", infra.Kubernetes.Release, infra.Kubernetes.Namespace), nil
	}
	var combined strings.Builder
	for _, pod := range pods {
		cmd := runner.KubectlCommandFor("logs", "--namespace", infra.Kubernetes.Namespace, pod, "--all-containers", "--tail", "500")
		logErr, podOutput := s.executor.RunCommandSilent(cmd.Name, cmd.Args, cmd.Env, "")
		if logErr != nil {
			podOutput = "Error fetching logs: " + logErr.Error()
		}
		for _, line := range strings.Split(strings.TrimRight(podOutput, "\n"), "\n") {
			if line == "" {
				continue
			}
			combined.WriteString("[")
			combined.WriteString(pod)
			combined.WriteString("] ")
			combined.WriteString(line)
			combined.WriteString("\n")
		}
	}
	return combined.String(), nil
}
