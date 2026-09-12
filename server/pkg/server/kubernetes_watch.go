package server

import (
	"bufio"
	"context"
	"log"
	"os/exec"
	"time"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type kubernetesWatchTarget struct {
	appIdent  string
	namespace string
	release   string
}

func (s *Server) startKubernetesStatusWatchers() {
	targets := s.discoverKubernetesWatchTargets()
	if len(targets) == 0 {
		return
	}
	if _, err := exec.LookPath("kubectl"); err != nil {
		log.Printf("[Kubernetes watcher] kubectl not found; skipping pod watches")
		return
	}
	for _, target := range targets {
		t := target
		go s.watchKubernetesPods(t)
		go func() {
			// Initial one-shot broadcast after startup so restored k8s state appears without waiting for pod changes.
			time.Sleep(500 * time.Millisecond)
			s.broadcastAppStatus(t.appIdent)
		}()
	}
	log.Printf("[Kubernetes watcher] started %d pod watch(es)", len(targets))
}

func (s *Server) discoverKubernetesWatchTargets() []kubernetesWatchTarget {
	seen := map[string]bool{}
	var targets []kubernetesWatchTarget
	for _, appCfg := range s.apps {
		a := appCfg
		actionTargets, err := s.services.ResourcesManager().DiscoverActionTargets(a.Ident, a.LocalDirectoryPath, resources.AppActionRun)
		if err != nil {
			log.Printf("[Kubernetes watcher] discover targets for %s failed: %v", a.Ident, err)
			continue
		}
		for _, target := range actionTargets {
			if target.Runtime != resources.ActionRuntimeKubernetes || target.Kubernetes == nil {
				continue
			}
			key := a.Ident + ":" + target.Kubernetes.Namespace + ":" + target.Kubernetes.Release
			if seen[key] {
				continue
			}
			seen[key] = true
			targets = append(targets, kubernetesWatchTarget{appIdent: a.Ident, namespace: target.Kubernetes.Namespace, release: target.Kubernetes.Release})
		}
	}
	return targets
}

func (s *Server) watchKubernetesPods(target kubernetesWatchTarget) {
	for {
		ctx := context.Background()
		selector := "app.kubernetes.io/instance=" + target.release
		cmd := exec.CommandContext(ctx, "kubectl", "--context", "kind-devenv", "get", "pods", "--namespace", target.namespace, "-l", selector, "--watch-only", "--no-headers")
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("[Kubernetes watcher] stdout pipe failed for %s: %v", target.appIdent, err)
			time.Sleep(10 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("[Kubernetes watcher] start failed for %s: %v", target.appIdent, err)
			time.Sleep(10 * time.Second)
			continue
		}
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			s.broadcastAppStatus(target.appIdent)
		}
		if err := scanner.Err(); err != nil {
			log.Printf("[Kubernetes watcher] scan failed for %s: %v", target.appIdent, err)
		}
		if err := cmd.Wait(); err != nil {
			log.Printf("[Kubernetes watcher] watch exited for %s: %v", target.appIdent, err)
		}
		time.Sleep(5 * time.Second)
	}
}
