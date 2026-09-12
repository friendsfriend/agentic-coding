package build

import (
	"fmt"
	"strings"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func (s *service) KubernetesRunLogs(appIdent, localDir string) (string, error) {
	target := s.kubernetesTargetForApp(appIdent, localDir)
	if target == nil {
		return "", fmt.Errorf("no Kubernetes run target found for %s", appIdent)
	}
	listArgs := []string{"--context", "kind-devenv", "get", "pods", "--namespace", target.Namespace, "-l", "app.kubernetes.io/instance=" + target.Release, "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}"}
	err, output := s.executor.RunCommandSilent("kubectl", listArgs, []string{}, "")
	if err != nil {
		return "", err
	}
	pods := strings.Fields(output)
	if len(pods) == 0 {
		return fmt.Sprintf("No pods found for release %s in namespace %s", target.Release, target.Namespace), nil
	}
	var combined strings.Builder
	for _, pod := range pods {
		args := []string{"--context", "kind-devenv", "logs", "--namespace", target.Namespace, pod, "--all-containers", "--tail", "500"}
		logErr, podOutput := s.executor.RunCommandSilent("kubectl", args, []string{}, "")
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

func (s *service) kubernetesTargetForApp(appIdent, localDir string) *resources.KubernetesTargetMetadata {
	s.lastRunMu.RLock()
	target := s.lastKubernetes[appIdent]
	s.lastRunMu.RUnlock()
	if target != nil {
		return target
	}
	targets, err := s.resourceMgr.DiscoverActionTargets(appIdent, localDir, resources.AppActionRun)
	if err != nil {
		return nil
	}
	for _, candidate := range targets {
		if candidate.Runtime != resources.ActionRuntimeKubernetes || candidate.Kubernetes == nil {
			continue
		}
		if !strings.HasPrefix(s.kubernetesTargetStatus(candidate.Kubernetes), "stopped") {
			s.setLastKubernetesTarget(appIdent, candidate.Kubernetes)
			return candidate.Kubernetes
		}
	}
	return nil
}
