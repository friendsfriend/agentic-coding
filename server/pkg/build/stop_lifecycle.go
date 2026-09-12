package build

import (
	"fmt"
	"strings"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/status"
)

func (s *service) StopAppWithStatus(a *app.App, targetID string) {
	callback := s.statusMgr.StartOperation(a.Ident, status.OpStop)
	logPath := ""
	if targetID != "" {
		target, ok, err := s.selectActionTarget(a, resources.AppActionRun, targetID, "")
		if err != nil {
			callback("Error: " + err.Error())
			return
		}
		if !ok {
			callback("Error: unknown run target")
			return
		}
		if s.stopRunTarget(a, target, logPath, callback) {
			s.finishStop(a, callback)
		}
		return
	}
	if target, ok, err := s.stopTargetFromRunInfo(a); err != nil {
		callback("Error: " + err.Error())
		return
	} else if ok {
		if s.stopRunTarget(a, target, logPath, callback) {
			s.finishStop(a, callback)
		}
		return
	}
	stopped := false
	if s.IsShellTmuxRunActive(a.Ident) {
		if err := s.StopShellTmuxRun(a.Ident); err != nil {
			callback("Error: " + err.Error())
			return
		}
		stopped = true
	}
	targets, err := s.resourceMgr.DiscoverActionTargets(a.Ident, a.LocalDirectoryPath, resources.AppActionRun)
	if err == nil {
		for _, target := range targets {
			if target.Runtime == resources.ActionRuntimeKubernetes && target.Kubernetes != nil && !strings.HasPrefix(s.kubernetesTargetStatus(target.Kubernetes), "stopped") {
				if s.stopRunTarget(a, target, logPath, callback) {
					stopped = true
				}
			}
		}
	}
	if !stopped {
		composeFilePath := ""
		profile := ""
		if info, ok := s.RunTargetInfo(a.Ident); ok {
			profile = info.Profile
		}
		if resolved, err := s.resourceMgr.ResolveComposeFile(a.Ident, a.LocalDirectoryPath, profile); err == nil {
			composeFilePath = strings.TrimSpace(resolved)
		}
		if runErr, _ := s.runActionCommand(a.Ident, docker.ComposeCommand(), s.composeDownArgs(composeFilePath), []string{}, a.LocalDirectoryPath, logPath); runErr != nil {
			callback("Error: " + runErr.Error())
			return
		}
	}
	s.finishStop(a, callback)
}

func (s *service) finishStop(a *app.App, callback func(string)) {
	s.ClearRunTargetInfo(a.Ident)
	callback("stop successful")
	if s.OnComplete != nil {
		s.OnComplete(a.Ident)
	}
}

func (s *service) stopTargetFromRunInfo(a *app.App) (resources.ActionTarget, bool, error) {
	info, ok := s.RunTargetInfo(a.Ident)
	if !ok {
		return resources.ActionTarget{}, false, nil
	}
	if strings.TrimSpace(info.TargetID) != "" {
		if target, ok, err := s.selectActionTarget(a, resources.AppActionRun, info.TargetID, ""); err != nil {
			return resources.ActionTarget{}, false, err
		} else if ok {
			return target, true, nil
		}
	}
	return s.stopTargetFromStoredInfo(a, *info)
}

func (s *service) stopTargetFromStoredInfo(a *app.App, info RunTargetInfo) (resources.ActionTarget, bool, error) {
	runtime := resources.ActionRuntime(strings.TrimSpace(info.Runtime))
	if runtime == "" {
		return resources.ActionTarget{}, false, nil
	}
	target := resources.ActionTarget{ID: info.TargetID, Action: resources.AppActionRun, Runtime: runtime, Label: info.Label, Profile: info.Profile, LaunchMode: resources.LaunchMode(info.LaunchMode), SourcePath: strings.TrimSpace(info.SourcePath)}
	if runtime != resources.ActionRuntimeDocker {
		return target, true, nil
	}
	if target.SourcePath != "" {
		return target, true, nil
	}
	composeFilePath, err := s.resourceMgr.ResolveComposeFile(a.Ident, a.LocalDirectoryPath, info.Profile)
	if err != nil || strings.TrimSpace(composeFilePath) == "" {
		return resources.ActionTarget{}, false, nil
	}
	target.SourcePath = strings.TrimSpace(composeFilePath)
	return target, true, nil
}

func (s *service) composeDownArgs(composeFilePath string) []string {
	composeArgs := []string{"-p", "devenv"}
	if envFilePath, ok := s.resourceMgr.EnvFilePath(); ok {
		composeArgs = append(composeArgs, "--env-file", envFilePath)
	}
	if strings.TrimSpace(composeFilePath) != "" {
		composeArgs = append(composeArgs, "-f", strings.TrimSpace(composeFilePath))
	}
	return append(composeArgs, "down", "--remove-orphans")
}

func (s *service) stopRunTarget(a *app.App, target resources.ActionTarget, logPath string, callback func(string)) bool {
	switch target.Runtime {
	case resources.ActionRuntimeKubernetes:
		if target.Kubernetes == nil {
			callback("Error: missing Kubernetes metadata")
			return false
		}
		s.stopKubernetesPortForwards(a.Ident)
		runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
		cmd := runner.HelmCommandFor("uninstall", target.Kubernetes.Release, "--namespace", target.Kubernetes.Namespace, "--ignore-not-found")
		if err, _ := s.runActionCommand(a.Ident, cmd.Name, cmd.Args, cmd.Env, a.LocalDirectoryPath, logPath); err != nil {
			callback("Error: " + err.Error())
			return false
		}
	case resources.ActionRuntimeShell, resources.ActionRuntimePowerShell, resources.ActionRuntimeSystemShell:
		if err := s.StopShellTmuxRun(a.Ident); err != nil {
			callback("Error: " + err.Error())
			return false
		}
	case resources.ActionRuntimeDocker:
		if err, _ := s.runActionCommand(a.Ident, docker.ComposeCommand(), s.composeDownArgs(target.SourcePath), []string{}, a.LocalDirectoryPath, logPath); err != nil {
			callback("Error: " + err.Error())
			return false
		}
	default:
		callback(fmt.Sprintf("Error: unsupported runtime %s", target.Runtime))
		return false
	}
	return true
}
