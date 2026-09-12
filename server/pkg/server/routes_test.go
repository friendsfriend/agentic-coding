package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actionregistry"
)

func TestRoutesHaveUniquePaths(t *testing.T) {
	s := NewServer(0)
	seen := map[string]routeSpec{}
	for _, route := range s.routes() {
		if route.Domain == "" {
			t.Fatalf("route %s missing domain", route.Path)
		}
		if route.Path == "" {
			t.Fatalf("route in domain %s missing path", route.Domain)
		}
		if route.Handler == nil {
			t.Fatalf("route %s has nil handler", route.Path)
		}
		if previous, ok := seen[route.Path]; ok {
			t.Fatalf("duplicate route path %s in domains %s and %s", route.Path, previous.Domain, route.Domain)
		}
		seen[route.Path] = route
	}

	for _, path := range []string{"/api/health", "/api/apps", "/api/gitlab/merge-requests", "/api/github/pull-requests", "/api/action-registry/status"} {
		if _, ok := seen[path]; !ok {
			t.Fatalf("expected route %s", path)
		}
	}

	// Verify the registry status endpoint works end-to-end
	registry := actionregistry.New()
	statusSrv := &Server{actionDefinitions: registry}
	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/action-registry/status", nil)
	statusSrv.handleActionRegistryStatus(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("registry status: %d %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "\"version\":0") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}
