package server

import (
	"net/http"

	"github.com/friendsfriend/devenv/pkg/app"
)

// catalogProjects projects the server's published app snapshot. The snapshot
// is an immutable copy swapped atomically on every successful reload, so a
// catalog read never races a reload reassigning the live s.apps slice and a
// failed configuration reload keeps serving the last good catalog.
func (s *Server) catalogProjects() ([]app.Project, error) {
	if snapshot := s.appsSnapshot.Load(); snapshot != nil {
		return app.BuildProjectCatalog(*snapshot)
	}
	return app.BuildProjectCatalog(s.apps)
}

// handleGetProjects returns the configured app/library catalog. Discovery
// errors (for example duplicate configured identifiers) are surfaced as an
// explicit failure instead of an empty success, so consumers never fall back
// to scanning elsewhere.
func (s *Server) handleGetProjects(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	projects, err := s.catalogProjects()
	if err != nil {
		respondErrorMessage(w, err.Error(), http.StatusConflict)
		return
	}

	respondJSON(w, app.NewProjectCatalog(projects), http.StatusOK)
}
