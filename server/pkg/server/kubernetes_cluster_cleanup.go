package server

import (
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
)

func (s *Server) postKubernetesClusterDeleteCleanup() {
	s.services.BuildService().ClearKubernetesRuntimeState()
	s.services.OperationsService().ClearKubernetesInfrastructureState()
	for i := range s.apps {
		s.broadcastAppStatus(s.apps[i].Ident)
	}
	for i := range s.infraServices {
		if s.infraServices[i].Type == app.InfraServiceTypeKubernetes {
			s.broadcastAppStatus(s.infraServices[i].Ident)
		}
	}
	s.BroadcastEvent(Event{Type: "kubernetes.cluster.deleted", Properties: map[string]interface{}{}, Timestamp: time.Now()})
}
