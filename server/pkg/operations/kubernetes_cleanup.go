package operations

func (s *service) ClearKubernetesInfrastructureState() {
	// Kubernetes infrastructure status is discovered live from the cluster.
	// After cluster delete, server broadcasts refresh and status probes report stopped.
}
