package server

import (
	"context"
	"log"
	"time"

	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
)

const kubernetesClusterPollInterval = 15 * time.Second

func (s *Server) startKubernetesClusterPoller() {
	ticker := time.NewTicker(kubernetesClusterPollInterval)
	defer ticker.Stop()

	log.Printf("[Kubernetes cluster poller] Starting (%s interval)", kubernetesClusterPollInterval)

	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	svc := k8s.NewClusterService(runner)

	for range ticker.C {
		status := svc.Status(context.Background())
		s.BroadcastEvent(Event{
			Type:       "kubernetes.cluster.refreshed",
			Properties: status,
			Timestamp:  time.Now(),
		})
	}
}
