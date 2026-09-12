package server

import (
	"log"
	"net/http"

	"github.com/friendsfriend/devenv/pkg/docker"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
)

func (s *Server) kubernetesClusterService() k8s.ClusterService {
	runner := k8s.NewRunner(docker.Runtime{Name: docker.RuntimeName(), Command: docker.RuntimeCommand()})
	return k8s.NewClusterService(runner)
}

func (s *Server) handleKubernetesClusterStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	respondJSON(w, s.kubernetesClusterService().Status(r.Context()), http.StatusOK)
}

func (s *Server) handleKubernetesClusterCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	log.Printf("[INFO] Kubernetes cluster create requested")
	if err := s.runKubernetesClusterAction(r.Context(), "Create Kubernetes cluster", "create", func(service k8s.ClusterService) error { return service.Create(r.Context()) }); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	respondSuccess(w, s.kubernetesClusterService().Status(r.Context()), "Kubernetes cluster ready")
}

func (s *Server) handleKubernetesClusterDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		respondMethodNotAllowed(w)
		return
	}
	log.Printf("[INFO] Kubernetes cluster delete requested")
	if err := s.runKubernetesClusterAction(r.Context(), "Delete Kubernetes cluster", "delete", func(service k8s.ClusterService) error { return service.Delete(r.Context()) }); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.postKubernetesClusterDeleteCleanup()
	respondSuccess(w, s.kubernetesClusterService().Status(r.Context()), "Kubernetes cluster deleted")
}

func (s *Server) handleKubernetesClusterRecreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	log.Printf("[INFO] Kubernetes cluster recreate requested")
	if err := s.runKubernetesClusterAction(r.Context(), "Recreate Kubernetes cluster", "recreate", func(service k8s.ClusterService) error { return service.Recreate(r.Context()) }); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	respondSuccess(w, s.kubernetesClusterService().Status(r.Context()), "Kubernetes cluster recreated")
}

func (s *Server) handleKubernetesClusterExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	log.Printf("[INFO] Kubernetes kubeconfig export requested")
	if err := s.runKubernetesClusterAction(r.Context(), "Export Kubernetes kubeconfig", "export", func(service k8s.ClusterService) error { return service.ExportKubeconfig(r.Context()) }); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	respondSuccess(w, nil, "Kubernetes kubeconfig exported")
}

func (s *Server) handleKubernetesClusterRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	respondJSON(w, s.kubernetesClusterService().Status(r.Context()), http.StatusOK)
}

func (s *Server) handleKubernetesLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}
	appObj := s.findAppByIdent(appIdent)
	var logs string
	var err error
	if appObj != nil {
		logs, err = s.services.BuildService().KubernetesRunLogs(appIdent, appObj.LocalDirectoryPath)
	} else if infra := s.findInfraServiceByIdent(appIdent); infra != nil && infra.Type == "kubernetes" {
		logs, err = s.services.OperationsService().KubernetesInfrastructureLogs(*infra)
	} else {
		respondNotFound(w, "Kubernetes app or infrastructure not found")
		return
	}
	if err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(logs))
}
